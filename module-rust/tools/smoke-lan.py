"""Test the original Netfilter helpers and ARM64 RouteHub in an offline container.

The container must have its own network namespace, no external interface, and the
privileges needed to create two additional namespaces. No host runtime paths are
shared. The only mounts are the read-only fixture binary and helper sources.
"""

import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request

if sorted(os.listdir("/sys/class/net")) != ["lo"]:
    sys.exit("Requires an isolated network namespace with only loopback")

TYPE = sys.argv[1]
BASE = "http://192.168.44.1:19383"
KEY = "isolated-lan-fixture-key-only"
TARGET = "203.0.113.2"
ORIGIN_PORT = 19391


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def api(path, method="GET", input=None):
    data = None if input is None else json.dumps(input).encode()
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json", "Origin": BASE, "X-RouteHub-Key": KEY},
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def probe():
    return subprocess.run(
        ["ip", "netns", "exec", "client", "curl", "--noproxy", "*", "-fsS", "--max-time", "3", f"http://{TARGET}:{ORIGIN_PORT}/"],
        capture_output=True, text=True, timeout=5,
    )


def udp_probe():
    source = """
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
    sock.settimeout(3)
    sock.sendto(b'udp fixture', ('203.0.113.2', 19391))
    print(sock.recv(256).decode())
"""
    return subprocess.run(
        ["ip", "netns", "exec", "client", "python3", "-c", source],
        capture_output=True, text=True, timeout=5,
    )


def rules(mode):
    return ["iptables", "-t", "mangle" if mode == "tproxy" else "nat", "-nvL"]


def main():
    assert TYPE in {"tproxy", "redirect-tcp"}
    Path("/opt/var/run").mkdir(parents=True, exist_ok=True)
    run("ip", "link", "set", "lo", "up")
    for name, local_veth, remote_veth, local, remote in (
        ("client", "rh-lan", "eth-client", "192.168.44.1/24", "192.168.44.7/24"),
        ("origin", "rh-wan", "eth-origin", "203.0.113.1/24", "203.0.113.2/24"),
    ):
        run("ip", "netns", "add", name)
        run("ip", "link", "add", local_veth, "type", "veth", "peer", "name", remote_veth)
        run("ip", "link", "set", remote_veth, "netns", name)
        run("ip", "addr", "add", local, "dev", local_veth)
        run("ip", "link", "set", local_veth, "up")
        run("ip", "-n", name, "link", "set", "lo", "up")
        run("ip", "-n", name, "link", "set", remote_veth, "up")
        run("ip", "-n", name, "addr", "add", remote, "dev", remote_veth)
        run("ip", "-n", name, "route", "add", "default", "via", local.split("/")[0])

    with tempfile.TemporaryDirectory(prefix="routehub-lan-") as fixture:
        local_helpers = Path(fixture) / "helpers"
        local_helpers.mkdir()
        for helper in ["routehub-redirect-tcp","routehub-transparent"]:
            shutil.copyfile(Path("/helpers") / helper, local_helpers / helper)
            (local_helpers / helper).chmod(0o700)
        path = Path(fixture) / "config.json"
        key = Path(fixture) / "key"
        key.touch(mode=0o600)
        key.write_text(KEY)
        (Path(fixture) / "index.html").write_text("offline netfilter origin")
        path.write_text(json.dumps({
            "panelHost": "192.168.44.1", "panelNetwork": "192.168.44.0/24",
            "panelPort": 19383, "socksPort": 19384, "profiles": [], "rules": [],
            "transparent": {"interface": "rh-lan", "source": "192.168.44.0/24", "port": 19387, "mode": TYPE},
        }))
        origin = subprocess.Popen(["ip", "netns", "exec", "origin", "python3", "-c", f"""
import socket
with socket.create_server(("{TARGET}",{ORIGIN_PORT})) as server:
    while True:
        client, _ = server.accept()
        with client:
            request = client.recv(4096)
            if request:
                body = b"offline netfilter origin"
                client.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Length: " + str(len(body)).encode()
                               + b"\\r\\nConnection: close\\r\\n\\r\\n" + body)
"""])
        udp_origin = subprocess.Popen(["ip", "netns", "exec", "origin", "python3", "-c", f"""
import socket
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
    sock.bind(("{TARGET}",{ORIGIN_PORT}))
    while True:
        data, sender = sock.recvfrom(256)
        sock.sendto(b"origin: " + data, sender)
"""])
        for _ in range(50):
            baseline = subprocess.run(["curl","--noproxy","*","-fsS","--max-time","1",
                f"http://{TARGET}:{ORIGIN_PORT}/"],capture_output=True,text=True)
            if "offline netfilter origin" in baseline.stdout:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError(f"Isolated origin did not start: {baseline.stderr}")
        trace = Path(fixture) / "xray-debug.log"
        wrapper = Path(fixture) / "xray"
        wrapper.write_text(f'#!/bin/sh\nexec /lab/xray "$@" >> "{trace}" 2>&1\n')
        wrapper.chmod(0o700)
        process = subprocess.Popen([
            "/lab/" + os.environ.get("ROUTEHUB_LAN_BIN", "routehub-rust-final"), "serve", "-config", str(path),
            "-xray", str(wrapper), "-helper-dir", str(local_helpers),
            "-dns-listen", "", "-panel-key-file", str(key), "-allow-lan",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(220):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read())
                try:
                    state = api("/api/status")
                    assert state["lan"] and state["lanMode"] == TYPE
                    break
                except (urllib.error.URLError, ConnectionResetError):
                    time.sleep(0.05)
            else:
                raise RuntimeError("RouteHub never started")
            first=probe()
            assert "offline netfilter origin" in first.stdout, (
                first.stderr, trace.read_text(), run(*rules(TYPE)), run("iptables","-nvL"),
            )
            if TYPE == "tproxy":
                assert udp_probe().stdout.strip() == "origin: udp fixture"

            revision = api("/api/plan")["revision"]
            blocked = api("/api/plan", "PUT", {
                "revision": revision, "profiles": [],
                "rules": [{"name": "Block lab fixture", "cidr": TARGET + "/32", "target": "@block"}],
            })
            denied = probe()
            assert denied.returncode != 0, denied.stdout
            if TYPE == "tproxy":
                assert udp_probe().returncode != 0
            api("/api/panel/revisions/restore", "POST", {
                "revision": revision, "baseRevision": blocked["revision"],
            })
            assert "offline netfilter origin" in probe().stdout
            if TYPE == "tproxy":
                assert udp_probe().stdout.strip() == "origin: udp fixture"
        finally:
            origin.terminate()
            udp_origin.terminate()
            if process.poll() is None:
                process.terminate()
            _, err = process.communicate(timeout=15)
            origin.wait(timeout=5)
            udp_origin.wait(timeout=5)
            if process.returncode:
                print(err, file=sys.stderr)
        assert "RH_TCP_REDIRECT" not in run(*rules(TYPE)) and "RH_TPROXY" not in run(*rules(TYPE))
        assert not list(Path("/opt/var/run").glob("routehub-*.active"))
        print("PASS: " + TYPE + " original helpers, live client flows, reload, restore and shutdown cleanup")


if __name__ == "__main__":
    main()
