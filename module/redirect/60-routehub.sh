#!/bin/sh
[ "${type:-}" = iptables ] || exit 0
case "${table:-}" in
    nat|filter)
        if [ -s /opt/var/run/routehub-redirect-tcp.active ]; then
            exec /opt/lib/routehub/routehub-redirect-tcp refresh
        fi
        [ "$table" = filter ] || exit 0
        ;;
    mangle) ;;
    *) exit 0 ;;
esac
[ -s /opt/var/run/routehub-transparent.active ] || exit 0
exec /opt/lib/routehub/routehub-transparent refresh
