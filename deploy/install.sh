#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || $EUID -ne 0 ]]; then
  echo 'Usage as root: deploy/install.sh <built-cli.js> <release-id> [absolute-node-24-path]' >&2
  exit 64
fi
cli=$1
release=$2
node_binary=${3:-$(command -v node)}
if [[ ! $release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ || $node_binary != /* || ! -f $cli || ! -x $node_binary ]]; then
  echo 'Use an existing CLI bundle, a plain release ID, and an absolute executable Node path.' >&2
  exit 64
fi
if [[ $("$node_binary" -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  echo 'Install Node 24 before installing Repo Chap.' >&2
  exit 1
fi
if systemctl is-active --quiet repo-chap.service; then
  echo 'Stop repo-chap.service and create a coherent backup before changing its release.' >&2
  exit 1
fi
if ! id repo-chap >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/repo-chap-home --shell /usr/sbin/nologin repo-chap
fi
install -d -m 0700 -o repo-chap -g repo-chap /etc/repo-chap /var/lib/repo-chap /var/lib/repo-chap-home
install -d -m 0755 /opt/repo-chap/releases /opt/repo-chap/bin
target=/opt/repo-chap/releases/$release
if [[ -e $target ]]; then
  if [[ ! -f $target/cli.js ]] || ! cmp -s "$cli" "$target/cli.js"; then
    echo 'This release ID already contains different data. Choose a new release ID.' >&2
    exit 1
  fi
else
  install -d -m 0755 "$target"
  install -m 0644 "$cli" "$target/cli.js"
  ln -s "$node_binary" "$target/node"
  printf '#!/bin/sh\nexec "%s/node" "%s/cli.js" "$@"\n' "$target" "$target" > "$target/repo-chap"
  chmod 0755 "$target/repo-chap"
fi
if [[ -e /opt/repo-chap/current && ! -L /opt/repo-chap/current ]]; then
  echo '/opt/repo-chap/current must be a release symlink. Inspect it before installing.' >&2
  exit 1
fi
pending=$(mktemp -d /opt/repo-chap/.install-XXXXXXXX)
trap 'rm -rf "$pending"' EXIT
ln -s "$target" "$pending/current"
mv -Tf "$pending/current" /opt/repo-chap/current
install -m 0644 "$(dirname "$0")/repo-chap.service" /etc/systemd/system/repo-chap.service
sed -e 's/Description=.*/Description=Repo Chap service account diagnostics/' -e 's/Type=simple/Type=oneshot/' \
  -e 's/ daemon start / daemon diagnose /' -e '/^Restart=/d' -e '/^RestartSec=/d' -e '/^\[Install\]/,$d' \
  "$(dirname "$0")/repo-chap.service" > /etc/systemd/system/repo-chap-diagnostics.service
chmod 0644 /etc/systemd/system/repo-chap-diagnostics.service
systemd-analyze verify /etc/systemd/system/repo-chap.service /etc/systemd/system/repo-chap-diagnostics.service
systemctl daemon-reload
echo 'Installed. Add private account-owned configuration, run daemon diagnose as repo-chap, then enable and start repo-chap.service.'
