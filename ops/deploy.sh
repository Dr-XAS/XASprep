#!/bin/bash
# Build, health-check and activate a release of XASprep.
#
#   ops/deploy.sh deploy <sha>|--latest
#   ops/deploy.sh rollback
#   ops/deploy.sh unpin
#   ops/deploy.sh status
#
# The contract, in order:
#
#   1. take the deploy lock, resolve the approved revision
#   2. build into a NEW release directory (never mutate a live one): venv,
#      pip, the Vite frontend, then import the app once
#   3. start a candidate on a loopback-only port, against a copy of the data
#   4. require its health check to pass
#   5. swap `current` by rename(2), restart the live screen
#   6. re-check health, then record last-successful
#
# Anything that fails before step 5 leaves the running release untouched, so
# the previous release is always the rollback target. Mutable state — the
# likes counter — lives in data/ and is never inside a release.

SCRIPT_NAME=deploy
source "$(dirname "$(readlink -f "$0")")/lib.sh"

HEALTH_TRIES=30
HEALTH_SLEEP=2
KEEP_RELEASES=5
# A Vite build of this app takes about a minute; this is only so a hung npm
# cannot hold the deploy lock for good.
BUILD_TIMEOUT=900

# The candidate's own directory: a copy of likes.json and nothing else.
CAND_DIR="$DATA_DIR/candidate"

# Every release that went live, oldest first, one "<iso> <sha>" per line. A
# rollback walks back through this rather than taking the newest directory in
# releases/, which can be a build whose candidate was rejected.
ACTIVATIONS="$STATE_DIR/activations"
KEEP_ACTIVATIONS=20

# The environment every instance of this app runs with. Written to a 0600
# file rather than passed in argv, because `ps` is world-readable here.
#
# This function is the only place these settings can live durably: a deploy
# rewrites env.live from here every time, so a line added to that file by
# hand survives until the next push and then silently disappears.
write_env_file() {
    local dest=$1 host=$2 port=$3 role=${4:-live}
    local data=$DATA_DIR
    [[ $role == candidate ]] && data=$CAND_DIR
    cat <<ENV | atomic_write "$dest" 0600
XASPREP_DATA_DIR=$data
XASPREP_HOST=$host
XASPREP_PORT=$port
ENV
}

# write_build_file <sha> <dest> — which build a release is, for the record.
write_build_file() {
    local sha=$1 dest=$2 when count
    when=$(git_ssh --git-dir="$REPO_CACHE" log -1 --format=%cI "$sha" 2>/dev/null || true)
    count=$(git_ssh --git-dir="$REPO_CACHE" rev-list --count "$sha" 2>/dev/null || true)
    printf '{"sha": "%s", "count": "%s", "date": "%s"}\n' "$sha" "$count" "$when" \
        | atomic_write "$dest" 0644
}

# The Vite build. Runs with node22 from the conda environment prepended to
# PATH, and with the optional build settings from ops/env.build (the Google
# Analytics measurement ID) in its environment. `npm ci` installs exactly the
# lock file, into the release's own node_modules, which is deleted once
# dist/ exists: gunicorn serves dist/ and nothing at runtime needs node.
build_frontend() {
    local dest=$1 buildlog=$2
    [[ -x $NODE_BIN/node && -e $NODE_BIN/npm ]] \
        || { err "node not found at $NODE_BIN; set XASPREP_NODE_BIN"; return 1; }
    [[ -f $dest/frontend/package-lock.json ]] \
        || { err "frontend/package-lock.json missing; npm ci needs it"; return 1; }
    local ga=""
    if [[ -f $BUILD_ENV_FILE ]]; then
        # Only the one variable is taken from the file, by name. It is read
        # here rather than sourced so nothing else in it can reach the build.
        ga=$(sed -n 's/^VITE_GA_MEASUREMENT_ID=//p' "$BUILD_ENV_FILE" | head -1 | tr -d '"'"'"' ')
    fi
    if [[ -n $ga ]]; then
        log "frontend build with Google Analytics (${ga:0:2}...${ga: -3})"
    else
        log "frontend build with analytics off (no VITE_GA_MEASUREMENT_ID in $BUILD_ENV_FILE)"
    fi
    (
        cd "$dest/frontend" || exit 1
        export PATH="$NODE_BIN:$PATH"
        export VITE_GA_MEASUREMENT_ID="$ga"
        # npm's cache lives under HOME by default; keep it under the app so
        # cron's environment and a shared home make no difference.
        export npm_config_cache="$APP_ROOT/.npm-cache"
        export npm_config_update_notifier=false
        export CI=true
        timeout "$BUILD_TIMEOUT" npm ci --no-audit --no-fund \
            && timeout "$BUILD_TIMEOUT" npm run build
    ) >>"$buildlog" 2>&1 || return 1
    [[ -f $dest/frontend/dist/index.html ]] || { err "build produced no frontend/dist/index.html"; return 1; }
    rm -rf "$dest/frontend/node_modules"
    return 0
}

build_release() {
    local sha=$1 dest="$RELEASES_DIR/$sha" buildlog="$LOG_DIR/build-$sha.log"

    if [[ -f "$dest/.build-complete" ]]; then
        log "release $sha already built; reusing it"
        printf '%s\n' "$dest"
        return 0
    fi

    # A half-built directory from an interrupted run is not a release.
    [[ -d $dest ]] && { log "discarding incomplete release dir $sha"; rm -rf "$dest"; }

    log "building $sha into $dest"
    mkdir -p "$dest"
    git_ssh --git-dir="$REPO_CACHE" archive --format=tar "$sha" | tar -x -C "$dest" \
        || { rm -rf "$dest"; die 4 "could not extract $sha"; }

    write_build_file "$sha" "$dest/build.json"

    "$PYTHON_BASE" -m venv "$dest/.venv" \
        || { rm -rf "$dest"; die 4 "venv creation failed"; }
    "$dest/.venv/bin/pip" install --quiet --upgrade pip >>"$buildlog" 2>&1 || true
    "$dest/.venv/bin/pip" install --quiet -r "$dest/backend/requirements.txt" \
        >>"$buildlog" 2>&1 \
        || { rm -rf "$dest"; die 4 "pip install failed; see $buildlog"; }

    build_frontend "$dest" "$buildlog" \
        || { tail -30 "$buildlog" | sed 's/^/  build| /' >&2 || true
             rm -rf "$dest"; die 4 "frontend build failed on $sha; see $buildlog"; }

    # Import the app once before anything binds a port. A syntax error, a
    # missing dependency or a broken xraylib wheel should fail the build, not
    # the health check. Pointed at a scratch data dir so it cannot touch
    # likes.json.
    ( cd "$dest/backend" && XASPREP_DATA_DIR="$dest/.import-tmp" \
        "$dest/.venv/bin/python" -c "import app" ) >>"$buildlog" 2>&1 \
        || { rm -rf "$dest"; die 4 "the app does not import; see $buildlog"; }
    rm -rf "$dest/.import-tmp"

    touch "$dest/.build-complete"
    printf '%s\n' "$dest"
}

# wait_healthy <url> — 200 with a body that proves the app answered.
wait_healthy() {
    local url=$1 i status body
    for (( i = 1; i <= HEALTH_TRIES; i++ )); do
        status=$(http_status "$url" 5)
        if [[ $status == 200 ]]; then
            body=$(http_body "$url" 5)
            if [[ $body == *'"ok":true'* ]]; then
                log "healthy after ${i} attempt(s): $body"
                return 0
            fi
            warn "200 but unexpected body: $body"
        fi
        sleep "$HEALTH_SLEEP"
    done
    err "no healthy response from $url after $(( HEALTH_TRIES * HEALTH_SLEEP ))s (last status ${status:-none})"
    return 1
}

start_live() {
    local release=$1
    write_env_file "$OPS_DIR/env.live" "$WEB_HOST" "$WEB_PORT"
    restart_web "$SCREEN_WEB" "$release" "$OPS_DIR/env.live" "$LOG_DIR/$SCREEN_WEB.log" "$WEB_PID" "$WEB_PORT"
}

prune_releases() {
    local keep=$KEEP_RELEASES current_target back
    current_target=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
    back=$(rollback_target "$current_target")
    ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do
        [[ $old == "$current_target" ]] && continue
        [[ -n $back && $old == "$RELEASES_DIR/$back" ]] && continue
        log "pruning old release $(basename "$old")"
        rm -rf "$old"
    done
}

# A copy of the live data for the candidate to start on, so a candidate that
# is exercised on its loopback port cannot move the real likes counter.
prepare_candidate_data() {
    rm -rf "$CAND_DIR"
    (umask 077; mkdir -p "$CAND_DIR")
    [[ -f $LIKES_FILE ]] || return 0
    cp -p "$LIKES_FILE" "$CAND_DIR/likes.json"
}

activation_list() {
    [[ -f $ACTIVATIONS ]] && awk 'NF == 2 {print $2}' "$ACTIVATIONS" || true
}

# record_activation <sha> [<previous release dir>] — the first run with no
# history records what was live before it too, so that its very first
# rollback has somewhere to go.
record_activation() {
    local sha=$1 prev=${2:-}
    {
        if [[ -f $ACTIVATIONS ]]; then
            cat "$ACTIVATIONS"
        elif [[ -d $prev && $(basename "$prev") != "$sha" ]]; then
            printf '%s %s\n' "$(now_iso)" "$(basename "$prev")"
        fi
        printf '%s %s\n' "$(now_iso)" "$sha"
    } | tail -n "$KEEP_ACTIVATIONS" | atomic_write "$ACTIVATIONS" 0600
}

# rollback_target <current release dir> — the newest release that went live
# before the current one and is still on disk, complete.
rollback_target() {
    local current=$1 shas sha i
    mapfile -t shas < <(activation_list)
    for (( i = ${#shas[@]} - 1; i >= 0; i-- )); do
        sha=${shas[i]}
        [[ $RELEASES_DIR/$sha == "$current" ]] && continue
        [[ -f $RELEASES_DIR/$sha/.build-complete ]] || continue
        printf '%s\n' "$sha"
        return 0
    done
    return 0
}

# forget_after <sha> — drop the entries above the last <sha>, so a second
# rollback goes one further back instead of forward to the release the first
# one left.
forget_after() {
    local sha=$1
    [[ -f $ACTIVATIONS ]] || return 0
    awk -v s="$sha" '{ line[NR] = $0; if ($2 == s) last = NR }
                     END { for (i = 1; i <= last; i++) print line[i] }' "$ACTIVATIONS" \
        | atomic_write "$ACTIVATIONS" 0600
}

do_deploy() {
    local want=$1
    local before after deploys_before sha release prev

    deploys_before=$(drxas_deploy_state)
    before=$(drxas_snapshot)
    log "Dr.XAS listeners before: [$before]"

    refresh_git_mirror || die 3 "could not fetch $REPO_URL"

    if [[ $want == "--latest" ]]; then
        sha=$(remote_tip)
    else
        sha=$(git_ssh --git-dir="$REPO_CACHE" rev-parse "$want^{commit}" 2>/dev/null || true)
    fi
    [[ -n $sha ]] || die 4 "could not resolve revision: $want"

    # Only what is on the authorized branch may be deployed.
    git_ssh --git-dir="$REPO_CACHE" merge-base --is-ancestor "$sha" "refs/heads/$BRANCH" 2>/dev/null \
        || die 4 "$sha is not on origin/$BRANCH; refusing to deploy it"

    log "deploying $sha"
    # Its own exit, because set -e does not reach in here: with_lock runs this
    # function on the left of an ||.
    release=$(build_release "$sha") || exit $?
    prev=$(readlink -e "$CURRENT_LINK" 2>/dev/null || true)

    # --- candidate on a loopback port, before anything live is touched ---
    stop_web "$SCREEN_WEB_CAND" "$CAND_PID" "$CAND_PORT" || die 5 "could not free the candidate port $CAND_PORT; the running release was not touched"
    prepare_candidate_data || die 5 "could not copy the data for the candidate; the running release was not touched"
    write_env_file "$OPS_DIR/env.candidate" "$CAND_HOST" "$CAND_PORT" candidate
    start_web_screen "$SCREEN_WEB_CAND" "$release" "$OPS_DIR/env.candidate" "$LOG_DIR/$SCREEN_WEB_CAND.log" "$CAND_PID"

    if ! wait_healthy "http://$CAND_HOST:$CAND_PORT$HEALTH_PATH"; then
        stop_web "$SCREEN_WEB_CAND" "$CAND_PID" "$CAND_PORT" || true
        rm -rf "$CAND_DIR"
        tail -20 "$LOG_DIR/$SCREEN_WEB_CAND.log" 2>/dev/null | sed 's/^/  candidate| /' >&2 || true
        die 5 "candidate $sha failed its health check; the running release was not touched"
    fi
    # The page itself, not only the probe: a build whose dist/ went missing
    # would answer /healthz and serve nothing.
    local page
    page=$(http_status "http://$CAND_HOST:$CAND_PORT/" 10)
    if [[ $page != 200 ]]; then
        stop_web "$SCREEN_WEB_CAND" "$CAND_PID" "$CAND_PORT" || true
        rm -rf "$CAND_DIR"
        die 5 "candidate $sha answers /healthz but / returned $page; the running release was not touched"
    fi
    stop_web "$SCREEN_WEB_CAND" "$CAND_PID" "$CAND_PORT" || true
    rm -rf "$CAND_DIR"
    log "candidate $sha passed; swapping"

    # --- swap and restart the live screen ---
    ln -sfn "$release" "$CURRENT_LINK.new"
    mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"

    start_live "$release"

    if ! wait_healthy "http://127.0.0.1:$WEB_PORT$HEALTH_PATH"; then
        err "live health check failed after the swap"
        if [[ -n $prev && -d $prev ]]; then
            warn "rolling back to $(basename "$prev")"
            ln -sfn "$prev" "$CURRENT_LINK.new"
            mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
            start_live "$prev"
            wait_healthy "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" \
                && warn "rolled back to $(basename "$prev")" \
                || alert critical "xasprep is DOWN: $sha failed and the rollback to $(basename "$prev") also failed"
        else
            alert critical "xasprep is DOWN: $sha failed and there is no previous release"
        fi
        die 5 "deploy of $sha failed"
    fi

    after=$(drxas_snapshot)
    if ! drxas_unchanged "$before" "$after"; then
        if drxas_deploy_seen "$deploys_before" "$(drxas_deploy_state)"; then
            alert warning "Dr.XAS listeners changed during this xasprep deploy while a Dr.XAS deploy was running, which restarts them; not counted against this deploy"
        else
            alert critical "an xasprep deploy coincided with a change to Dr.XAS listeners; investigate before deploying again"
        fi
    fi

    # Success is recorded only now, which is what the watcher compares against.
    state_write last-successful "$sha"
    state_write last-successful-detail \
        "sha=$sha release=$release activated_at_utc=$(now_iso) port=$WEB_PORT"
    [[ $prev == "$release" ]] || record_activation "$sha" "$prev"
    log "activated $sha on port $WEB_PORT"

    prune_releases
    return 0
}

do_rollback() {
    local current back prev
    current=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
    back=$(rollback_target "$current")
    [[ -n $back ]] || die 4 "no earlier release that went live is still on disk; deploy one by hand with: deploy.sh deploy <sha>"
    prev="$RELEASES_DIR/$back"
    log "rolling back to $back"
    ln -sfn "$prev" "$CURRENT_LINK.new"
    mv -Tf "$CURRENT_LINK.new" "$CURRENT_LINK"
    start_live "$prev"
    wait_healthy "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" || die 5 "rollback target is not healthy"
    state_write last-successful "$back"
    state_write last-successful-detail \
        "sha=$back release=$prev activated_at_utc=$(now_iso) rolled_back=yes"
    forget_after "$back"
    state_write pinned "$(now_iso) pinned=$back rolled_back_from=$(basename "${current:-none}")"
    log "rolled back to $back and pinned it; automatic deploys wait for: deploy.sh unpin"
}

do_unpin() {
    pinned || { log "nothing is pinned"; return 0; }
    log "lifting the pin ($(state_read pinned)); the watcher deploys origin/$BRANCH on its next tick"
    rm -f "$PIN_FILE"
}

do_status() {
    printf 'app        xasprep\n'
    printf 'current    %s\n' "$(readlink -e "$CURRENT_LINK" 2>/dev/null || echo '<none>')"
    printf 'successful %s\n' "$(state_read last-successful)"
    printf 'remote     %s\n' "$(remote_tip 2>/dev/null || echo '<unreachable>')"
    printf 'web screen %s\n' "$(screen_exists "$SCREEN_WEB" && echo up || echo DOWN)"
    printf 'watcher    %s\n' "$(screen_exists "$SCREEN_WATCH" && echo up || echo DOWN)"
    printf 'port %-5s %s\n' "$WEB_PORT" "$(port_open "$WEB_PORT" && echo listening || echo CLOSED)"
    printf 'health     %s\n' "$(http_status "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 5)"
    printf 'analytics  %s\n' "$( [[ -f $BUILD_ENV_FILE ]] && grep -q '^VITE_GA_MEASUREMENT_ID=G-' "$BUILD_ENV_FILE" && echo on || echo off)"
    printf 'halted     %s\n' "$(halted && state_read liveness-halted || echo no)"
    printf 'pinned     %s\n' "$(pinned && state_read pinned || echo no)"
    printf 'rollback   %s\n' "$(rollback_target "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" | grep . || echo '<none>')"
}

main() {
    mkdir -p "$LOG_DIR" "$STATE_DIR" "$RELEASES_DIR" "$DATA_DIR"
    require_cmd git screen curl ss flock timeout tar

    case ${1:-status} in
        deploy)
            [[ -n ${2:-} ]] || die 2 "usage: deploy.sh deploy <sha>|--latest"
            with_lock deploy 0 do_deploy "$2"
            local rc=$?
            (( rc == 75 )) && { log "another deploy holds the lock"; return 75; }
            return "$rc"
            ;;
        rollback) with_lock deploy 60 do_rollback ;;
        unpin)    with_lock deploy 60 do_unpin ;;
        status)   do_status ;;
        *)        die 2 "unknown command: $1" ;;
    esac
}

main "$@"
