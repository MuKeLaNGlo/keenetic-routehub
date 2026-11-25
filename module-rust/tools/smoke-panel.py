"""Exercise the Rust daemon, real Xray and an isolated local origin."""

import argparse
import http.server
import io
import json
from pathlib import Path
import socket
import shlex
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

KEY = "local-smoke-authentication-key-only"
PORT = 19383
BASE = f"http://127.0.0.1:{PORT}"


class Origin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"RouteHub origin fixture")

    def log_message(self, *_args):
        pass


def request(path, method="GET", payload=None, *, signed=True, expected=200, content_type="application/json"):
    headers = {"Content-Type": content_type, "Origin": BASE}
    if signed:
        headers["X-RouteHub-Key"] = KEY
    if payload is not None and not isinstance(payload, bytes):
        payload = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=payload, method=method, headers=headers)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read()
        assert response.code == expected, (path, response.code, data.decode(errors="replace"))
        if response.headers.get_content_type() == "application/json":
            return json.loads(data)
        return data


def upload(path, file, filename, **fields):
    boundary = "routehub-local-test"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
        for key, value in fields.items()
    ]
    parts += [f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\r\n".encode(),
              file, f"\r\n--{boundary}--\r\n".encode()]
    return request(path, "POST", b"".join(parts), content_type="multipart/form-data; boundary=" + boundary)


def socks(port):
    destination = socket.inet_aton("127.0.0.1")
    with socket.create_connection(("127.0.0.1", PORT + 1), timeout=6) as stream:
        data = stream.makefile("rb")
        stream.sendall(b"\x05\x01\x00")
        assert data.read(2) == b"\x05\x00"
        stream.sendall(b"\x05\x01\x00\x01" + destination + struct.pack("!H", port))
        header = data.read(4)
        assert header == b"\x05\x00\x00\x01", header
        assert len(data.read(6)) == 6
        stream.sendall(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        assert b"RouteHub origin fixture" in data.read()


def run(binary, xray):
    with tempfile.TemporaryDirectory(prefix="routehub-panel-") as tmp, http.server.HTTPServer(("127.0.0.1", 0), Origin) as origin:
        tmp = Path(tmp)
        origin_port = origin.server_address[1]
        thread = threading.Thread(target=origin.serve_forever, daemon=True)
        thread.start()
        config = tmp / "plan.json"
        config.write_text(json.dumps({"panelPort": PORT, "socksPort": PORT + 1, "profiles": [], "rules": []}))
        key = tmp / "key"
        key.touch(mode=0o600)
        key.write_text(KEY)
        wrapper = tmp / "fixture-xray"
        wrapper.write_text("#!/bin/sh\n"
                           "if [ \"$1\" = run ] && [ \"$2\" = -c ] && grep -q force-start-failure.example \"$3\"; then exit 74; fi\n"
                           f"exec {shlex.quote(str(xray))} \"$@\"\n")
        wrapper.chmod(0o700)
        command = [str(binary), "serve", "-config", str(config), "-xray", str(wrapper),
                   "-panel-key-file", str(key), "-helper-dir", str(tmp), "-dns-listen", ""]
        with subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as child:
            try:
                for _ in range(120):
                    if child.poll() is not None:
                        raise RuntimeError("Fixture RouteHub exited before reaching readiness")
                    try:
                        request("/api/status")
                        break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Panel did not start")

                assert b"<html" in request("/", signed=False)
                request("/api/panel/revisions", signed=False, expected=401)
                request("/api/plan", "PUT", {}, signed=False, expected=403)
                socks(origin_port)

                items = upload("/api/import", b"example.net\n203.0.113.0/24\n", "policy.txt", target="@block")
                assert len(items["rules"]) == 2 and all(rule["target"] == "@block" for rule in items["rules"])
                profiles = upload("/api/profiles/import",
                                  b"vless://00000000-0000-4000-8000-000000000001@example.net:443?type=tcp&security=tls#Fixture",
                                  "links.txt")
                assert profiles["profiles"][0]["protocol"] == "vless"

                before = request("/api/plan")
                rule = {"name": "Lab route", "domain": "example.net", "target": "@block"}
                draft = {"revision": before["revision"], "profiles": [], "rules": [rule]}
                preview = request("/api/panel/apply/preview", "POST", draft)
                assert preview["errors"] == [] and preview["restarts"] == ["Ядро Xray"]
                assert request("/api/plan")["revision"] == before["revision"]
                after = request("/api/plan", "PUT", draft)
                assert after["revision"] != before["revision"] and after["rules"] == [rule]
                request("/api/plan", "PUT", draft, expected=409)
                match = request("/api/evaluate", "POST", {"host": "api.example.net", "network": "tcp", "port": 443})
                assert match["target"] == "@block"
                assert json.loads(config.read_text())["rules"] == [rule]
                assert request("/api/backup", "POST", {"scope": "rules"})["rules"] == [rule]
                history = request("/api/panel/revisions")
                assert history[0]["revision"] == before["revision"]
                restored = request("/api/panel/revisions/restore", "POST", {
                    "revision": before["revision"], "baseRevision": after["revision"],
                })
                assert restored["rules"] == []
                socks(origin_port)

                failure = {"revision": restored["revision"], "profiles": [], "rules": [
                    {"name": "Force Xray startup failure", "domain": "force-start-failure.example", "target": "@block"},
                ]}
                rejected = request("/api/plan", "PUT", failure, expected=422)
                assert "прежняя конфигурация восстановлена" in rejected["error"], rejected
                assert request("/api/plan")["revision"] == restored["revision"]
                assert json.loads(config.read_text())["rules"] == []
                socks(origin_port)

                state = request("/api/runtime/vpn", "PUT", {"enabled": False})
                assert not state["vpn"]["enabled"]
                request("/api/runtime/vpn", "PUT", {"enabled": True}, expected=400)
                boot = request("/api/runtime/boot", "PUT", {"vpn": False, "zapretYouTube": False, "zapretDiscord": False})
                assert not boot["boot"]["vpn"]
                assert (tmp / "runtime.json").stat().st_mode & 0o077 == 0
            finally:
                if child.poll() is None:
                    child.terminate()
                _, err = child.communicate(timeout=15)
                if child.returncode:
                    raise RuntimeError(io.BytesIO(err).read().decode())
                origin.shutdown()
        print("PASS: panel, authorization, imports, draft, persistence, backup, restore, rollback, runtime and Xray SOCKS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda value: Path(value).resolve())
    parser.add_argument("xray", type=lambda value: Path(value).resolve())
    args = parser.parse_args()
    run(args.binary, args.xray)
