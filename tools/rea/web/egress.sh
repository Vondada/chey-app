#!/usr/bin/env bash
# Kernel egress rules for the browser observer, used by che-rea-web.yml and checked in CI.
# The rules match only the observer's own user (iptables owner match), so the runner's own
# traffic is untouched: global loopback and link-local rejects leave a GitHub-hosted runner
# unable to finish its job. For that user every private, loopback, link-local, shared,
# documentation, multicast and reserved IPv4 range is rejected, all IPv6 is rejected (mapped
# and tunnel forms included), and only port 53 of the system's own DNS servers stays open.
# The address checked is the address the socket connects to, so DNS rebinding cannot reach a
# private address. Exits non-zero unless every rule is in place.
#
#   tools/rea/web/egress.sh [user]      prints uid=<n> on success
set -euo pipefail
user="${1:-rea-observer}"
id -u "$user" >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
uid="$(id -u "$user")"

for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 \
  192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  sudo iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -d "$cidr" -j REJECT
done
# Inserted last, so they sit above the rejects: DNS to the configured resolvers, port 53 only.
for ns in $(awk '/^nameserver[[:space:]]/ { print $2 }' /etc/resolv.conf); do
  case "$ns" in *:*) continue ;; esac
  for proto in udp tcp; do
    sudo iptables -I OUTPUT 1 -m owner --uid-owner "$uid" -d "$ns/32" -p "$proto" --dport 53 -j ACCEPT
  done
done
sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$uid" -j REJECT

sudo iptables -C OUTPUT -m owner --uid-owner "$uid" -d 169.254.0.0/16 -j REJECT
sudo iptables -C OUTPUT -m owner --uid-owner "$uid" -d 127.0.0.0/8 -j REJECT
sudo iptables -C OUTPUT -m owner --uid-owner "$uid" -d 10.0.0.0/8 -j REJECT
sudo ip6tables -C OUTPUT -m owner --uid-owner "$uid" -j REJECT
echo "uid=$uid"
