#!/usr/bin/env python3
"""Exercise a local Linux Xray binary without external connections or root."""

import errno
import json
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time


class TCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True


class TCPEcho(socketserver.BaseRequestHandler):
    def handle(self):
        self.server.received.set()
        self.request.sendall(self.request.recv(64))


class UDPEcho(socketserver.BaseRequestHandler):
    def handle(self):
        self.server.received.set()
        payload, peer = self.request
        peer.sendto(payload, self.client_address)


def read_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        part = sock.recv(count - len(data))
        if not part:
            raise ConnectionResetError("SOCKS connection closed")
        data.extend(part)
    return bytes(data)


def request(sock, command, port):
    sock.sendall(b"\x05\x01\x00")
    if read_exact(sock, 2) != b"\x05\x00":
        raise RuntimeError("SOCKS greeting rejected")
    host = "127.0.0.1" if command == 1 else "0.0.0.0"
    sock.sendall(bytes([5, command, 0, 1]) + socket.inet_aton(host) + struct.pack("!H", port))
    version, status, reserved, family = read_exact(sock, 4)
    if (version, reserved) != (5, 0):
        raise RuntimeError("invalid SOCKS reply")
    if status:
        raise ConnectionRefusedError(f"SOCKS error {status}")
    if family != 1:
        raise RuntimeError(f"unexpected SOCKS bound address type {family}")
    address = socket.inet_ntoa(read_exact(sock, 4))
    reply_port = struct.unpack("!H", read_exact(sock, 2))[0]
    return address, reply_port


def test_tcp(proxy_port, target_port):
    with socket.create_connection(("127.0.0.1", proxy_port), timeout=2) as client:
        request(client, 1, target_port)
        client.sendall(b"tcp-echo")
        return read_exact(client, 8) == b"tcp-echo"


def test_udp(proxy_port, target_port):
    with socket.create_connection(("127.0.0.1", proxy_port), timeout=2) as control:
        _, udp_port = request(control, 3, 0)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(2)
            header = b"\x00\x00\x00\x01" + socket.inet_aton("127.0.0.1") + struct.pack("!H", target_port)
            client.sendto(header + b"udp-echo", ("127.0.0.1", udp_port))
            response, _ = client.recvfrom(512)
            return response == header + b"udp-echo"


def verify_mode(binary, interface, tcp_port, udp_port, expect_echo):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        proxy_port = listener.getsockname()[1]
    config = {
        "log": {"loglevel": "warning"},
        "inbounds": [{
            "listen": "127.0.0.1", "port": proxy_port, "protocol": "socks",
            "settings": {"auth": "noauth", "udp": True, "ip": "127.0.0.1"},
        }],
        "outbounds": [{
            "tag": "asc", "protocol": "freedom", "settings": {},
            "streamSettings": {"sockopt": {"interface": interface}},
        }],
    }
    with tempfile.TemporaryDirectory(prefix="routehub-awg-check-") as directory:
        path = Path(directory) / "xray.json"
        path.write_text(json.dumps(config))
        with (Path(directory) / "xray.log").open("w+") as log:
            proxy = subprocess.Popen([binary, "run", "-config", str(path)], stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 3
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", proxy_port), timeout=0.1):
                            break
                    except ConnectionRefusedError:
                        if proxy.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise RuntimeError(log.read()) from None
                        time.sleep(0.03)

                for check, port in ((test_tcp, tcp_port), (test_udp, udp_port)):
                    try:
                        result = check(proxy_port, port)
                    except (ConnectionRefusedError, ConnectionResetError, TimeoutError, BrokenPipeError):
                        result = False
                    except OSError as error:
                        if error.errno != errno.ENETUNREACH:
                            raise
                        result = False
                    if result != expect_echo:
                        log.seek(0)
                        raise AssertionError(f"{check.__name__} on {interface}: {log.read()}")
                    print(f"{check.__name__} on {interface}: {'echo' if result else 'no fallback'}")
            finally:
                proxy.terminate()
                try:
                    proxy.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.wait()


def main(binary):
    with TCPServer(("127.0.0.1", 0), TCPEcho) as tcp, socketserver.UDPServer(("127.0.0.1", 0), UDPEcho) as udp:
        for server in (tcp, udp):
            server.received = threading.Event()
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            verify_mode(binary, "lo", tcp.server_address[1], udp.server_address[1], True)
            if not (tcp.received.is_set() and udp.received.is_set()):
                raise AssertionError("control traffic did not reach both endpoints")
            for server in (tcp, udp):
                server.received.clear()
            verify_mode(binary, "rh-awg-missing", tcp.server_address[1], udp.server_address[1], False)
            if tcp.received.is_set() or udp.received.is_set():
                raise AssertionError("traffic reached an endpoint despite failed interface binding")
        finally:
            tcp.shutdown()
            udp.shutdown()


if __name__ == "__main__":
    main(sys.argv[1])
