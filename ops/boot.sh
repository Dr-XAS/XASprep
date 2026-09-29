#!/bin/bash
# @reboot entry point. Brings this application, and only this application,
# back up after the workstation restarts.
#
# It starts what `current` already points at. It does not deploy: a reboot is
# the worst possible moment to also introduce new code, and the watcher picks
# up anything new within a minute anyway.

SCRIPT_NAME=boot
source "$(dirname "$(readlink -f "$0")")/lib.sh"

# /local is a local mount, but @reboot fires early and the app tree may not be
# mounted yet. Bounded wait, rather than failing the only automatic recovery
# path the host has.
wait_for_app_root() {
    local deadline=$((SECONDS + 120))
    while (( SECONDS < deadline )); do
        [[ -d $RELEASES_DIR && -L $CURRENT_LINK ]] && return 0
        sleep 5
    done
    return 1
}

main() {
    mkdir -p "$LOG_DIR" "$STATE_DIR" 2>/dev/null || true
    log "boot: waiting for $APP_ROOT"
    wait_for_app_root || die 1 "$CURRENT_LINK never appeared; nothing started"

    if halted; then
        alert error "xasprep did not start at boot: liveness-halted is set ($(state_read liveness-halted))"
        die 1 "liveness-halted present; refusing to start"
    fi

    local release sha
    release=$(readlink -f "$CURRENT_LINK") || die 1 "current is a broken symlink"
    sha=$(basename "$release")
    [[ -x "$release/.venv/bin/gunicorn" ]] || die 1 "release $sha has no venv; deploy by hand"
    [[ -f "$OPS_DIR/env.live" ]] || die 1 "$OPS_DIR/env.live missing; run ops/deploy.sh deploy --latest"

    log "boot: starting $sha on port $WEB_PORT"
    start_web_screen "$SCREEN_WEB" "$release" "$OPS_DIR/env.live" "$LOG_DIR/$SCREEN_WEB.log"

    screen_start "$SCREEN_WATCH" "$OPS_DIR" "$LOG_DIR/$SCREEN_WATCH.log" \
        /bin/bash "$OPS_DIR/watch.sh"

    # Not a health gate — the */5 liveness cron is the health gate. This is so
    # the boot log says something useful.
    sleep 20
    local status
    status=$(http_status "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 10)
    log "boot: health=$status watcher=$(screen_exists "$SCREEN_WATCH" && echo up || echo DOWN)"
    [[ $status == 200 ]] || alert warning "xasprep did not answer after reboot (got $status); liveness will retry"
    return 0
}

main "$@"
