"""Packet assertions in a disposable Linux ARM64 network, with no WAN."""
from contextlib import ExitStack, contextmanager
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve()
HELPER = Path("/opt/lib/routehub/routehub-dns")
HOOK = HERE.with_name("61-routehub-dns.sh")
STATE = Path("/opt/var/run/routehub-dns/active")
ROUTER = "192.168.70.1"
ALIAS = "192.168.70.3"
EXTERNAL = "198.18.0.2"
PORT = 18955


def run(*args, env=None):
    return subprocess.check_output(args, text=True, env=env).strip()


@contextmanager
def process(*args):
    handle = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        yield handle
    finally:
        if handle.poll() is None:
            handle.terminate()
            try:
                handle.wait(3)
            except subprocess.TimeoutExpired:
                handle.kill()
                handle.wait()
        handle.stdout.close()
        handle.stdin.close()


def check(condition, note):
    if not condition:
        raise AssertionError(note)


def await_check(test, message, timeout=8):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if test():
            return
        time.sleep(.05)
    raise AssertionError(message)


def ns(pid, *args):
    return run("nsenter", "-t", str(pid), "-n", *args)


def create_link(router, client, pid, raddr, caddr):
    run("ip", "link", "add", router, "type", "veth", "peer", "name", client)
    run("ip", "link", "set", client, "netns", str(pid))
    run("ip", "addr", "add", raddr, "dev", router)
    run("ip", "link", "set", router, "up")
    ns(pid, "ip", "addr", "add", caddr, "dev", client)
    ns(pid, "ip", "link", "set", client, "up")


def lookup(pid, ip, protocol, source=None, port=53):
    return ns(pid, sys.executable, str(HERE), "query", ip, protocol, source or "-", str(port))


def query(ip, protocol, source, port):
    sock_type = socket.SOCK_STREAM if protocol == "tcp" else socket.SOCK_DGRAM
    with socket.socket(socket.AF_INET, sock_type) as client:
        client.settimeout(1)
        if source != "-":
            client.bind((source, 0))
        client.connect((ip, int(port)))
        client.sendall(b"query")
        return client.recv(64).decode()


def pinned_query(ip):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.settimeout(1)
        client.connect((ip, 53))
        for _ in sys.stdin:
            client.sendall(b"query")
            print(client.recv(64).decode(), flush=True)


def reply_service(output, address, port):
    def handle_tcp(listener):
        while True:
            conn, _ = listener.accept()
            with conn:
                if conn.recv(64):
                    conn.sendall(output.encode())

    def handle_udp(listener):
        while True:
            query, address = listener.recvfrom(64)
            if query:
                listener.sendto(output.encode(), address)

    services, listeners = [], []
    for kind, handler in ((socket.SOCK_STREAM, handle_tcp), (socket.SOCK_DGRAM, handle_udp)):
        listener = socket.socket(socket.AF_INET, kind)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((address, int(port)))
        if kind == socket.SOCK_STREAM:
            listener.listen(5)
        listeners.append(listener)
        services.append(threading.Thread(target=handler, args=(listener,), daemon=True))
    def close_sockets(*_):
        for listener in listeners:
            listener.close()

    signal.signal(signal.SIGUSR1, close_sockets)
    for service in services:
        service.start()
    print("ready", flush=True)
    while True:
        time.sleep(90)


def install_test_helper():
    HELPER.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE.with_name("routehub-dns"), HELPER)


def main():
    install_test_helper()
    with ExitStack() as stack:
        names = ("lan", "other", "wan")
        networks = {name: stack.enter_context(process("unshare", "-n", "sleep", "100")).pid for name in names}
        parent = os.readlink("/proc/self/ns/net")
        for pid in networks.values():
            await_check(lambda: os.readlink(f"/proc/{pid}/ns/net") != parent, "network failed to isolate")

        create_link("lab-lan", "lab-src", networks["lan"], ROUTER+"/24", "192.168.70.2/24")
        create_link("lab-other", "lab-guest", networks["other"], "192.168.72.1/24", "192.168.72.2/24")
        create_link("lab-wan", "lab-peer", networks["wan"], "198.18.0.1/24", EXTERNAL+"/24")
        run("ip", "addr", "add", ALIAS+"/24", "dev", "lab-lan")
        run("ip", "addr", "add", "192.168.71.1/24", "dev", "lab-lan")
        ns(networks["lan"], "ip", "addr", "add", "192.168.71.2/24", "dev", "lab-src")
        ns(networks["lan"], "ip", "route", "add", EXTERNAL+"/32", "via", ROUTER)
        ns(networks["other"], "ip", "addr", "add", "192.168.70.99/32", "dev", "lab-guest")
        ns(networks["other"], "ip", "route", "add", ROUTER+"/32", "via", "192.168.72.1", "src", "192.168.70.99")
        run("ip", "route", "add", "192.168.70.99/32", "via", "192.168.72.2", "dev", "lab-other")
        ns(networks["wan"], "ip", "route", "add", "192.168.70.0/24", "via", "198.18.0.1")
        check(run("sysctl", "-n", "net.ipv4.ip_forward") == "1", "test needs isolated IPv4 forwarding")

        def server(output, address, port, pid=None):
            prefix = ("nsenter", "-t", str(pid), "-n") if pid else ()
            instance = stack.enter_context(process(*prefix, sys.executable, str(HERE), "serve", output, address, str(port)))
            check(instance.stdout.readline().strip() == "ready", "fixture server not ready")
            return instance

        native = server("native", ROUTER, 53)
        server("other-address", ALIAS, 53)
        server("port-control", ROUTER, 5353)
        server("external", EXTERNAL, 53, networks["wan"])
        redirect = server("routehub", ROUTER, PORT)
        args = ("start", "lab-lan", "192.168.70.0/24", ROUTER, str(PORT), str(redirect.pid))
        baseline = run("iptables", "-t", "nat", "-S")
        stack.callback(run, HELPER, "stop")
        check(run(HELPER, "status") == "inactive", "new resolver implicitly attached")
        rejected = subprocess.run((HELPER, *args[:-1], str(native.pid)), check=False)
        check(rejected.returncode != 0, "helper attached using the PID of an unrelated process")
        check(run("iptables", "-t", "nat", "-S") == baseline, "bad resolver mutated the firewall")

        def links():
            check(lookup(networks["lan"], ROUTER, "udp") == "routehub", "LAN UDP was not redirected")
            check(lookup(networks["lan"], ROUTER, "tcp") == "routehub", "LAN TCP was not redirected")
            check(lookup(networks["lan"], ROUTER, "udp", "192.168.71.2") == "native", "outside CIDR was redirected")
            check(lookup(networks["other"], ROUTER, "udp", "192.168.70.99") == "native", "outside interface was redirected")
            check(lookup(networks["lan"], ALIAS, "udp") == "other-address", "router alias destination was redirected")
            check(lookup(networks["lan"], ROUTER, "udp", port=5353) == "port-control", "non-DNS port was redirected")
            for protocol in ("udp", "tcp"):
                check(lookup(networks["lan"], EXTERNAL, protocol) == "external", "direct external DNS was redirected")
            check(query(ROUTER, "udp", "-", "53") == "native", "router-originated DNS was redirected")

        run(HELPER, *args)
        run(HELPER, *args)
        check(run(HELPER, "status") == "active", "helper did not report active")
        links()
        check(run("iptables", "-t", "nat", "-S", "PREROUTING").count("-j RH_DNS_LAN") == 2, "duplicate hooks")
        print("TCP and UDP enter owned resolver on exact LAN interface, CIDR, destination and port", flush=True)

        for command in run("iptables", "-t", "nat", "-S", "PREROUTING").splitlines():
            if command.endswith("-j RH_DNS_LAN"):
                run("iptables", "-t", "nat", *command.replace("-A ", "-D ", 1).split())
        run("iptables", "-t", "nat", "-F", "RH_DNS_LAN")
        run("iptables", "-t", "nat", "-X", "RH_DNS_LAN")
        check(run(HELPER, "status") == "degraded", "missing native NAT state was not reported")
        env = os.environ | {"type": "iptables", "table": "nat"}
        run(HOOK, env=env)
        run(HOOK, env=env)
        check(run(HELPER, "status") == "active", "NDM replay did not restore rules")
        links()

        if shutil.which("conntrack"):
            with process("nsenter", "-t", str(networks["lan"]), "-n", sys.executable, str(HERE), "repeat", ROUTER) as pinned:
                def exchange():
                    pinned.stdin.write("lookup\n")
                    pinned.stdin.flush()
                    return pinned.stdout.readline().strip()

                check(exchange() == "routehub", "fixed UDP socket did not reach RouteHub")
                run(HELPER, "stop")
                check(exchange() == "native", "existing UDP socket retained stale DNAT after stop")
            print("Same UDP socket returned immediately to native DNS with optional conntrack", flush=True)
        else:
            run(HELPER, "stop")
        run(HELPER, "stop")
        check(run("iptables", "-t", "nat", "-S") == baseline, "cleanup changed unrelated NAT rules")
        check(lookup(networks["lan"], ROUTER, "tcp") == "native", "native DNS did not resume after stop")

        run(HELPER, *args)
        redirect.send_signal(signal.SIGUSR1)
        await_check(lambda: not STATE.exists(), "watcher kept NAT attached after the resolver closed")
        check(redirect.poll() is None, "resolver fixture exited instead of only closing sockets")
        check(run("iptables", "-t", "nat", "-S") == baseline, "listener stop affected other NAT state")
        redirect.terminate()
        redirect.wait()

        redirect = server("routehub", ROUTER, PORT)
        run(HELPER, *args[:-1], str(redirect.pid))
        redirect.kill()
        redirect.wait()
        await_check(lambda: not STATE.exists(), "watcher did not remove stale state after SIGKILL")
        check(run("iptables", "-t", "nat", "-S") == baseline, "watchdog left stale NAT rules")
        check(lookup(networks["lan"], ROUTER, "udp") == "native", "native DNS did not resume after resolver crash")
        print("NDM refresh, explicit stop, SIGKILL fail-open and untouched NAT baseline verified", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "query":
        print(query(*sys.argv[2:]))
    elif len(sys.argv) > 1 and sys.argv[1] == "repeat":
        pinned_query(sys.argv[2])
    elif len(sys.argv) > 1 and sys.argv[1] == "serve":
        reply_service(*sys.argv[2:])
    else:
        main()
