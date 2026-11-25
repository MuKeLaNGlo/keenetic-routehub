"""Compare both real daemons on Linux ARM64 with no external network access."""

import ipaddress
import json
import os
from pathlib import Path
import stat
import statistics
import subprocess
import tempfile
import time
import urllib.request

LAB = Path("/lab")
URL = "http://127.0.0.1:19387"
SAMPLES = 750


def rules():
    domains = [
        {"name": f"Domain {n}", "domain": f"site-{n}.example.net", "target": "direct"}
        for n in range(4000)
    ]
    base = int(ipaddress.IPv4Address("100.64.0.0"))
    cidrs = [
        {"name": f"Network {n}", "cidr": f"{ipaddress.IPv4Address(base + n * 8)}/29", "target": "@block"}
        for n in range(1274)
    ]
    return domains + cidrs


def status(pid):
    lines = Path(f"/proc/{pid}/status").read_text().splitlines()
    wanted = {"VmRSS", "RssAnon", "RssFile", "RssShmem", "Threads"}
    return {key: int(value.split()[0]) for key, value in map(lambda line: line.split(":", 1), lines) if key in wanted}


def call(path, data=None):
    content = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(URL + path, data=content, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def child_of(pid):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if f"PPid:\t{pid}\n" in (entry / "status").read_text() and (entry / "comm").read_text().strip() in {"xray", "xray-active"}:
                return int(entry.name)
        except FileNotFoundError:
            pass
    raise RuntimeError("Xray child not found")


def filesystem_usage(tmp):
    allocated = 0
    logical = 0
    for path in Path(tmp).rglob("*"):
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            allocated += info.st_blocks * 512
            logical += info.st_size
    return allocated, logical


def run(implementation):
    default = f"routehub-{implementation}"
    executable = LAB / (os.environ.get("ROUTEHUB_BENCH_RUST", default) if implementation == "rust" else default)
    plan = {"panelPort": 19387, "socksPort": 19388, "profiles": [], "rules": rules()}
    with tempfile.TemporaryDirectory(prefix="routehub-compare-") as tmp:
        config = Path(tmp) / "config.json"
        config.write_text(json.dumps(plan))
        process = subprocess.Popen(
            [str(executable), "serve", "-config", str(config), "-xray", str(LAB / "xray"),
             "-helper-dir", tmp, "-dns-listen", ""],
            env={"PATH": "/usr/bin:/bin", "TMPDIR": tmp},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read())
                try:
                    if call("/api/status")["socks"] == "127.0.0.1:19388":
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                raise RuntimeError("Panel did not start")
            child = child_of(process.pid)
            time.sleep(1.0)
            before = status(process.pid)
            xray_before = status(child)
            allocated, logical = filesystem_usage(tmp)
            config_size = config.stat()
            queries = [
                ({"host": "site-3999.example.net"}, "direct"),
                ({"host": "100.64.39.200"}, "@block"),
                ({"host": "unknown.example.com"}, "direct"),
            ]
            durations = []
            for n in range(SAMPLES):
                query, expected = queries[n % len(queries)]
                start = time.perf_counter_ns()
                got = call("/api/evaluate", {**query, "network": "tcp", "port": 443})
                durations.append((time.perf_counter_ns() - start) / 1e6)
                assert got["target"] == expected, got
            return {
                "binaryBytes": executable.stat().st_size,
                "daemonIdle": before,
                "daemonAfterLoad": status(process.pid),
                "xrayIdle": xray_before,
                "xrayAfterLoad": status(child),
                "runtimeTmpfsAllocatedBytes": allocated - config_size.st_blocks * 512,
                "runtimeTmpfsLogicalBytes": logical - config_size.st_size,
                "p50Ms": statistics.median(durations),
                "p95Ms": sorted(durations)[int(len(durations) * 0.95)],
            }
        finally:
            process.terminate()
            process.communicate(timeout=8)


if __name__ == "__main__":
    print(json.dumps({"rules": 5274, "requestsPerDaemon": SAMPLES, "go": run("go"), "rust": run("rust")}, indent=2))
