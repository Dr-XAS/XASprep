#!/bin/bash
# Shared helpers for every XASprep ops script. Sourced, never executed.
#
# Adapted from /local/apps/drxas-hub/ops/lib.sh. The house rules it enforces
# are the same ones, and they are load-bearing on this host:
#
#   * Screens are addressed by exact name, and only names matching
#     app-xasprep-*. `pkill -f gunicorn` or `pkill -f python` on this box
#     kills Dr.XAS production, Dr.XAS dev and the Slack backends. There is no
#     broad process match anywhere in this codebase and there must never be one.
#   * Every intra-host HTTP hop uses 127.0.0.1, never the hostname.
#   * Secrets never appear in argv (`ps` is world-readable on a shared box),
#     never in a log, and never in a file that is not 0600.
#   * Scripts are replaced by rename(2), never written in place, so a running
#     bash keeps reading the inode it started with.

set -Eeuo pipefail
umask 077

# `ss` lives in /usr/sbin, which is NOT on cron's default PATH. Without it
# every port probe here reports "closed", the liveness timers conclude the app
# is dead and restart a perfectly healthy server every five minutes. Setting
# it here means these scripts do not depend on where their cron lines sit.
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------

APP_ROOT=${XASPREP_APP_ROOT:-/local/apps/xasprep}

# Every destructive path in this codebase is rooted at APP_ROOT, which makes
# its shape a safety property rather than a style preference.
case $APP_ROOT in
    /*/*/*) ;;
    *) printf 'fatal: XASPREP_APP_ROOT must be an absolute path at least three levels deep, got: %s\n' "$APP_ROOT" >&2; exit 2 ;;
esac
case $APP_ROOT in
    */|*..*) printf 'fatal: XASPREP_APP_ROOT must not end in / or contain ..: %s\n' "$APP_ROOT" >&2; exit 2 ;;
esac

OPS_DIR="$APP_ROOT/ops"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
DATA_DIR="$APP_ROOT/data"
STATE_DIR="$APP_ROOT/state"
LOG_DIR="$OPS_DIR/logs"

# The app's only mutable state: the likes counter. Outside any release so a
# deploy cannot reset it.
LIKES_FILE="$DATA_DIR/likes.json"

# Build-time settings that are not in git: today only the Google Analytics
# measurement ID (VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX). Optional, 0600, read
# by build_release in deploy.sh. Absent means analytics off.
BUILD_ENV_FILE="$OPS_DIR/env.build"

REPO_URL=${XASPREP_REPO_URL:-git@github.com:Dr-XAS/XASprep.git}
REPO_CACHE="$OPS_DIR/repo.git"
BRANCH=${XASPREP_BRANCH:-main}

# Git access is pinned to one explicit key. The Dr-XAS organization has deploy
# keys disabled, so this is the operator's ordinary key rather than an app-only
# one, matching how Dr.XAS and drxas-hub fetch. Point XASPREP_DEPLOY_KEY at an
# app-only key if the organization ever allows one. cron need not set HOME, so
# fall back to passwd rather than dying on an unset variable.
APP_HOME=${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}
DEPLOY_KEY=${XASPREP_DEPLOY_KEY:-$APP_HOME/.ssh/id_ed25519}

SCREEN_WEB=app-xasprep-web
SCREEN_WATCH=app-xasprep-watch
SCREEN_WEB_CAND=app-xasprep-web-candidate

# gunicorn writes its master pid here, and stop_web reads it back.
WEB_PID="$STATE_DIR/web.pid"
CAND_PID="$STATE_DIR/candidate.pid"

# The live port, lab-reachable. The candidate port is bound only during a
# deploy, on loopback, and is never advertised.
WEB_HOST=0.0.0.0
WEB_PORT=5002
CAND_HOST=127.0.0.1
CAND_PORT=15002
HEALTH_PATH=/healthz
GUNICORN_WORKERS=2

# Dr.XAS listeners this app must never perturb. Probed before and after every
# deploy; a deploy that moves any of them is a failed deploy.
DRXAS_PORTS=(3000 8000 3001 8001 6969 3004)

# Each Dr.XAS deploy holds an flock on one of these for its whole run, and a
# Dr.XAS deploy restarts its own listeners. Read only, never locked from here.
DRXAS_DEPLOY_LOCKS=(/local/drxas-ops/state/dev-deploy.lock /local/drxas-ops/state/prod-deploy.lock)

PYTHON_BASE=${XASPREP_PYTHON:-/usr/bin/python3}

# Node for the Vite build. A conda environment that already exists on the
# host; it is only ever prepended to PATH, never written to. Nothing here runs
# `pip install` or `npm install -g` into it.
NODE_BIN=${XASPREP_NODE_BIN:-$APP_HOME/miniconda3/envs/drxas-node22/bin}

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Always stderr. Several helpers are called in command substitution to
# capture a path, and a log line on stdout would be captured along with it.
_emit() {
    local level=$1; shift
    printf '%s %-5s [%s] %s\n' "$(now_iso)" "$level" "${SCRIPT_NAME:-ops}" "$*" >&2
}
log()  { _emit info "$@"; }
warn() { _emit warn "$@"; }
err()  { _emit error "$@"; }

die() {
    local code=$1; shift
    err "$@"
    exit "$code"
}

require_cmd() {
    local c
    for c in "$@"; do
        command -v "$c" >/dev/null 2>&1 || die 2 "required command not found: $c"
    done
}

# --------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------

# Write stdin to a path by rename(2). A reader either sees the whole old file
# or the whole new one, never a half-written one.
atomic_write() {
    local dest=$1 mode=${2:-0600} tmp
    tmp=$(mktemp "${dest}.XXXXXX")
    cat >"$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$dest"
}

state_read() {
    local f="$STATE_DIR/$1"
    [[ -f $f ]] && cat "$f" || true
}

state_write() {
    local name=$1; shift
    printf '%s\n' "$*" | atomic_write "$STATE_DIR/$name" 0600
}

halted() { [[ -e "$STATE_DIR/liveness-halted" ]]; }

# A rollback pins the release it went back to. Without the pin the watcher
# sees origin/main ahead of last-successful on its next tick and deploys the
# commit that was just rolled away from. Only `deploy.sh unpin` lifts it.
PIN_FILE="$STATE_DIR/pinned"
pinned() { [[ -e $PIN_FILE ]]; }

halt() {
    state_write liveness-halted "$(now_iso) $*"
    err "HALTED: $*"
}

json_string() {
    local s=${1-}
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\t'/\\t}
    s=${s//$'\r'/}
    printf '"%s"' "$s"
}

json_field() {
    local key=$1 body
    body=$(cat)
    printf '%s' "$body" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

# --------------------------------------------------------------------------
# Locks
# --------------------------------------------------------------------------

# with_lock <name> <wait-seconds> <command...>
# Returns 75 (EX_TEMPFAIL) when the lock could not be taken, which every
# caller treats as "someone else is working", not as a failure.
with_lock() {
    local name=$1 wait=$2; shift 2
    local lockfile="$OPS_DIR/.$name.lock"
    touch "$lockfile" 2>/dev/null || true
    exec {lockfd}<>"$lockfile"
    if (( wait > 0 )); then
        flock -w "$wait" "$lockfd" || { exec {lockfd}>&-; return 75; }
    else
        flock -n "$lockfd" || { exec {lockfd}>&-; return 75; }
    fi
    local rc=0
    "$@" || rc=$?
    flock -u "$lockfd" || true
    exec {lockfd}>&-
    return "$rc"
}

lock_held() {
    local lockfile="$OPS_DIR/.$1.lock"
    [[ -f $lockfile ]] || return 1
    exec {probe}<>"$lockfile"
    if flock -n "$probe"; then
        flock -u "$probe"; exec {probe}>&-; return 1
    fi
    exec {probe}>&-; return 0
}

# --------------------------------------------------------------------------
# Git
# --------------------------------------------------------------------------
# The empty config file, disabled agent and IdentitiesOnly setting keep user
# or system SSH configuration from silently widening which credentials this
# application can present to GitHub; it offers exactly DEPLOY_KEY or nothing.
git_ssh() {
    local ssh_command
    # Return rather than die: callers run this inside command substitution with
    # stderr suppressed, so dying here would kill the watcher without a trace.
    [[ -f $DEPLOY_KEY && -r $DEPLOY_KEY ]] || return 2
    ssh_command=$(printf 'ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=%q' "$DEPLOY_KEY")
    GIT_SSH_COMMAND=$ssh_command git "$@"
}

refresh_git_mirror() {
    [[ -f $DEPLOY_KEY && -r $DEPLOY_KEY ]] \
        || { err "git key missing or unreadable: $DEPLOY_KEY"; return 1; }
    if [[ ! -d $REPO_CACHE ]]; then
        log "creating mirror at $REPO_CACHE"
        git_ssh clone --mirror "$REPO_URL" "$REPO_CACHE" >/dev/null 2>&1 \
            || die 3 "could not clone $REPO_URL"
    fi
    git_ssh --git-dir="$REPO_CACHE" fetch --prune origin \
        "+refs/heads/$BRANCH:refs/heads/$BRANCH" >/dev/null 2>&1 \
        || return 1
    return 0
}

remote_tip() {
    git_ssh --git-dir="$REPO_CACHE" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null \
        | awk 'NR==1{print $1}'
}

# --------------------------------------------------------------------------
# Screens — exact names only, always namespaced app-xasprep-*
# --------------------------------------------------------------------------

assert_own_screen() {
    case $1 in
        app-xasprep-*) ;;
        *) die 2 "refusing to touch screen not named app-xasprep-*: $1" ;;
    esac
}

screen_exists() {
    assert_own_screen "$1"
    screen -ls 2>/dev/null | grep -qE "[0-9]+\.$1[[:space:]]"
}

screen_quit() {
    assert_own_screen "$1"
    screen_exists "$1" || return 0
    screen -S "$1" -X quit >/dev/null 2>&1 || true
    local deadline=$((SECONDS + 20))
    while (( SECONDS < deadline )); do
        screen_exists "$1" || return 0
        sleep 1
    done
    warn "screen $1 did not quit within 20s"
    return 1
}

# screen_start <name> <cwd> <logfile> <command...>
#
# `bash -c`, not `bash -lc`: a login shell on this host runs
# /etc/profile.d/zzaps.sh, which sets the open-files limit to 1024, hard and
# soft, and nothing below it can raise that again. The Vite build opens more
# files than that and died of EMFILE three times in a row under a watcher
# that had been started through a login shell. Nothing here needs a profile:
# lib.sh sets PATH and every path is absolute.
screen_start() {
    local name=$1 cwd=$2 logfile=$3; shift 3
    assert_own_screen "$name"
    screen_exists "$name" && { warn "screen $name already exists; not starting a second"; return 0; }
    mkdir -p "$(dirname "$logfile")"
    screen -L -Logfile "$logfile" -dmS "$name" \
        bash -c "cd $(printf '%q' "$cwd") && exec $(printf '%q ' "$@")"
}

# The one command that runs the app, shared by deploy, boot and liveness so
# they cannot drift apart. gunicorn is started from the release's backend/
# directory, where app.py and core.py live; Flask resolves ../frontend/dist
# from there. The env file carries the bind address and the data directory.
#
# gunicorn is not exec'd. It treats SIGHUP as "reload the workers", so when a
# screen is quit and the pty hangs up, an exec'd gunicorn reloads, is adopted
# by init and keeps the port: the first deploy left its candidate serving on
# 15002 with no screen around it. The wrapper stays as the child's parent,
# turns the hangup into a SIGTERM to gunicorn, and waits for it to leave. The
# pid file is the second line of defence: stop_web reads it and terminates
# the master directly, whether or not a screen still exists.
#
# web_command <release> <env-file> <pidfile>
web_command() {
    local release=$1 envfile=$2 pidfile=$3
    printf 'set -a; . %q; set +a; %q app:app --bind "$XASPREP_HOST:$XASPREP_PORT" --workers %q --pid %q --access-logfile - --error-logfile - & p=$!; trap %q HUP TERM INT; wait "$p"; wait "$p"' \
        "$envfile" "$release/.venv/bin/gunicorn" "$GUNICORN_WORKERS" "$pidfile" 'kill -TERM "$p" 2>/dev/null'
}

# start_web_screen <screen> <release> <env-file> <logfile> <pidfile>
start_web_screen() {
    local name=$1 release=$2 envfile=$3 logfile=$4 pidfile=$5
    screen_start "$name" "$release/backend" "$logfile" bash -c "$(web_command "$release" "$envfile" "$pidfile")"
}

# A process is ours only if its command line names a gunicorn inside this
# app's releases directory. Checked before any signal is sent to a pid read
# from a file or found on a port, so a recycled pid or a stranger who took
# the port is never signalled. This is the only process match in the
# codebase, and it is by our own path, never by a name.
pid_is_ours() {
    local pid=$1 cmd
    [[ $pid =~ ^[0-9]+$ ]] || return 1
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || return 1
    [[ $cmd == *"$RELEASES_DIR/"*gunicorn* ]]
}

# The gunicorn masters listening on one of our ports, for the case where the
# pid file is gone: an orphan from a screen that was quit by hand, or from a
# release older than the pid files.
port_masters() {
    local pid
    for pid in $(ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
        # Workers share the socket; only the master's parent is not gunicorn.
        pid_is_ours "$pid" || continue
        pid_is_ours "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" && continue
        printf '%s\n' "$pid"
    done
}

# stop_web <screen> <pidfile> <port> — stop one instance of the app for good:
# the screen, the master named in the pid file, and anything of ours still
# holding the port. Returns once the port is free or gives up after 30s.
stop_web() {
    local name=$1 pidfile=$2 port=$3 pid deadline
    screen_quit "$name" || true
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ $pid =~ ^[0-9]+$ ]] && pid_is_ours "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
    fi
    for pid in $(port_masters "$port"); do
        warn "gunicorn $pid still holds port $port outside its screen; terminating it"
        kill -TERM "$pid" 2>/dev/null || true
    done
    deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        port_open "$port" || { rm -f "$pidfile"; return 0; }
        sleep 1
    done
    for pid in $(port_masters "$port"); do
        warn "gunicorn $pid ignored SIGTERM for 30s; killing it"
        kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 1
    rm -f "$pidfile"
    port_open "$port" && { err "port $port is still held after stop_web"; return 1; }
    return 0
}

# restart_web <screen> <release> <env-file> <logfile> <pidfile> <port>
restart_web() {
    local name=$1 release=$2 envfile=$3 logfile=$4 pidfile=$5 port=$6
    stop_web "$name" "$pidfile" "$port" || return 1
    start_web_screen "$name" "$release" "$envfile" "$logfile" "$pidfile"
}

# --------------------------------------------------------------------------
# HTTP and ports
# --------------------------------------------------------------------------
http_status() {
    local code
    code=$(curl -s -o /dev/null -m "${2:-10}" -w '%{http_code}' "$1" 2>/dev/null) || true
    printf '%s' "${code:-000}"
}

http_body() {
    curl -s -m "${2:-10}" "$1" 2>/dev/null || true
}

port_open() {
    ss -ltnH 2>/dev/null | grep -q ":$1 "
}

# --------------------------------------------------------------------------
# Neighbours
# --------------------------------------------------------------------------

# Which Dr.XAS ports are listening right now. Compared before and after a
# deploy so this app can prove it did not disturb the host's other tenants.
drxas_snapshot() {
    local p out=""
    for p in "${DRXAS_PORTS[@]}"; do
        port_open "$p" && out+="$p "
    done
    printf '%s\n' "${out% }"
}

drxas_unchanged() {
    local before=$1 after=$2
    [[ $before == "$after" ]] && return 0
    err "Dr.XAS listeners changed across this operation: before [$before] after [$after]"
    return 1
}

# Whether a Dr.XAS deploy is running, and when one last started: per lock,
# its mtime and whether /proc/locks shows it held. Two of these taken around
# an operation differ, or show a lock held, exactly when a Dr.XAS deploy
# overlapped it. /proc/locks rather than trying the lock: the Dr.XAS deploy
# scripts take it non-blocking and defer when they cannot, so a probe from
# here that held it for an instant could turn a push into a skipped deploy.
drxas_deploy_state() {
    local f dev ino mtime key held out=""
    for f in "${DRXAS_DEPLOY_LOCKS[@]}"; do
        if ! read -r dev ino mtime < <(stat -c '%d %i %.9Y' "$f" 2>/dev/null); then
            out+="$f:absent "
            continue
        fi
        key=$(printf '%02x:%02x:%s' $(( (dev >> 8) & 0xfff )) \
            $(( (dev & 0xff) | ((dev >> 12) & 0xfff00) )) "$ino")
        held=free
        if awk -v k="$key" '$6 == k || $7 == k { f = 1 } END { exit !f }' /proc/locks 2>/dev/null; then
            held=held
        fi
        out+="$f:$mtime:$held "
    done
    printf '%s\n' "${out% }"
}

drxas_deploy_seen() {
    local before=$1 after=$2
    [[ $before != "$after" || $before == *:held* || $after == *:held* ]]
}

# --------------------------------------------------------------------------
# Alerts — the log is the channel. ops/check.sh fails for an hour after an
# error or critical line lands here, which is how one reaches a person.
# --------------------------------------------------------------------------
alert() {
    local level=$1; shift
    _emit "$level" "ALERT: $*"
    printf '%s %s %s\n' "$(now_iso)" "$level" "$*" >>"$LOG_DIR/alerts.log" 2>/dev/null || true
}
