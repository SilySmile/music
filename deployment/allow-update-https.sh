#!/bin/sh
set -eu
if ! /sbin/iptables -C IN_BT -p tcp --dport 443 -m comment --comment xianqiji-updates-https -j ACCEPT 2>/dev/null; then
    /sbin/iptables -I IN_BT 1 -p tcp --dport 443 -m comment --comment xianqiji-updates-https -j ACCEPT
fi
