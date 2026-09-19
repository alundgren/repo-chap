#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
logs=${REPO_CHAP_SMOKE_LOG_DIR:-$(mktemp -d /tmp/repo-chap-systemd-XXXXXXXX)}
mkdir -p "$logs"
chmod 0700 "$logs"
name=repo-chap-smoke-$(date +%s)-$$
image=$name:local
cleanup() {
  docker logs "$name" > "$logs/container.log" 2>&1 || true
  docker exec "$name" journalctl -u repo-chap.service --no-pager > "$logs/service.log" 2>&1 || true
  docker exec "$name" journalctl -u repo-chap-diagnostics.service --no-pager > "$logs/diagnostic-service.log" 2>&1 || true
  docker cp "$name:/tmp/register.json" "$logs/register.json" >/dev/null 2>&1 || true
  docker cp "$name:/tmp/diagnostics.json" "$logs/diagnostics.json" >/dev/null 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
test -f "$root/apps/cli/dist/cli.js"
docker build --build-arg NODE_VERSION="$(cat "$root/.node-version")" -f "$root/deploy/smoke.Dockerfile" -t "$image" "$root/deploy" > "$logs/build.log" 2>&1
docker run -d --name "$name" --privileged --cgroupns=private --network none --memory 768m --pids-limit 512 --tmpfs /run --tmpfs /run/lock "$image" > "$logs/container-id"
docker cp "$root/deploy" "$name:/opt/install"
docker cp "$root/apps/cli/dist/cli.js" "$name:/opt/cli.js"
docker cp "$root/tests/helpers/operations-preload.mjs" "$name:/opt/preload.mjs"
docker cp "$root/tests/helpers/operations-setup.mjs" "$name:/opt/setup.mjs"
docker exec -i "$name" bash -s > "$logs/checks.log" 2>&1 <<'SCRIPT'
set -Eeuo pipefail
trap 'cat /tmp/status.json /tmp/register.json /tmp/diagnostics.json /tmp/restored.json /tmp/restarted.json >&2 2>/dev/null || true' ERR
for attempt in $(seq 1 60); do
  if systemctl list-units --no-pager >/dev/null 2>&1; then break; fi
  sleep 1
done
bash /opt/install/install.sh /opt/cli.js fictional-v1 /usr/local/bin/node
bash /opt/install/install.sh /opt/cli.js fictional-v1 /usr/local/bin/node
vp node /opt/setup.mjs /etc/repo-chap /var/lib/repo-chap-home/provider
chown -R repo-chap:repo-chap /etc/repo-chap /var/lib/repo-chap-home
mkdir -p /etc/systemd/system/repo-chap.service.d /etc/systemd/system/repo-chap-diagnostics.service.d
printf '[Service]\nEnvironment=NODE_OPTIONS=--import=/opt/preload.mjs\n' > /etc/systemd/system/repo-chap.service.d/fixture.conf
cp /etc/systemd/system/repo-chap.service.d/fixture.conf /etc/systemd/system/repo-chap-diagnostics.service.d/fixture.conf
systemctl daemon-reload
systemctl enable --now repo-chap.service
cli() { sudo -u repo-chap -H env PATH=/opt/repo-chap/bin:/usr/local/bin:/usr/bin:/bin NODE_OPTIONS=--import=/opt/preload.mjs /opt/repo-chap/current/repo-chap "$@"; }
for attempt in $(seq 1 30); do
  if cli daemon status --state-dir /var/lib/repo-chap --json > /tmp/status.json; then break; fi
  sleep 1
done
vp node -e 'const s=require("/tmp/status.json");if(!s.ok||s.result.recovery.paused)process.exit(1)'
test "$(systemctl show -p User --value repo-chap.service)" = repo-chap
test "$(stat -c %a /var/lib/repo-chap/control.sock)" = 600
test "$(stat -c %a /var/lib/repo-chap/runtime.sqlite)" = 600
test "$(stat -c %a /etc/repo-chap)" = 700
cli daemon register /etc/repo-chap/workflow.json --repo-root /etc/repo-chap --repo reef-labs/paperboat --profile pilot --state-dir /var/lib/repo-chap --json > /tmp/register.json
vp node -e 'if(!require("/tmp/register.json").ok)process.exit(1)'
cli daemon pause --repo reef-labs/paperboat --state-dir /var/lib/repo-chap
cli daemon diagnose --state-dir /var/lib/repo-chap --config /etc/repo-chap/installation.json --json > /tmp/diagnostics.json
vp node -e 'const d=require("/tmp/diagnostics.json");if(!d.ok||d.account.uid===0)process.exit(1);console.log(JSON.stringify(d))'
systemctl start repo-chap-diagnostics.service
test "$(systemctl show -p ExecMainStatus --value repo-chap-diagnostics.service)" = 0
test -z "$(ss -H -lntup)"
systemctl stop repo-chap.service
test ! -S /var/lib/repo-chap/control.sock
cli daemon backup /var/lib/repo-chap-home/backup --state-dir /var/lib/repo-chap --config /etc/repo-chap/installation.json
cli daemon restore /var/lib/repo-chap-home/backup --state-dir /var/lib/repo-chap-home/restored
mv /var/lib/repo-chap /var/lib/repo-chap-original
mv /var/lib/repo-chap-home/restored /var/lib/repo-chap
systemctl start repo-chap.service
for attempt in $(seq 1 30); do
  if cli daemon status --state-dir /var/lib/repo-chap --json > /tmp/restored.json; then break; fi
  sleep 1
done
vp node -e 'const s=require("/tmp/restored.json").result;if(!s.recovery.paused||!s.repositories[0].paused||s.limits.repositoryCostUnits!==5)process.exit(1)'
cli daemon reconcile --state-dir /var/lib/repo-chap
cli daemon resume-restored --state-dir /var/lib/repo-chap
systemctl restart repo-chap.service
for attempt in $(seq 1 30); do
  if cli daemon status --state-dir /var/lib/repo-chap --json > /tmp/restarted.json; then break; fi
  sleep 1
done
vp node -e 'const s=require("/tmp/restarted.json").result;if(s.recovery.paused||!s.repositories[0].paused||s.limits.repositoryCostUnits!==5)process.exit(1)'
test -z "$(ss -H -lntup)"
systemctl stop repo-chap.service
test ! -S /var/lib/repo-chap/control.sock
echo 'PASS: isolated systemd install, account diagnostics, CLI, no TCP/UDP listener, stop, backup/paused restore and restart.'
SCRIPT
cat "$logs/checks.log"
printf 'Systemd smoke logs: %s\n' "$logs"
