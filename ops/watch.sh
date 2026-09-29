#!/bin/bash
# Git-poll watcher. Runs forever inside screen app-xasprep-watch.
#
# Polls `git ls-remote`, which mutates nothing, and compares the remote tip
# against state/last-successful — not against a checked-out tree, which can
# disagree with what is actually serving.
#
# It writes state/watch-status.json on EVERY tick, including failures, so that
# "alive but failing" is distinguishable from "dead" without reading a log.
# It never exits on a network error: a watcher that exits because GitHub
# blipped is a watcher that needs a human.

SCRIPT_NAME=watch
source "$(dirname "$(readlink -f "$0")")/lib.sh"

POLL_SECONDS=${XASPREP_WATCH_INTERVAL:-60}
JITTER_SECONDS=15
HEARTBEAT="$OPS_DIR/.watch-heartbeat"
STATUS_FILE="$STATE_DIR/watch-status.json"

# A SHA that has already failed to deploy is not retried on a timer. Retrying
# a broken commit every 60 seconds buries the real error and wastes the host.
FAILED_SHA=""
FAILED_COUNT=0
FAILED_MAX=3

write_status() {
    local state=$1 detail=$2 remote=${3:-} deployed=${4:-}
    printf '{"state":%s,"detail":%s,"remote":%s,"deployed":%s,"failed_sha":%s,"failed_count":%d,"at":%s,"pid":%d}\n' \
        "$(json_string "$state")" "$(json_string "$detail")" \
        "$(json_string "$remote")" "$(json_string "$deployed")" \
        "$(json_string "$FAILED_SHA")" "$FAILED_COUNT" \
        "$(json_string "$(now_iso)")" "$$" \
        | atomic_write "$STATUS_FILE" 0600
    # Separate from the status file, so a partially-written status can never
    # make a live watcher look wedged.
    date +%s | atomic_write "$HEARTBEAT" 0600
}

tick() {
    local remote deployed

    if halted; then
        write_status deferred "liveness-halted present: $(state_read liveness-halted)"
        return 0
    fi
    if lock_held deploy; then
        write_status deferred "deploy lock held by another process"
        return 0
    fi
    if pinned; then
        write_status pinned "$(state_read pinned); ops/deploy.sh unpin resumes automatic deploys" \
            "" "$(state_read last-successful)"
        return 0
    fi

    if ! remote=$(remote_tip) || [[ -z $remote ]]; then
        write_status unreachable "git ls-remote failed"
        return 0
    fi

    deployed=$(state_read last-successful)

    if [[ $remote == "$deployed" ]]; then
        FAILED_SHA=""; FAILED_COUNT=0
        write_status idle "up to date" "$remote" "$deployed"
        return 0
    fi

    if [[ $remote == "$FAILED_SHA" ]] && (( FAILED_COUNT >= FAILED_MAX )); then
        write_status blocked \
            "$remote failed $FAILED_COUNT times; push a fix or run ops/deploy.sh deploy $remote by hand" \
            "$remote" "$deployed"
        return 0
    fi

    log "remote is $remote, deployed is ${deployed:-<none>}; deploying"
    write_status deploying "$remote" "$remote" "$deployed"

    local rc=0
    "$OPS_DIR/deploy.sh" deploy "$remote" >>"$LOG_DIR/watch-deploy.log" 2>&1 || rc=$?

    case $rc in
        0)
            FAILED_SHA=""; FAILED_COUNT=0
            write_status idle "deployed $remote" "$remote" "$remote"
            ;;
        75)
            write_status deferred "deploy lock held; will retry" "$remote" "$deployed"
            ;;
        *)
            if [[ $remote == "$FAILED_SHA" ]]; then
                FAILED_COUNT=$((FAILED_COUNT + 1))
            else
                FAILED_SHA=$remote; FAILED_COUNT=1
            fi
            write_status failed "deploy of $remote exited $rc (attempt $FAILED_COUNT)" \
                "$remote" "$(state_read last-successful)"
            if (( FAILED_COUNT == FAILED_MAX )); then
                alert error "xasprep deploy of $remote failed $FAILED_COUNT times; watcher is backing off"
            fi
            ;;
    esac
    return 0
}

shutdown() {
    log "watcher stopping"
    write_status stopped "received a termination signal"
    exit 0
}

main() {
    mkdir -p "$LOG_DIR" "$STATE_DIR"
    [[ -d $REPO_CACHE ]] || die 2 "$REPO_CACHE missing; run ops/deploy.sh deploy --latest first"

    trap shutdown TERM INT
    log "watcher started (pid $$, every ${POLL_SECONDS}s +/- ${JITTER_SECONDS}s)"
    write_status starting "watcher started"

    while true; do
        # A tick must never be able to kill the loop.
        tick || warn "tick returned $?; continuing"
        sleep $(( POLL_SECONDS + (RANDOM % (2 * JITTER_SECONDS + 1)) - JITTER_SECONDS ))
    done
}

main "$@"
