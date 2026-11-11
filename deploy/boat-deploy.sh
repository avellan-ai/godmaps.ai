#!/usr/bin/env bash
# Deploy this checkout's HEAD commit to a boat.dev sandbox and a Cloudflare
# Worker. Every subcommand reads the current state and applies the difference,
# so a second run changes nothing. See deploy/README.md.
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: deploy/boat-deploy.sh <command> [app-env-file]

  sandbox [app-env-file]  Create or reuse the sandbox, copy HEAD to it, start
                          the stack and print the Worker settings.
  worker-key              Create the Worker's boat API key if none is stored.
  worker                  Deploy the Cloudflare Worker with its secrets.
  all [app-env-file]      sandbox, then worker-key. It does not touch Cloudflare.

Values come from deploy/config.json. Secrets live in $GODMAPS_STATE_DIR
(default ~/.config/godmaps). These variables replace a stored value:
GODMAPS_SANDBOX_ID, GODMAPS_GATE_SECRET, BOAT_WORKER_API_KEY.
GODMAPS_KEY_TTL sets the lifetime of a new Worker key (default 90d).
EOF
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
state=${GODMAPS_STATE_DIR:-$HOME/.config/godmaps}
remote_repo=/home/user/godmaps
remote_env=/home/user/godmaps-env
wrangler=${GODMAPS_WRANGLER:-wrangler@4.160.0}

cfg() { jq -er "$1" "$here/config.json"; }
public_host=$(cfg .publicHost)
sandbox_name=$(cfg .sandboxName)
port=$(cfg .sandboxPort)
ttl=$(($(cfg .idleMinutes) * 60))

say() { printf '%s\n' "$*" >&2; }
die() {
  say "error: $*"
  exit 1
}

# Store a secret from the environment, so CI and a laptop share one code path.
seed() {
  local file=$state/$1 value=${2:-}
  [ -z "$value" ] || printf '%s' "$value" >"$file"
}

sandbox_id() {
  if [ -s "$state/sandbox-id" ]; then
    cat "$state/sandbox-id"
    return
  fi
  boat list --all --json |
    jq -r --arg name "$sandbox_name" \
      '[.sandboxes[] | select(.name == $name)][0].id // empty'
}

# Run a shell command on the sandbox and show its output, not boat's JSON.
remote() {
  local id=$1 timeout=$2 result
  shift 2
  result=$(boat exec "$id" --timeout "$timeout" --json -- "$*")
  jq -r '.stdout, .stderr | select(. != "")' <<<"$result" >&2
  [ "$(jq -r .exitCode <<<"$result")" = 0 ]
}

push() {
  local result
  result=$(boat push "$1" "$2" --to "$3" --json) ||
    die "boat push failed: $(jq -r '.error // "unknown error"' <<<"$result" | tail -n 1)"
}

sandbox_state() { boat info "$1" --json | jq -r .sandbox.state; }

ensure_sandbox() {
  local id
  id=$(sandbox_id)
  if [ -z "$id" ]; then
    say "creating sandbox $sandbox_name"
    # --no-env keeps the account's stored secrets off a public machine.
    id=$(boat new --no-env --type small --name "$sandbox_name" --ttl "$ttl" --json |
      jq -r 'select(.id != null) | .id' | tail -n 1)
    [ -n "$id" ] || die "boat new returned no sandbox id"
  fi
  case $(sandbox_state "$id") in
  archived | stopped) boat resume "$id" --ttl "$ttl" >/dev/null ;;
  archiving | stopping) die "sandbox $id is stopping; run this again in a minute" ;;
  esac
  printf '%s' "$id" >"$state/sandbox-id"
  printf '%s' "$id"
}

gate_env() {
  cat <<EOF
GATE_SECRET=$(cat "$state/gate-secret")
GATE_PORT=$port
PUBLIC_HOST=$public_host
GATE_BLOCKED_PATHS=$(cfg '[.blockedPrefixes[] | . + "*"] | join(" ")')
EOF
}

cmd_sandbox() {
  local app_env=${1:-} id commit staging url code compose
  [ -z "$app_env" ] || [ -f "$app_env" ] || die "no such env file: $app_env"
  [ -s "$state/gate-secret" ] || openssl rand -hex 32 >"$state/gate-secret"
  commit=$(git -C "$repo" rev-parse HEAD)
  id=$(ensure_sandbox)
  say "sandbox $id, commit $commit"

  staging=$tmp
  mkdir "$staging/repo" "$staging/env"
  git -C "$repo" archive "$commit" | tar -x -C "$staging/repo"
  gate_env >"$staging/env/gate.env"
  printf 'GODMAPS_ENV_DIR=%s\nPUBLIC_HOST=%s\nGATE_PORT=%s\n' \
    "$remote_env" "$public_host" "$port" >"$staging/env/compose.env"
  [ -z "$app_env" ] || cp "$app_env" "$staging/env/app.env"

  # The secrets travel as files. A command line would land in boat's history.
  remote "$id" 30 "mkdir -p $remote_env && touch $remote_env/app.env && chmod 700 $remote_env"
  push "$id" "$staging/env" "$remote_env"

  # The marker exists only after a complete copy and build of that commit, so
  # an interrupted run copies again and a repeated run rebuilds nothing.
  compose="docker compose --env-file $remote_env/compose.env"
  if remote "$id" 30 "[ \"\$(cat $remote_env/deployed-commit 2>/dev/null)\" = $commit ]"; then
    say "the sandbox already has this commit"
    remote "$id" 600 "cd $remote_repo/deploy && $compose up --detach --remove-orphans 2>&1 | tail -n 5"
  else
    remote "$id" 30 "rm -rf $remote_repo $remote_env/deployed-commit"
    push "$id" "$staging/repo" "$remote_repo"
    remote "$id" 600 "cd $remote_repo/deploy && $compose up --detach --build --force-recreate --remove-orphans --quiet-pull 2>&1 | tail -n 5 && echo $commit > $remote_env/deployed-commit"
  fi

  url=$(boat host "$id" "$port" --public --json | jq -er .url)
  boat extend "$id" --ttl "$ttl" >/dev/null

  say "waiting for the app to answer through the gate"
  for _ in $(seq 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "X-Godmaps-Gate: $(cat "$state/gate-secret")" "$url/" || true)
    [ "$code" = 200 ] && break
    sleep 5
  done
  [ "$code" = 200 ] || die "the app did not answer 200 within 10 minutes (last: $code)"

  printf '%s' "$url" >"$state/sandbox-url"
  cat <<EOF
Deployed $commit to sandbox $id.
Sandbox URL: stored in $state/sandbox-url
Worker secrets, read by '$0 worker':
  SANDBOX_ID    $state/sandbox-id
  SANDBOX_URL   $state/sandbox-url
  GATE_SECRET   $state/gate-secret
  BOAT_API_KEY  $state/boat-worker-key (create it with '$0 worker-key')
EOF
}

cmd_worker_key() {
  local id result
  if [ -s "$state/boat-worker-key" ]; then
    say "the Worker's boat API key is already stored"
    return
  fi
  id=$(sandbox_id)
  [ -n "$id" ] || die "no sandbox yet; run '$0 sandbox' first"
  result=$(boat api-key create "godmaps-worker-$id" --sandbox "$id" \
    --ttl "${GODMAPS_KEY_TTL:-90d}" \
    --actions sandbox.read,sandbox.resume,sandbox.update --json) ||
    die "boat refused the key: $(jq -r '.error // "unknown error"' <<<"$result")"
  jq -er '.secret // .key // .apiKey // .token' <<<"$result" >"$tmp/key" ||
    die "boat returned no key secret"
  mv "$tmp/key" "$state/boat-worker-key"
  say "stored a boat API key scoped to $id in $state/boat-worker-key"
  say "it expires $(jq -r '.expiresAt // .apiKey.expiresAt // "at the --ttl you set"' <<<"$result"); rotate it before then"
}

cmd_worker() {
  local secrets name
  for name in sandbox-id sandbox-url gate-secret boat-worker-key; do
    [ -s "$state/$name" ] || die "missing $state/$name; run '$0 all' first"
  done
  secrets=$tmp/worker-secrets.json
  jq -n \
    --rawfile id "$state/sandbox-id" --rawfile url "$state/sandbox-url" \
    --rawfile gate "$state/gate-secret" --rawfile key "$state/boat-worker-key" \
    '{SANDBOX_ID: $id, SANDBOX_URL: $url, GATE_SECRET: $gate, BOAT_API_KEY: $key}
      | map_values(rtrimstr("\n"))' >"$secrets"
  (cd "$here/worker" && npx --yes "$wrangler" deploy \
    --domain "$public_host" --secrets-file "$secrets")
}

main() {
  local command=${1:-}
  [ $# -eq 0 ] || shift
  case $command in
  sandbox | worker-key | worker | all) ;;
  *)
    usage
    exit 2
    ;;
  esac
  mkdir -p "$state"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  seed sandbox-id "${GODMAPS_SANDBOX_ID:-}"
  seed gate-secret "${GODMAPS_GATE_SECRET:-}"
  seed boat-worker-key "${BOAT_WORKER_API_KEY:-}"
  case $command in
  sandbox) cmd_sandbox "$@" ;;
  worker-key) cmd_worker_key ;;
  worker) cmd_worker ;;
  all)
    cmd_sandbox "$@"
    cmd_worker_key
    ;;
  esac
}

main "$@"
