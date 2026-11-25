"""Exercise Rust Zapret controls with real nfqws2 in an offline container."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

if sorted(os.listdir("/sys/class/net")) != ["lo"]:
    raise SystemExit("Requires an isolated network namespace with only loopback")

BASE = "http://127.0.0.1:19383"
KEY = "isolated-zapret-fixture-key-only"
QUEUE = 314


def request(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Content-Type": "application/json", "Origin": BASE, "X-RouteHub-Key": KEY,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError((path, error.code, error.read().decode())) from error


def read_queue():
    for line in Path("/proc/net/netfilter/nfnetlink_queue").read_text().splitlines():
        fields = line.split()
        if int(fields[0]) == QUEUE:
            return int(fields[1]), int(fields[7])
    raise AssertionError("nfqws2 queue is absent")


def marked_tcp(mark):
    with socket.socket() as listener, socket.socket() as sender:
        listener.settimeout(4)
        sender.settimeout(4)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 443))
        listener.listen()
        if mark:
            sender.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, mark)
        sender.connect(("127.0.0.1", 443))
        client, _ = listener.accept()
        with client:
            client.settimeout(4)
            sender.sendall(b"routehub-fixture")
            assert client.recv(128) == b"routehub-fixture"


def main():
    subprocess.run(["ip","link","set","lo","up"],check=True)
    with tempfile.TemporaryDirectory(prefix="routehub-zapret-") as name:
        directory = Path(name)
        config = directory / "config.json"
        config.write_text(json.dumps({
            "panelPort": 19383, "socksPort": 19384, "profiles": [], "rules": [], "zapret": True,
            "zapretServices": {"youtube": False, "discord": False},
        }))
        key = directory / "key"
        key.touch(mode=0o600)
        key.write_text(KEY)
        state = directory / "state"
        conf = directory / "zapret.conf"
        conf.write_text(f"ENABLED=1\nIPV6=0\nQUEUE={QUEUE}\nNFQWS=/zapret-fixture/nfqws2\n")
        conf.chmod(0o600)
        strategies = directory / "zapret-strategies"
        strategies.mkdir()
        for service in ["youtube", "discord"]:
            for version in [1, 2]:
                recipe = strategies / f"{service}-variant-{version}.args"
                recipe.touch(mode=0o600)
                recipe.write_text("--lua-init=function routehub_fixture(desync) return VERDICT_PASS end\n"
                                  "--filter-tcp=443\n--filter-l7=tls\n--payload=tls_client_hello\n--lua-desync=routehub_fixture\n")
        env = os.environ | {"ROUTEHUB_ZAPRET_ETC": str(directory), "ROUTEHUB_ZAPRET_RUN": str(state)}
        child = subprocess.Popen([
            "/lab/routehub-rust-final", "serve", "-config", str(config), "-xray", "/lab/xray",
            "-panel-key-file", str(key), "-helper-dir", "/helpers", "-dns-listen", "",
        ], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(120):
                if child.poll() is not None:
                    raise RuntimeError(child.stderr.read())
                try:
                    request("/api/status")
                    break
                except OSError:
                    time.sleep(0.05)
            else:
                raise RuntimeError("Panel did not start")
            before = request("/api/zapret/check", "POST", {"service":"youtube"})
            assert before["status"] == "disabled", before
            selected = request("/api/runtime/zapret","PUT",{"service":"youtube","enabled":True,"strategy":"variant-1"})
            assert selected["zapret"]["youtube"]["enabled"], selected
            assert selected["zapret"]["youtube"]["strategy"] == "variant-1"
            daemon, baseline = read_queue()
            marked_tcp(None)
            assert read_queue() == (daemon, baseline), "unmarked flow used NFQUEUE"
            marked_tcp(0x51000 | 0x100000)
            assert read_queue()[1] > baseline, "marked flow missed NFQUEUE"
            updated = request("/api/runtime/zapret","PUT",{"service":"youtube","enabled":True,"strategy":"variant-2"})
            assert updated["zapret"]["youtube"]["strategy"] == "variant-2"
            assert read_queue()[0] != daemon, "nfqws2 did not restart on strategy change"
            disabled = request("/api/runtime/zapret","PUT",{"service":"youtube","enabled":False})
            assert not disabled["zapret"]["youtube"]["enabled"]
            assert not Path("/proc/net/netfilter/nfnetlink_queue").read_text().strip()
            assert request("/api/zapret/check","POST",{"service":"youtube"})["status"] == "disabled"
        finally:
            if child.poll() is None:
                child.terminate()
            _, err = child.communicate(timeout=15)
            if child.returncode:
                print(err)
            subprocess.run(["/helpers/routehub-zapret","stop"],env=env,check=False,capture_output=True)
        print("PASS: Rust Zapret API, real NFQUEUE, marked flow, strategy restart and cleanup")


if __name__ == "__main__":
    main()
