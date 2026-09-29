#!/bin/bash
# Keeps the web process alive. Cron, */5.
#
# Restarts only this app's named screen, and only after the health URL — not
# merely the port — has failed. A process that holds the port open while
# failing every request is exactly the case a port check misses.

SCRIPT_NAME=liveness
source "$(dirname "$(readlink -f "$0")")/lib.sh"

RESTART_LOG="$STATE_DIR/web-restarts"
STORM_WINDOW=900
STORM_LIMIT=3

storm_tripped() {
    local cutoff
    cutoff=$(( $(date +%s) - STORM_WINDOW ))
    [[ -f $RESTART_LOG ]] || return 1
    (( $(awk -v c="$cutoff" '$1 >= c' "$RESTART_LOG" | wc -l) >= STORM_LIMIT ))
}

record_restart() {
    local now cutoff
    now=$(date +%s); cutoff=$((now - STORM_WINDOW))
    {
        [[ -f $RESTART_LOG ]] && awk -v c="$cutoff" '$1 >= c' "$RESTART_LOG"
        printf '%s %s\n' "$now" "$1"
    } | atomic_write "$RESTART_LOG" 0600
}

start_web() {
    local release
    release=$(readlink -f "$CURRENT_LINK") || return 1
    start_web_screen "$SCREEN_WEB" "$release" "$OPS_DIR/env.live" "$LOG_DIR/$SCREEN_WEB.log"
}

check() {
    if halted; then
        log "liveness-halted present; not resurrecting the web process"
        return 0
    fi
    # A deploy legitimately stops and starts the screen. Do not race it.
    if lock_held deploy; then
        log "deploy in progress; skipping this tick"
        return 0
    fi

    local status reason=""
    status=$(http_status "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 10)

    if ! screen_exists "$SCREEN_WEB"; then
        reason="screen $SCREEN_WEB is gone"
    elif [[ $status != 200 ]]; then
        # One retry: a single slow response on a loaded box is not an outage.
        sleep 5
        status=$(http_status "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 10)
        [[ $status != 200 ]] && reason="health returned $status twice"
    fi

    [[ -n $reason ]] || return 0

    if storm_tripped; then
        halt "web restart storm: $STORM_LIMIT restarts in $((STORM_WINDOW / 60)) minutes"
        alert critical "xasprep restart storm; halted. Last reason: $reason"
        return 1
    fi

    warn "restarting web: $reason"
    record_restart "$reason"
    screen_quit "$SCREEN_WEB" || true
    start_web
    sleep 15
    status=$(http_status "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 10)
    if [[ $status == 200 ]]; then
        alert warning "xasprep web was restarted ($reason) and is healthy again"
    else
        alert error "xasprep web restart did not restore health (got $status; $reason)"
    fi
    return 0
}

main() {
    mkdir -p "$LOG_DIR" "$STATE_DIR"
    with_lock liveness 0 check
    local rc=$?
    (( rc == 75 )) && { log "previous tick still running; skipping"; return 0; }
    return "$rc"
}

main "$@"
