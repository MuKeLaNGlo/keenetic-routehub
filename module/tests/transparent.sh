#!/bin/sh
# Run inside a disposable Linux network namespace with SYS_ADMIN and NET_ADMIN.
set -eu

helper=/opt/lib/routehub/routehub-transparent
routehub_pid=
src_pid=
dst_pid=
http_pid=
udp_pid=
cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then
        iptables -t mangle -L -n -v 2>/dev/null || true
        if [ -f /tmp/xray-client.log ]; then cat /tmp/xray-client.log; fi
    fi
    "$helper" stop 2>/dev/null || true
    for process in "$routehub_pid" "$src_pid" "$dst_pid" "$http_pid" "$udp_pid"; do
        if [ -n "$process" ]; then kill "$process" 2>/dev/null || true; fi
    done
}
trap cleanup EXIT

mkdir -p /opt/lib/routehub
cp /redirect/routehub-transparent "$helper"
chmod 0755 "$helper"
unshare -n sleep 90 &
src_pid=$!
unshare -n sleep 90 &
dst_pid=$!
for process in "$src_pid" "$dst_pid"; do
    attempts=0
    until [ "$(readlink "/proc/$process/ns/net")" != "$(readlink /proc/self/ns/net)" ]; do
        attempts=$((attempts + 1))
        [ "$attempts" -le 10 ]
        sleep 0.1
    done
done

ip link add lab-lan type veth peer name lab-src
ip link add lab-wan type veth peer name lab-dst
ip link set lab-src netns "$src_pid"
ip link set lab-dst netns "$dst_pid"
ip addr add 198.18.0.1/30 dev lab-lan
ip addr add 192.0.2.1/30 dev lab-wan
ip link set lab-lan up
ip link set lab-wan up
nsenter -t "$src_pid" -n ip addr add 198.18.0.2/30 dev lab-src
nsenter -t "$src_pid" -n ip link set lab-src up
nsenter -t "$src_pid" -n ip route add 192.0.2.2/32 via 198.18.0.1
nsenter -t "$dst_pid" -n ip addr add 192.0.2.2/30 dev lab-dst
nsenter -t "$dst_pid" -n ip link set lab-dst up
nsenter -t "$dst_pid" -n python -c '
import socketserver
class Response(socketserver.StreamRequestHandler):
    def handle(self):
        while self.rfile.readline() not in (b"", b"\r\n"):
            pass
        self.wfile.write(b"HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\nisolated-forwarding-ok\n")
with socketserver.TCPServer(("192.0.2.2", 18080), Response) as server:
    server.serve_forever()
' &
http_pid=$!
nsenter -t "$dst_pid" -n python -c '
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
    server.bind(("192.0.2.2", 18081))
    while True:
        message, client = server.recvfrom(2048)
        server.sendto(message, client)
' &
udp_pid=$!

attempts=0
until wget -qO- http://192.0.2.2:18080/ | grep -qx isolated-forwarding-ok; do
    attempts=$((attempts + 1))
    [ "$attempts" -le 10 ]
    sleep 0.1
done

cat >/tmp/routehub-test.json <<'JSON'
{
  "transparent": {"interface": "lab-lan", "source": "198.18.0.2/32", "port": 18954}
}
JSON

start() {
    /fixtures/routehub serve -config /tmp/routehub-test.json -xray "${XRAY_TEST_BIN:-/fixtures/xray}" -allow-lan &
    routehub_pid=$!
    attempts=0
    until wget -qO- http://127.0.0.1:18952/api/status | grep -q '"lan":true'; do
        kill -0 "$routehub_pid"
        attempts=$((attempts + 1))
        [ "$attempts" -le 12 ]
        sleep 0.3
    done
}

assert_clean() {
    if iptables -t mangle -S | grep -q RH_TPROXY || ip -4 rule show | grep -q 7354; then
        return 1
    fi
    [ -z "$(ip -4 route show table 7354 2>/dev/null || true)" ]
}

start
nsenter -t "$src_pid" -n wget -T 4 -qO- http://192.0.2.2:18080/ | grep -qx isolated-forwarding-ok
nsenter -t "$src_pid" -n python -c '
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
    client.settimeout(4)
    client.sendto(b"isolated-udp", ("192.0.2.2", 18081))
    data, remote = client.recvfrom(2048)
    assert (data, remote) == (b"isolated-udp", ("192.0.2.2", 18081))
'
iptables -t mangle -L RH_TPROXY -v -n -x |
    awk '$3 == "TPROXY" && $1 > 0 {matched++} END {exit matched != 2}'
printf '%s\n' 'TCP and UDP redirected through Xray'

iptables -t mangle -D PREROUTING -i lab-lan -s 198.18.0.2/32 -j RH_TPROXY
iptables -t mangle -F RH_TPROXY
iptables -t mangle -X RH_TPROXY
type=iptables table=mangle sh /redirect/60-routehub.sh
type=iptables table=mangle sh /redirect/60-routehub.sh
iptables -t mangle -S PREROUTING | awk '/-j RH_TPROXY$/ {matched++} END {exit matched != 1}'
kill -TERM "$routehub_pid"
wait "$routehub_pid"
assert_clean
printf '%s\n' 'NDM replay and graceful cleanup verified'

start
kill -KILL "$routehub_pid"
wait "$routehub_pid" 2>/dev/null || true
routehub_pid=
sleep 2
assert_clean
start
kill -TERM "$routehub_pid"
wait "$routehub_pid"
routehub_pid=
printf '%s\n' 'Crash cleanup released firewall and listener'

iptables -t mangle -N STEALTHSURF_FIXTURE
if /fixtures/routehub serve -config /tmp/routehub-test.json -xray /fixtures/xray -allow-lan; then
    exit 1
fi
assert_clean
iptables -t mangle -X STEALTHSURF_FIXTURE
printf '%s\n' 'Existing StealthSurf rules block activation'
