# XASprep deployment manifest — drxas workstation

This manifest covers one isolated, watcher-driven application on the `drxas`
workstation. It authorizes nothing outside `/local/apps/xasprep`, port 5002,
loopback port 15002 during a deploy, and the `app-xasprep-*` screens. It does
not authorize any change to the Dr.XAS production, development, Slack, MCP,
watcher, cron, boot or PostgreSQL stacks, to drxas-hub, or to any other tenant
of the host, and no write to a Dr.XAS path, port, screen, database or secret.

## Identity

| Field | Value |
| --- | --- |
| Slug | `xasprep` |
| Owner | Jeffrey Huang |
| Repository | `git@github.com:Dr-XAS/XASprep` |
| Authorized branch | `main` |
| Host | `drxas.xray.aps.anl.gov` |
| Git identity | `~/.ssh/id_ed25519`, authorized as `jhuang165`, pinned by `git_ssh()` in `ops/lib.sh` |

## Allocation

```
/local/apps/xasprep/
  releases/<sha>/      immutable; each carries its own .venv and a built
                       frontend/dist (node_modules is removed after the build)
  current -> releases/<sha>
  data/                likes.json, the only mutable state         (0700)
    candidate/         a candidate's copy of it, only during a deploy
  state/               last-successful, activations, pinned, watch-status.json,
                       restart logs
  ops/                 lib.sh deploy.sh watch.sh boot.sh liveness.sh
                       watcher-liveness.sh check.sh, repo.git mirror,
                       env.live, env.candidate, env.build (optional), logs/
  .npm-cache/          npm's download cache, so a build never writes under $HOME
```

`/local/apps` carries a default POSIX ACL (`juanjuan.huang` read and write),
which the new tree inherits. `data/` is created 0700 by `umask 077` and holds
nothing sensitive, but stays owner-only like every other app's.

| Resource | Value |
| --- | --- |
| Live port | `5002`, bound `0.0.0.0` (lab-reachable) |
| Candidate port | `15002`, bound `127.0.0.1`, only during a deploy |
| Screens | `app-xasprep-web`, `app-xasprep-watch`; `app-xasprep-web-candidate` during a deploy |
| Health URL | `http://127.0.0.1:5002/healthz` → `200 {"ok":true}` (runs one xraylib lookup) |
| Runtime | `/usr/bin/python3` (3.9.25), per-release venv from `backend/requirements.txt`; gunicorn, 2 workers, started from `backend/` |
| Frontend build | node v22 from `~/miniconda3/envs/drxas-node22/bin`, prepended to PATH only; `npm ci && npm run build` in the release |
| Retention | newest 5 releases; `current` and the rollback target are never pruned |

Ports 5002 and 15002 were unallocated on the host and unclaimed in the hub's
webapps inventory at the time of deployment. 5002 is also the port the app's
own `app.py` and `vite.config.js` default to, so a local checkout and the
deployment agree.

## Configuration

No secret values live in git or in argv. `ops/env.live` is 0600 and holds only
the bind address and the data directory:

| Variable | Value |
| --- | --- |
| `XASPREP_DATA_DIR` | `data/` (the candidate's file says `data/candidate/`) |
| `XASPREP_HOST` / `XASPREP_PORT` | `0.0.0.0` / `5002` (candidate: `127.0.0.1` / `15002`) |

Both files are written by `write_env_file` in `ops/deploy.sh` on every deploy.
A variable added to them by hand lasts until the next push and then vanishes,
so settings belong in that function.

**Google Analytics** is a build-time setting, not a runtime one: the React
bundle reads `VITE_GA_MEASUREMENT_ID` when Vite builds it. It is off on this
host. To turn it on, write the ID to the optional build-settings file and
redeploy the current commit:

```bash
ssh drxas 'umask 077; printf "VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX\n" > /local/apps/xasprep/ops/env.build'
ssh drxas '/local/apps/xasprep/ops/deploy.sh deploy $(cat /local/apps/xasprep/state/last-successful)'
```

The second command rebuilds the release directory (a deploy of a SHA whose
release is already complete reuses it, so remove
`releases/<sha>/.build-complete` first, or push any commit instead).
`build_frontend` takes only that one variable from the file, by name; nothing
else in it reaches the build. `deploy.sh status` reports `analytics on|off`.
Removing the file and redeploying turns it off again.

## State

`data/likes.json` is the app's only mutable state: a counter of the thumbs-up
button, `{"count": N}`. `XASPREP_DATA_DIR` points the release at it, so a
deploy does not reset it. A candidate gets a copy in `data/candidate/`, which
is deleted after the health check either way. There is nothing to back up.

## Deploy contract

1. Take the deploy lock; resolve the revision; refuse anything not an ancestor
   of `origin/main`.
2. Build into a new release directory: `git archive` of the commit, a venv from
   `backend/requirements.txt` (the `xraylib` wheel installs cleanly for
   Python 3.9 on this host), then `npm ci && npm run build` under `frontend/`
   with node 22 and, if present, the Analytics ID from `ops/env.build`. Then
   import the app once against a scratch data directory. Any failure deletes
   the directory and stops. Build output goes to `ops/logs/build-<sha>.log`.
3. Copy `likes.json` into `data/candidate/`, start a candidate on
   `127.0.0.1:15002` against that copy, and require `/healthz` to say
   `"ok":true` and `/` to answer 200 (a build whose `dist/` went missing would
   pass the first and fail the second). The copy is deleted either way.
4. Only then swap `current` by `rename(2)` and restart `app-xasprep-web`.
5. Re-check health. A failure here rolls back to the previous release.
6. Record `last-successful` and append to `state/activations` last; the
   watcher compares against the first, and a rollback walks back the second.

Dr.XAS listeners (3000, 8000, 3001, 8001, 6969, 3004) are snapshotted before
and after every deploy; a change raises a critical alert. The exception is a
change while a Dr.XAS deploy was running, which restarts those listeners
itself: that is logged as a warning. The deploy tells by reading the mtime of
`/local/drxas-ops/state/{dev,prod}-deploy.lock` and whether `/proc/locks`
shows either held. It never opens or locks them.

The `ops/` scripts live at `/local/apps/xasprep/ops/`, outside every release,
and a deploy does not refresh them — deliberately, since the deploy script
replacing itself mid-run is how a half-written change takes down the thing
that would fix it. Pushing a change under `ops/` therefore has no effect on the
host until it is copied there by hand:

```bash
scp ops/<script>.sh drxas:/local/apps/xasprep/ops/<script>.sh.new
ssh drxas 'mv -f /local/apps/xasprep/ops/<script>.sh.new \
                 /local/apps/xasprep/ops/<script>.sh'
```

The staged name and `mv` keep a script from being read while half-written.

## Watcher and durability

`watch.sh` polls `git ls-remote` every 60s ±15s and compares the remote tip
against `last-successful`, not against a checked-out tree. It writes
`state/watch-status.json` on every tick including failures, and a separate
heartbeat file. It never exits on a network error. A SHA that fails three
times is marked blocked rather than retried on a timer, and an error alert
is written when it gives up.

Three cron entries, appended as a namespaced block to the operator's crontab
(backed up beforehand to `~/crontab.backup.before-xasprep.<stamp>`):

```
@reboot     ops/boot.sh              start what `current` points at; never deploys
*/5 * * * * ops/liveness.sh          restart the web screen if /healthz fails twice
*/5 * * * * ops/watcher-liveness.sh  restart the watcher if gone or heartbeat > 300s
```

Both liveness scripts stop after 3 restarts in 15 minutes, set
`state/liveness-halted` and alert, rather than restarting in a loop. Nothing
starts while that file exists, boot included; remove it once the cause is
understood. `watcher-liveness.sh` also raises an error alert when `main` has
been ahead of the deployed commit for 30 minutes without a pin.
`ops/lib.sh` exports its own PATH including `/usr/sbin`, so `ss` resolves under
cron regardless of where these lines sit in the shared crontab.

Every screen operation asserts the name matches `app-xasprep-*`. There is no
broad process match anywhere in this codebase.

The Dr-XAS ops sentinel (`/local/ops-agent`, screen `drxas-opsagent`) watches
the app from outside it, observe only, through the `xasprep` row of
`opsagent/registry.yml`: `/healthz`, both screens, and `ops/check.sh`, which
fails for an hour after an error or critical alert, while the watcher is
blocked or failed, while liveness is halted, or when the watcher has not
ticked for ten minutes. Three failures in a row, about three minutes, post to
#ops. The sentinel has no deploy block for this app; deploys stay with
`watch.sh`.

## Outbound connections

The application itself makes none. The ops scripts reach `github.com` over
SSH (fetch and `ls-remote`, with one pinned key), and a build reaches the npm
and PyPI registries. Nothing else leaves the host. With Analytics enabled,
the visitor's browser loads `googletagmanager.com`; the server still does not.

## Rollback

```bash
ssh drxas /local/apps/xasprep/ops/deploy.sh rollback
ssh drxas /local/apps/xasprep/ops/deploy.sh unpin    # once main is fixed
```

Goes to the last release that went live before the current one, from
`state/activations`, skipping any directory that is not a complete build, and
health-checks it. It then writes `state/pinned`, and the watcher deploys
nothing while that file exists, so the rolled-away commit is not redeployed on
the next tick; a later push does not lift it either, because the bad commit is
still underneath. `deploy.sh unpin` does. A second rollback goes one release
further back. `deploy.sh deploy <sha>` by hand still works while pinned.

To stop automatic deploys without stopping the app, `touch
/local/apps/xasprep/state/pinned`; `deploy.sh unpin` resumes.

## Open items

1. Plain HTTP on the lab network, like every other app on the host.
2. The watcher fetches with the owner's personal SSH key, pinned with
   `IdentitiesOnly`, no agent and an empty SSH config, because the Dr-XAS
   organization has deploy keys disabled. If that changes, add one and point
   `XASPREP_DEPLOY_KEY` at it; nothing else changes.
3. `requirements.txt` pins the direct dependencies exactly, with numpy and
   scipy split on `python_version` because the host's Python 3.9 cannot take
   the builds that Python 3.12 and later need. Transitive packages float; a
   full freeze would close that gap.
4. Alerts are written to `ops/logs/alerts.log` and reach a person through the
   ops sentinel. Nothing in this directory sends a message itself.
