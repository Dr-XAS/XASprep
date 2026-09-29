#!/bin/bash
# Does xasprep need a person? For a monitor outside this app to ask.
#
#   ops/check.sh     prints "ok" and exits 0, or says what is wrong on one
#                    line and exits 1
#
# The scripts here restart what they can and write what they cannot fix to
# ops/logs/alerts.log, which nobody reads until something is already wrong:
# a halted liveness timer, a commit the watcher has given up on, a deploy that
# failed and left main undeployed. The Dr.XAS ops sentinel runs this on its
# own schedule and takes a failure to #ops.
#
# Whether the web answers is not judged here. The sentinel probes /healthz
# itself, and a check that went through this script would go quiet exactly
# when the host is too sick to run it.
#
# Reads state and nothing else: no network, no lock, no screen, no write. It
# is safe to run every few seconds, and it cannot race a deploy.

SCRIPT_NAME=check
source "$(dirname "$(readlink -f "$0")")/lib.sh"

# An error or critical alert stays news for this long, then the check clears
# by itself. A warning (a restart that worked) never fails it.
ALERT_WINDOW=3600
# watcher-liveness.sh relaunches a watcher past 300s, every five minutes.
# Past twice that, the relaunch is not working.
HEARTBEAT_MAX=600

main() {
    local problems=() status state stamp cutoff recent

    if halted; then
        problems+=("liveness halted: $(state_read liveness-halted)")
    fi

    status=$(state_read watch-status.json)
    state=$(json_field state <<<"$status")
    case $state in
        blocked|failed) problems+=("watcher $state: $(json_field detail <<<"$status")") ;;
    esac

    stamp=$(cat "$OPS_DIR/.watch-heartbeat" 2>/dev/null || true)
    if [[ ! $stamp =~ ^[0-9]+$ ]] || (( $(date +%s) - stamp > HEARTBEAT_MAX )); then
        problems+=("the watcher has not ticked for over $((HEARTBEAT_MAX / 60)) minutes")
    fi

    cutoff=$(date -u -d "@$(( $(date +%s) - ALERT_WINDOW ))" '+%Y-%m-%dT%H:%M:%SZ')
    recent=$(awk -v c="$cutoff" '$1 >= c && ($2 == "error" || $2 == "critical")' \
        "$LOG_DIR/alerts.log" 2>/dev/null | tail -1 || true)
    if [[ -n $recent ]]; then
        problems+=("alert at ${recent}")
    fi

    if (( ${#problems[@]} == 0 )); then
        printf 'ok\n'
        return 0
    fi
    local line=${problems[0]} p
    for p in "${problems[@]:1}"; do line+=" | $p"; done
    printf '%s\n' "$line"
    return 1
}

main "$@"
