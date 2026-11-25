"""Run inside an isolated ARM64 Linux container with /fixtures mounted read-only."""

import hashlib
import http.client
import http.server
import json
import os
import signal
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

HOST = "127.0.0.1"
SOCKS = 18953
BASE = "http://127.0.0.1:18952"
CLIENT_ID = "b114f077-9113-4ac7-aa02-cd0f57d4c21e"
TEST_PASSWORD = "temporary-fixture"
FIXTURES = Path("/fixtures")
MARKER = b"routehub-end-to-end"


class Sink(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(MARKER)))
        self.end_headers()
        self.wfile.write(MARKER)

    def log_message(self, *args):
        pass


def echo(port):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind((HOST, port))
        while True:
            message, client = server.recvfrom(2048)
            server.sendto(message, client)


def read_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        block = sock.recv(count - len(data))
        assert block, "SOCKS reply ended early"
        data.extend(block)
    return bytes(data)


def socks_request(sock, action, port):
    sock.sendall(b"\x05\x01\x00")
    assert read_exact(sock, 2) == b"\x05\x00"
    sock.sendall(bytes([5, action, 0, 1]) + socket.inet_aton(HOST) + port.to_bytes(2, "big"))
    reply = read_exact(sock, 10)
    assert reply[:4] == b"\x05\x00\x00\x01", "SOCKS request failed"
    return int.from_bytes(reply[8:], "big")


def http_over_socks(port):
    with socket.create_connection((HOST, SOCKS), timeout=4) as client:
        socks_request(client, 1, port)
        client.sendall(b"GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        response = http.client.HTTPResponse(client)
        response.begin()
        return response.read()


def udp_over_socks(port):
    with socket.create_connection((HOST, SOCKS), timeout=4) as association:
        bound_port = socks_request(association, 3, 0)
        header = b"\x00\x00\x00\x01" + socket.inet_aton(HOST) + port.to_bytes(2, "big")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(5)
            client.sendto(header + MARKER, (HOST, bound_port))
            return client.recv(2048)[10:]


def upstream_inbounds():
    tls = {
        "certificates": [{
            "certificateFile": str(FIXTURES / "cert.pem"),
            "keyFile": str(FIXTURES / "key.pem"),
        }],
    }
    return [
        {
            "listen": HOST, "port": 41001, "protocol": "vless",
            "settings": {"clients": [{"id": CLIENT_ID}], "decryption": "none"},
        },
        {
            "listen": HOST, "port": 41002, "protocol": "trojan",
            "settings": {"clients": [{"password": TEST_PASSWORD}]},
            "streamSettings": {"network": "raw", "security": "tls", "tlsSettings": tls},
        },
        {
            "listen": HOST, "port": 41003, "protocol": "hysteria",
            "settings": {"version": 2, "users": [{"auth": TEST_PASSWORD}]},
            "streamSettings": {
                "network": "hysteria", "security": "tls", "tlsSettings": tls,
                "hysteriaSettings": {"version": 2},
                "finalmask": {"udp": [{"type": "salamander", "settings": {"password": TEST_PASSWORD}}]},
            },
        },
    ]


def run():
    xray = str(FIXTURES / "xray")
    generated = subprocess.check_output([xray, "x25519"], text=True)
    keys = dict(line.split(": ", 1) for line in generated.splitlines() if ": " in line)
    pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(
        (FIXTURES / "cert.pem").read_text())).hexdigest()
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        upstream = root / "upstream.json"
        upstream.write_text(json.dumps({
            "log": {"loglevel": "debug" if os.getenv("XRAY_FIXTURE_DEBUG") else "warning"},
            "inbounds": upstream_inbounds(),
            "outbounds": [{
                "protocol": "freedom",
                "settings": {"finalRules": [{
                    "action": "allow", "ip": ["127.0.0.1/32"], "port": "41201-41203",
                }]},
            }],
        }))
        config = root / "client.json"
        config.write_text(json.dumps({
            "profiles": [
                {"id": "vless-local", "protocol": "vless",
                 "uri": f"vless://{CLIENT_ID}@{HOST}:41001?security=none&type=tcp"},
                {"id": "trojan-local", "protocol": "trojan",
                 "uri": f"trojan://{TEST_PASSWORD}@{HOST}:41002?sni=localhost&pinSHA256={pin}"},
                {"id": "hy2-local", "protocol": "hysteria2",
                 "uri": f"hy2://{TEST_PASSWORD}@{HOST}:41003?sni=localhost&pinSHA256={pin}"
                        f"&obfs=salamander&obfs-password={TEST_PASSWORD}"},
                {"id": "reality-local", "protocol": "vless",
                 "uri": f"vless://{CLIENT_ID}@{HOST}:41005?security=reality"
                        f"&sni=localhost&pbk={keys['Password (PublicKey)']}&sid=aabb&fp=chrome"},
            ],
            "rules": [
                {"name": tag, "cidr": "127.0.0.1/32", "port": port, "target": tag}
                for tag, port in (
                    ("vless-local", 41201), ("trojan-local", 41202), ("hy2-local", 41203),
                )
            ],
        }))
        for port in range(41201, 41205):
            server = http.server.ThreadingHTTPServer((HOST, port), Sink)
            threading.Thread(target=server.serve_forever, daemon=True).start()
        threading.Thread(target=echo, args=(41203,), daemon=True).start()

        routehub = str(FIXTURES / "routehub")
        subprocess.run([routehub, "check", "-config", str(config), "-xray", xray], check=True)
        print("Xray accepted generated VLESS REALITY settings", flush=True)
        server = subprocess.Popen([xray, "run", "-c", str(upstream)])
        xray_client = str(FIXTURES / "xray-debug") if os.getenv("XRAY_FIXTURE_DEBUG") else xray
        client = subprocess.Popen([routehub, "serve", "-config", str(config), "-xray", xray_client])
        try:
            for _ in range(40):
                assert server.poll() is None and client.poll() is None, "proxy process ended early"
                try:
                    with urllib.request.urlopen(BASE + "/api/plan", timeout=1) as response:
                        plan = response.read()
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise AssertionError("panel unavailable")
            assert TEST_PASSWORD.encode() not in plan and CLIENT_ID.encode() not in plan
            for port, tag in ((41201, "VLESS RAW"), (41202, "Trojan TLS"),
                              (41203, "Hysteria2 TCP with salamander"), (41204, "direct fallback")):
                assert MARKER in http_over_socks(port), tag
                print(tag + " handshake and HTTP response OK", flush=True)
            assert udp_over_socks(41203) == MARKER
            print("Hysteria2 UDP echo OK", flush=True)

            server.terminate()
            server.wait(5)
            for port in (41201, 41202, 41203):
                try:
                    answer = http_over_socks(port)
                except (OSError, http.client.HTTPException):
                    answer = b""
                assert MARKER not in answer, "vpn traffic fell back to direct"
            assert MARKER in http_over_socks(41204)
            print("Unavailable profiles failed closed, direct path stayed reachable")
        finally:
            for process in (client, server):
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    process.wait(10)
            if os.getenv("XRAY_FIXTURE_DEBUG") and Path("/tmp/xray-client.log").is_file():
                print(Path("/tmp/xray-client.log").read_text())


if __name__ == "__main__":
    run()
