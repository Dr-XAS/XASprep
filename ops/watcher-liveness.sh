#!/bin/bash
# Keeps the watcher alive. Cron, */5.
#
# Two failure modes, not one:
#
#   dead    — the screen session is gone.
#   wedged  — the session exists and the process is blocked forever in a hung
#             fetch. An existence check calls that healthy.
#
# The heartbeat file distinguishes them. A watcher that has not written one in
# HEARTBEAT_MAX seconds is quit by exact name and relaunched.

SCRIPT_NAME=watcher-liveness
source "$(dirname "$(readlink -f "$0")")/lib.sh"

HEARTBEAT="$OPS_DIR/.watch-heartbeat"
HEARTBEAT_MAX=300           # watch.sh ticks every 60s +/- 15s
LAG_ALERT_SECONDS=1800      # remote ahead of last-successful for 30 min
RESTART_LOG="$STATE_DIR/watcher-restarts"
STORM_WINDOW=900
STORM_LIMIT=3

heartbeat_age() {
    local stamp now
    [[ -f $HEARTBEAT ]] || { printf '%s\n' 999999; return; }
    stamp=$(cat "$HEARTBEAT" 2>/dev/null)
    [[ $stamp =~ ^[0-9]+$ ]] || { printf '%s\n' 999999; return; }
    now=$(date +%s)
    printf '%s\n' $(( now - stamp ))
}

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

start_watcher() {
    # Absolute paths. A relative one resolves against cron's working
    # directory, which is $HOME on NFS and not where this application lives.
    screen_start "$SCREEN_WATCH" "$OPS_DIR" "$LOG_DIR/$SCREEN_WATCH.log" \
        /bin/bash "$OPS_DIR/watch.sh"
}

check_lag() {
    local status remote deployed changed_at now
    [[ -f "$STATE_DIR/watch-status.json" ]] || return 0
    # Behind on purpose: somebody rolled back and said so.
    pinned && { rm -f "$STATE_DIR/.lag-since"; return 0; }
    status=$(cat "$STATE_DIR/watch-status.json")
    remote=$(json_field remote <<<"$status" 2>/dev/null || true)
    deployed=$(json_field deployed <<<"$status" 2>/dev/null || true)
    [[ -n $remote && -n $deployed && $remote != "$deployed" ]] || {
        rm -f "$STATE_DIR/.lag-since"; return 0
    }

    now=$(date +%s)
    if [[ -f "$STATE_DIR/.lag-since" ]]; then
        changed_at=$(cat "$STATE_DIR/.lag-since")
    else
        printf '%s\n' "$now" | atomic_write "$STATE_DIR/.lag-since" 0600
        return 0
    fi
    [[ $changed_at =~ ^[0-9]+$ ]] || return 0

    if (( now - changed_at > LAG_ALERT_SECONDS )); then
        alert error "xasprep has been $(( (now - changed_at) / 60 )) minutes behind origin/${BRANCH} (remote ${remote:0:8}, deployed ${deployed:0:8})"
        # Re-arm so the alert repeats at the same interval, not every tick.
        printf '%s\n' "$now" | atomic_write "$STATE_DIR/.lag-since" 0600
    fi
}

check() {
    if halted; then
        log "liveness-halted present; not resurrecting the watcher"
        return 0
    fi

    local age reason=""
    age=$(heartbeat_age)

    if ! screen_exists "$SCREEN_WATCH"; then
        reason="screen $SCREEN_WATCH is gone"
    elif (( age > HEARTBEAT_MAX )); then
        reason="heartbeat is ${age}s old (max ${HEARTBEAT_MAX}s); watcher is wedged, not merely idle"
    fi

    if [[ -n $reason ]]; then
        if storm_tripped; then
            halt "watcher restart storm: $STORM_LIMIT restarts in $((STORM_WINDOW / 60)) minutes"
            alert critical "xasprep watcher restart storm; halted. Last reason: $reason"
            return 1
        fi
        warn "restarting watcher: $reason"
        record_restart "$reason"
        # Quit first even when it looks gone: a wedged session must not be
        # left holding the watch lock.
        screen_quit "$SCREEN_WATCH" || true
        start_watcher
        sleep 10
        if screen_exists "$SCREEN_WATCH"; then
            alert warning "xasprep watcher was restarted ($reason)"
        else
            alert error "xasprep watcher failed to start ($reason)"
        fi
        return 0
    fi

    check_lag
    return 0
}

main() {
    mkdir -p "$LOG_DIR" "$STATE_DIR"
    with_lock watcher-liveness 0 check
    local rc=$?
    (( rc == 75 )) && { log "previous tick still running; skipping"; return 0; }
    return "$rc"
}

main "$@"
