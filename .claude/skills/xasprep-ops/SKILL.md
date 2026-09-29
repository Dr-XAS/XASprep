---
name: xasprep-ops
description: Operate the XASprep deployment on the drxas workstation - status, logs, deploy, rollback, watcher, analytics, and what never to touch
user-invocable: true
allowed-tools: Bash, Read, Grep
---

# XASprep on drxas — operator runbook

Everything here runs over `ssh drxas`. The app lives at `/local/apps/xasprep`
(`$A` below). Full authorization and design: `deploy/xasprep.manifest.md`.

| Thing | Value |
| --- | --- |
| Live | `http://drxas.xray.aps.anl.gov:5002` (bound 0.0.0.0) |
| Candidate | `127.0.0.1:15002`, only during a deploy |
| Screens | `app-xasprep-web`, `app-xasprep-watch` (+ `app-xasprep-web-candidate` briefly) |
| Health | `curl -s http://127.0.0.1:5002/healthz` → `{"ok":true}` |
| Cron | `@reboot boot.sh`, `*/5 liveness.sh`, `*/5 watcher-liveness.sh` (block `# BLOCK — XASprep`) |

## Look

```bash
ssh drxas '/local/apps/xasprep/ops/deploy.sh status'
ssh drxas 'cat /local/apps/xasprep/state/watch-status.json'
ssh drxas '/local/apps/xasprep/ops/check.sh'            # ok, or one line saying what needs a person
ssh drxas 'tail -50 /local/apps/xasprep/ops/logs/app-xasprep-web.log'
ssh drxas 'tail -50 /local/apps/xasprep/ops/logs/watch-deploy.log'
ssh drxas 'ls -t /local/apps/xasprep/ops/logs/build-*.log | head -1 | xargs tail -40'
ssh drxas 'tail /local/apps/xasprep/ops/logs/alerts.log /local/apps/xasprep/ops/logs/cron.log'
```

## Deploy, roll back, pause

A push to `main` deploys within about a minute; nothing else is needed. By hand:

```bash
ssh drxas '/local/apps/xasprep/ops/deploy.sh deploy --latest'     # or deploy <sha>
ssh drxas '/local/apps/xasprep/ops/deploy.sh rollback'            # previous live release, then pins
ssh drxas '/local/apps/xasprep/ops/deploy.sh unpin'               # resume automatic deploys
ssh drxas 'touch /local/apps/xasprep/state/pinned'                # pause auto-deploy, app keeps running
```

A blocked watcher (`"state":"blocked"`) means one SHA failed three times: read
the newest `build-<sha>.log`, push a fix, or deploy a SHA by hand.

## Halted

`state/liveness-halted` exists after three restarts in fifteen minutes. Nothing
restarts, boot included, until it is removed. Find the cause in the web log or
the watcher log first, then:

```bash
ssh drxas 'rm /local/apps/xasprep/state/liveness-halted && /local/apps/xasprep/ops/liveness.sh && /local/apps/xasprep/ops/watcher-liveness.sh'
```

## Google Analytics

Off by default. It is baked into the frontend bundle at build time, so it is a
file plus a rebuild, never a runtime flag:

```bash
ssh drxas 'umask 077; printf "VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX\n" > /local/apps/xasprep/ops/env.build'
ssh drxas 'rm -f /local/apps/xasprep/releases/$(cat /local/apps/xasprep/state/last-successful)/.build-complete; /local/apps/xasprep/ops/deploy.sh deploy $(cat /local/apps/xasprep/state/last-successful)'
```

Remove `env.build` and redeploy the same way to turn it off. `deploy.sh status`
shows `analytics on|off`.

## Updating the ops scripts

A deploy never touches `ops/`. Copy by staged name and rename, one script at a
time, never in place:

```bash
scp ops/lib.sh drxas:/local/apps/xasprep/ops/lib.sh.new && ssh drxas 'mv -f /local/apps/xasprep/ops/lib.sh.new /local/apps/xasprep/ops/lib.sh'
```

## Never

- `pkill`, `killall`, or any process match by name on drxas. Only `screen -S app-xasprep-… -X quit`.
- Touch `/local/Dr.XAS-*`, `/local/drxas-ops`, `/local/apps/drxas-hub`, any `drxas-*` screen, ports 3000/8000/3001/8001/6969/3004, or `~/.drxas_env`.
- `pip install` or `npm install -g` into `~/miniconda3/envs/*`; the build only prepends `drxas-node22/bin` to PATH.
- Edit the crontab outside the `# BLOCK — XASprep` section.
- Put a secret in argv, a log, git, or any file that is not 0600.
