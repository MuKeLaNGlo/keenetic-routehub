#!/bin/sh
[ "${type:-}" = iptables ] && [ "${table:-}" = nat ] || exit 0
[ -s /opt/var/run/routehub-dns/active ] || exit 0
exec /opt/lib/routehub/routehub-dns refresh
