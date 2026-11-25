#!/bin/sh
# Run in a disposable Linux mount/network namespace with SYS_ADMIN and NET_ADMIN.
set -eu

fixtures=${ROUTEHUB_TEST_FIXTURES:-/fixtures}
helper=/opt/lib/routehub/routehub-redirect-tcp
hook="$fixtures/60-routehub.sh"
service=
client=
target=
endpoint=
scratch=$(mktemp -d)
cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then
        iptables -t nat -L -n -v || true
        iptables -t filter -L -n -v || true
    fi
    for process in "$service" "$endpoint" "$client" "$target"; do
        [ -z "$process" ] || kill "$process" 2>/dev/null || true
    done
    "$helper" stop 2>/dev/null || true
    rm -rf "$scratch"
}
trap cleanup EXIT

mkdir -p /opt/lib/routehub
cp "$fixtures/routehub-redirect-tcp" "$helper"
chmod 0755 "$helper"
unshare -n sleep 60 &
client=$!
unshare -n sleep 60 &
target=$!
for process in "$client" "$target"; do
    attempt=0
    until [ "$(readlink /proc/"$process"/ns/net)" != "$(readlink /proc/self/ns/net)" ]; do
        attempt=$((attempt+1))
        [ "$attempt" -lt 10 ]
        sleep .1
    done
done

ip link set lo up
ip link add lab-lan type veth peer name lab-client
ip link add lab-wan type veth peer name lab-target
ip link set lab-client netns "$client"
ip link set lab-target netns "$target"
ip addr add 192.168.10.1/29 dev lab-lan
ip addr add 192.0.2.1/30 dev lab-wan
ip link set lab-lan up
ip link set lab-wan up
sysctl -qw net.ipv4.ip_forward=1
nsenter -t "$client" -n ip addr add 192.168.10.2/29 dev lab-client
nsenter -t "$client" -n ip addr add 192.168.10.3/29 dev lab-client
nsenter -t "$client" -n ip link set lab-client up
nsenter -t "$client" -n ip route add 192.0.2.2/32 via 192.168.10.1
nsenter -t "$target" -n ip addr add 192.0.2.2/30 dev lab-target
nsenter -t "$target" -n ip link set lab-target up
nsenter -t "$target" -n ip route add 192.168.10.0/29 via 192.0.2.1

nsenter -t "$target" -n python3 -c '
import select
import socket
with socket.socket() as web, socket.socket() as dns, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
    web.bind(("192.0.2.2", 18443))
    dns.bind(("192.0.2.2", 53))
    udp.bind(("192.0.2.2", 18443))
    web.listen()
    dns.listen()
    while True:
        ready, _, _ = select.select([web, dns, udp], [], [])
        for s in ready:
            if s is udp:
                data, peer = udp.recvfrom(256)
                udp.sendto(peer[0].encode("ascii") + b" " + data, peer)
                continue
            peer, addr = s.accept()
            with peer:
                if peer.recv(256):
                    peer.sendall(addr[0].encode("ascii"))
' &
endpoint=$!

cat >"$scratch/plan.json" <<'JSON'
{
  "panelHost": "192.168.10.1",
  "panelNetwork": "192.168.10.0/29",
  "transparent": {"interface": "lab-lan", "source": "192.168.10.2/32", "port": 18954, "mode": "redirect-tcp"}
}
JSON

start() {
    "$fixtures/routehub" serve -config "$scratch/plan.json" -xray "$fixtures/xray" -allow-lan &
    service=$!
    attempt=0
    until nsenter -t "$client" -n python3 -c '
import json
import urllib.request
with urllib.request.urlopen("http://192.168.10.1:18952/api/status", timeout=.2) as response:
    status = json.load(response)
    assert status["lan"] is True and status["lanMode"] == "redirect-tcp"
' 2>/dev/null; do
        kill -0 "$service"
        attempt=$((attempt+1))
        [ "$attempt" -lt 30 ]
        sleep .2
    done
}

tcp() {
    nsenter -t "$client" -n python3 - "$@" <<'PY'
import socket
import sys
source, destination, port, expected = sys.argv[1:]
with socket.socket() as client:
    client.settimeout(0.6)
    client.bind((source, 0))
    try:
        client.connect((destination, int(port)))
        client.sendall(b"GET / HTTP/1.0\r\n\r\n")
        result = client.recv(256)
    except (ConnectionError, TimeoutError):
        if expected != "blocked":
            raise
    else:
        assert expected != "blocked" and result.decode("ascii") == expected, result
PY
}

udp() {
    nsenter -t "$client" -n python3 -c '
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
    client.settimeout(1)
    client.bind(("192.168.10.2", 0))
    client.sendto(b"native-udp", ("192.0.2.2", 18443))
    assert client.recv(256) == b"192.168.10.2 native-udp"
'
}

assert_clean() {
    [ ! -e /opt/var/run/routehub-redirect-tcp.active ]
    ! iptables-save | grep -q RH_TCP_REDIRECT
    ! ip -4 rule show | grep -q 'lookup 7354'
}

start
tcp 192.168.10.2 192.0.2.2 18443 192.0.2.1
tcp 192.168.10.3 192.0.2.2 18443 192.168.10.3
tcp 192.168.10.2 192.0.2.2 53 192.168.10.2
tcp 192.168.10.2 192.168.10.1 18954 blocked
tcp 192.168.10.3 192.168.10.1 18954 blocked
udp
printf '%s\n' 'TCP original destination, canary scope, DNS bypass, native UDP and guarded listener passed'

iptables -t filter -F RH_TCP_REDIRECT_IN
type=iptables table=filter sh "$hook"
iptables -t nat -D PREROUTING -i lab-lan -s 192.168.10.2/32 -p tcp -j RH_TCP_REDIRECT
iptables -t nat -F RH_TCP_REDIRECT
iptables -t nat -X RH_TCP_REDIRECT
type=iptables table=nat sh "$hook"
type=iptables table=nat sh "$hook"
tcp 192.168.10.2 192.0.2.2 18443 192.0.2.1
tcp 192.168.10.2 192.168.10.1 18954 blocked
iptables -t nat -S PREROUTING | awk '/-j RH_TCP_REDIRECT$/ {n++} END {exit n!=1}'
kill -TERM "$service"
wait "$service"
service=
assert_clean
tcp 192.168.10.2 192.0.2.2 18443 192.168.10.2
printf '%s\n' 'Filter and NAT replay, graceful rollback and native forwarding passed'

start
kill -KILL "$service"
wait "$service" 2>/dev/null || true
service=
sleep 2
assert_clean
printf '%s\n' 'Dead owner cleanup passed'
