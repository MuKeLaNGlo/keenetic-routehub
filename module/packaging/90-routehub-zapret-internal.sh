#!/bin/sh
[ "${table:-}" = mangle ] || exit 0
case "${type:-}" in iptables|ip6tables) ;; *) exit 0 ;; esac
[ -s /var/run/routehub-zapret/child ] || exit 0
[ -x /tmp/routehub-live/helpers/routehub-zapret ] || exit 0
export ROUTEHUB_ZAPRET_ETC=/storage/routehub/opt/etc/routehub
exec /tmp/routehub-live/helpers/routehub-zapret refresh "$type"
