#!/usr/bin/env bash
set -euo pipefail

# Host-managed restart supervisor for codex-discord-bridge.
# Watches a restart-request signal file and restarts the bridge process.
#
# Usage:
#   scripts/restart-supervisor.sh -- bun run start
#
# Env overrides:
#   RESTART_REQUEST_PATH   (default: data/restart-request.json)
#   RESTART_ACK_PATH       (default: data/restart-ack.json)
#   HEARTBEAT_PATH         (default: data/bridge-heartbeat.json)
#   RESTART_POLL_INTERVAL  (seconds, default: 3)
#   RESTART_MIN_INTERVAL   (seconds, default: 15)
#   RESTART_DRAIN_TIMEOUT  (seconds, default: 120)
#   RESTART_DRAIN_POLL     (seconds, default: 2)

if [[ "${1:-}" != "--" ]]; then
  echo "Usage: $0 -- <bridge command...>" >&2
  exit 1
fi
shift

if [[ "$#" -eq 0 ]]; then
  echo "Missing bridge command. Example: $0 -- bun run start" >&2
  exit 1
fi

# launchd ProgramArguments can accidentally include empty entries.
while [[ "$#" -gt 0 && -z "${1}" ]]; do
  shift
done

if [[ "$#" -eq 0 ]]; then
  echo "Bridge command is empty after '--' (check LaunchAgent ProgramArguments)." >&2
  exit 1
fi

RESTART_REQUEST_PATH="${RESTART_REQUEST_PATH:-data/restart-request.json}"
RESTART_ACK_PATH="${RESTART_ACK_PATH:-data/restart-ack.json}"
HEARTBEAT_PATH="${HEARTBEAT_PATH:-data/bridge-heartbeat.json}"
RESTART_POLL_INTERVAL="${RESTART_POLL_INTERVAL:-3}"
RESTART_MIN_INTERVAL="${RESTART_MIN_INTERVAL:-15}"
RESTART_DRAIN_TIMEOUT="${RESTART_DRAIN_TIMEOUT:-120}"
RESTART_DRAIN_POLL="${RESTART_DRAIN_POLL:-2}"

child_pid=""
last_request_sig=""
last_restart_epoch=0

start_child() {
  echo "[supervisor] starting bridge: $*"
  "$@" &
  child_pid="$!"
}

stop_child() {
  if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
    echo "[supervisor] stopping bridge pid=${child_pid}"
    kill "${child_pid}" 2>/dev/null || true
    wait "${child_pid}" 2>/dev/null || true
  fi
  child_pid=""
}

read_active_turns() {
  if [[ ! -f "${HEARTBEAT_PATH}" ]]; then
    echo ""
    return
  fi
  sed -n 's/.*"activeTurns"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${HEARTBEAT_PATH}" | head -n 1
}

wait_for_turn_drain() {
  local start_epoch now_epoch waited active_turns
  start_epoch="$(date +%s)"
  while true; do
    active_turns="$(read_active_turns)"
    if [[ -n "${active_turns}" && "${active_turns}" -eq 0 ]]; then
      return
    fi
    now_epoch="$(date +%s)"
    waited=$((now_epoch - start_epoch))
    if (( waited >= RESTART_DRAIN_TIMEOUT )); then
      echo "[supervisor] drain timeout reached (${RESTART_DRAIN_TIMEOUT}s); forcing restart"
      return
    fi
    echo "[supervisor] restart pending: waiting for active turns to drain (activeTurns=${active_turns:-unknown}, waited=${waited}s)"
    sleep "${RESTART_DRAIN_POLL}"
  done
}

handle_exit() {
  stop_child
  exit 0
}

trap handle_exit INT TERM

start_child "$@"

while true; do
  if [[ -n "${child_pid}" ]] && ! kill -0 "${child_pid}" 2>/dev/null; then
    echo "[supervisor] bridge exited unexpectedly; restarting"
    start_child "$@"
  fi

  if [[ -f "${RESTART_REQUEST_PATH}" ]]; then
    request_sig="$(cat "${RESTART_REQUEST_PATH}" 2>/dev/null | shasum | awk '{print $1}')"
    if [[ -n "${request_sig}" && "${request_sig}" != "${last_request_sig}" ]]; then
      now_epoch="$(date +%s)"
      since_last=$((now_epoch - last_restart_epoch))
      if (( since_last < RESTART_MIN_INTERVAL )); then
        sleep_for=$((RESTART_MIN_INTERVAL - since_last))
        echo "[supervisor] restart requested but throttled (${since_last}s < ${RESTART_MIN_INTERVAL}s). sleeping ${sleep_for}s"
        sleep "${sleep_for}"
      fi

      echo "[supervisor] restart request detected at ${RESTART_REQUEST_PATH}"
      last_request_sig="${request_sig}"
      last_restart_epoch="$(date +%s)"
      mkdir -p "$(dirname "${RESTART_ACK_PATH}")"
      cat >"${RESTART_ACK_PATH}" <<EOF
{
  "acknowledgedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "requestSignature": "${request_sig}"
}
EOF
      wait_for_turn_drain
      stop_child
      start_child "$@"
      rm -f "${RESTART_REQUEST_PATH}" 2>/dev/null || true
    fi
  fi

  sleep "${RESTART_POLL_INTERVAL}"
done
