"""Check an actual VLESS traffic path and switching back to direct access."""

import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request

PORT = 19423
PANEL = f"http://127.0.0.1:{PORT}"
KEY = "offline-vless-smoke-fixture-key-only"
ORIGIN_HOST = "1.1.1.2"
VLESS_ID = "00000000-0000-4000-8000-000000000888"


class Origin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"vless local origin"
        self.send_response(200)
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type":"application/json","Origin":PANEL,"X-RouteHub-Key":KEY}
    with urllib.request.urlopen(urllib.request.Request(
        PANEL + path, data=data, method="PUT" if path.endswith("/vpn") else "GET", headers=headers,
    ), timeout=10) as response:
        return json.load(response)


def through_socks(port):
    addr = socket.inet_aton(ORIGIN_HOST)
    with socket.create_connection(("127.0.0.1", PORT + 1), timeout=4) as client:
        stream = client.makefile("rb")
        client.sendall(b"\x05\x01\x00")
        assert stream.read(2) == b"\x05\x00"
        client.sendall(b"\x05\x01\x00\x01" + addr + struct.pack("!H", port))
        assert stream.read(4) == b"\x05\x00\x00\x01"
        assert len(stream.read(6)) == 6
        client.sendall(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        with http.client.HTTPResponse(client) as response:
            response.begin()
            assert response.status == 200 and response.read() == b"vless local origin"


def run():
    subprocess.run(["ip","addr","add",ORIGIN_HOST+"/32","dev","lo"],check=True)
    with tempfile.TemporaryDirectory(prefix="routehub-vless-") as fixture, http.server.HTTPServer((ORIGIN_HOST,0),Origin) as origin:
        fixture = Path(fixture)
        thread = threading.Thread(target=origin.serve_forever,daemon=True)
        thread.start()
        port = origin.server_address[1]
        peer_log = fixture / "peer.log"
        peer_config = fixture / "peer.json"
        peer_config.write_text(json.dumps({
            "log":{"access":str(peer_log),"loglevel":"info"},
            "inbounds":[{"listen":"127.0.0.1","port":PORT+2,"protocol":"vless",
                         "settings":{"decryption":"none","clients":[{"id":VLESS_ID,"email":"routehub-fixture"}]}}],
            "outbounds":[{"protocol":"freedom","tag":"exit"}],
        }))
        plan = fixture / "config.json"
        plan.write_text(json.dumps({
            "panelPort":PORT,"socksPort":PORT+1,"defaultTarget":"@vpn","rules":[],
            "profiles":[{"id":"lab-vless","protocol":"vless",
                         "uri":f"vless://{VLESS_ID}@127.0.0.1:{PORT+2}?security=none&type=tcp"}],
        }))
        key = fixture / "panel.key"
        key.touch(mode=0o600)
        key.write_text(KEY)
        debug=fixture/"peer-debug.log"
        debug_stream=debug.open("wb")
        with subprocess.Popen(["/lab/xray","run","-c",str(peer_config)],stdout=debug_stream,stderr=debug_stream) as peer:
            try:
                for _ in range(80):
                    if peer.poll() is not None:
                        raise RuntimeError(debug.read_text())
                    try:
                        with socket.create_connection(("127.0.0.1",PORT+2),timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("VLESS peer failed to listen")
                with subprocess.Popen(["/lab/" + os.environ.get("ROUTEHUB_LAB_BINARY","routehub-rust-final"),"serve","-config",str(plan),"-xray","/lab/xray",
                                       "-panel-key-file",str(key),"-dns-listen",""],stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE) as routehub:
                    try:
                        for _ in range(120):
                            assert routehub.poll() is None and peer.poll() is None
                            try:
                                if call("/api/runtime")["vpn"]["enabled"]:
                                    break
                            except OSError:
                                time.sleep(0.05)
                        else:
                            raise RuntimeError("RouteHub did not start")
                        through_socks(port)
                        expected=f"tcp:{ORIGIN_HOST}:{port}"
                        assert expected in peer_log.read_text(), peer_log.read_text()
                        count=peer_log.read_text().count(expected)
                        assert not call("/api/runtime/vpn",{"enabled":False})["vpn"]["enabled"]
                        through_socks(port)
                        assert peer_log.read_text().count(expected)==count
                        assert call("/api/runtime/vpn",{"enabled":True,"profile":"lab-vless"})["vpn"]["enabled"]
                        through_socks(port)
                        assert peer_log.read_text().count(expected)==count+1
                    except Exception:
                        print(debug.read_text())
                        if peer_log.exists(): print(peer_log.read_text())
                        raise
                    finally:
                        if routehub.poll() is None:
                            routehub.terminate()
                        _, err=routehub.communicate(timeout=12)
                        if routehub.returncode:
                            print(err.decode())
            finally:
                if peer.poll() is None:
                    peer.terminate()
                peer.communicate(timeout=10)
                origin.shutdown()
    print("PASS: live Xray VLESS path, runtime VPN off and on, and direct egress")


if __name__ == "__main__":
    assert sorted(os.listdir("/sys/class/net")) == ["lo"]
    run()
