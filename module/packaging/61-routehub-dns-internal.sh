#!/bin/sh
[ "${type:-}" = iptables ] && [ "${table:-}" = nat ] || exit 0
[ -s /opt/var/run/routehub-dns/active ] || exit 0
[ -x /tmp/routehub-live/helpers/routehub-dns ] || exit 0
exec /tmp/routehub-live/helpers/routehub-dns refresh
