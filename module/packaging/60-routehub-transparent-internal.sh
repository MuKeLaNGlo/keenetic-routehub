#!/bin/sh
[ "${type:-}" = iptables ] || exit 0
case "${table:-}" in
    nat|filter)
        if [ -s /opt/var/run/routehub-redirect-tcp.active ] &&
            [ -x /tmp/routehub-live/helpers/routehub-redirect-tcp ]; then
            exec /tmp/routehub-live/helpers/routehub-redirect-tcp refresh
        fi
        [ "$table" = filter ] || exit 0
        ;;
    mangle) ;;
    *) exit 0 ;;
esac
[ -s /opt/var/run/routehub-transparent.active ] || exit 0
[ -x /tmp/routehub-live/helpers/routehub-transparent ] || exit 0
exec /tmp/routehub-live/helpers/routehub-transparent refresh
