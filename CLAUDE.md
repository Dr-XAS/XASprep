# XASprep (EasyXASCalc) — repository guide

XASprep is the Dr-XAS group's X-ray attenuation calculator: enter a chemical
formula, density and edge, get absorption, attenuation length and the sample
thickness that optimizes an XAS measurement. A Flask API over `xraylib` on the
server, a React + Vite single page on the client, and a Jupyter notebook GUI
of the same physics. The public copy runs on Render; the group's copy runs on
the `drxas` workstation.

This file is the canonical agent guide for the repo. `AGENTS.md` points every
other tool (Codex, OpenCode, Kilo Code, Gemini CLI, Cursor) at it. Keep it
accurate, code-focused, and free of secrets.

## Shared memory bridge

This repository uses the Mac-local shared memory bridge (project id `xasprep`);
Claude native auto-memory and Codex native memories are disabled. At every
session start, run the exact `memoryctl load` command emitted by the
SessionStart hook with its current writer and session ID, read the returned
`MEMORY.md` index in full, then read only relevant bodies with
`memoryctl read --repo "$PWD" --topic TOPIC-SLUG`. Treat that revision-bound
load as required context; reload before continuing if a hook reports newer
memory. In a tool with no hooks, pick one stable session ID for the whole
session and run `memoryctl load --repo "$PWD" --writer codex --session
SESSION-ID` yourself.

After every meaningful completed unit and before stopping or compacting, start
one focused lowercase kebab-case topic with `memoryctl begin --repo "$PWD"
--topic TOPIC-SLUG --operation upsert --writer WRITER --session SESSION-ID`.
Reuse an existing topic rather than creating a near-duplicate. Edit only the
staged `topic.md` and `pointer.txt`, never the canonical memory directory
(`~/.local/share/claude-project-memory/xasprep/memory/`). This repo has no
weekly or daily report targets, so a transaction carries just those two files.
Record the change and reason, absolute date, state (planned / built /
committed / deployed / uncommitted), branch, key files or functions,
verification, pending work, and non-obvious decisions; keep the pointer to
exactly one Markdown link and exclude secrets and transient narration. Commit
with `memoryctl commit TRANSACTION-ID`. On a stale revision, reload, reread,
and reconcile through a new transaction, never force-copy staged files. Use
`memoryctl no-op --repo "$PWD" --session SESSION-ID --reason "..."` only for a
genuinely clean session with a truthful reason.

Writers are `claude`, `codex`, and `pi`. OpenCode and Kilo Code use `codex`.
Diagnostics: `memoryctl status --repo "$PWD"` and `memoryctl doctor --repo
"$PWD"` are read-only. The operator guide is
`~/claude-tools/docs/shared-memory-bridge.md`.

## Architecture

- **`backend/app.py`** is the whole server: Flask, serving `../frontend/dist`
  as static files from `/`, plus `/healthz` (runs one xraylib lookup so it
  proves the library works, not only that the port is open), `POST
  /api/calculate` (formula, density, energy range → plot data through
  `core.MaterialAbs`), `GET /api/elements`, `POST /api/auto_edges` (the edges
  of every element in a formula within the energy window) and `GET|POST
  /api/likes`. The likes counter is the only mutable state; it lives in
  `XASPREP_DATA_DIR/likes.json`, which defaults to `backend/` for a local run
  and to `/local/apps/xasprep/data/` on the host.
- **`backend/core.py`** is the physics: `MaterialAbs` wraps xraylib to give
  mass attenuation, transmission and the thickness table; `formula_to_latex`
  is the label formatter. The notebook under `Jupyter_notebook/` imports the
  same code.
- **`frontend/`** is a Vite + React 19 app. `src/App.jsx` is the page;
  `src/analytics.js` reads `VITE_GA_MEASUREMENT_ID` at build time and stays
  silent when it is unset. API calls are relative (`/api/...`), so the built
  bundle works from wherever Flask serves it; `vite.config.js` proxies `/api`
  to `127.0.0.1:5002` for the dev server.

| Area | Where |
| --- | --- |
| Server, API | `backend/app.py` |
| Physics | `backend/core.py` |
| Client | `frontend/src/` |
| Notebook GUI | `Jupyter_notebook/` |
| Render build | `render-build.sh`, `DEPLOY.md` |
| Host operations (drxas) | `ops/*.sh` (`lib.sh` is sourced only) |
| Host authorization | `deploy/xasprep.manifest.md` |
| Design notes | `UI_DESIGN_GUIDE.md`, `web_design.md` |

## Running and verifying

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd backend && .venv/bin/python app.py            # http://127.0.0.1:5002, serves frontend/dist if built
cd frontend && npm ci && npm run dev             # http://127.0.0.1:5173, proxies /api to 5002
cd frontend && npm run build                     # writes frontend/dist for Flask to serve
curl -s http://127.0.0.1:5002/healthz            # {"ok":true}
```

There is no test suite. Verification means the server starts, `/healthz`
answers, `npm run build` succeeds when the frontend changed, and the changed
endpoint or screen works when exercised. `python3 -m py_compile backend/app.py`
is the fast syntax gate; `npm run lint` in `frontend/` is the other one.

## Deployment (a push is a deploy)

The group instance runs on the `drxas` workstation at
`drxas.xray.aps.anl.gov:5002`, rooted at `/local/apps/xasprep`, with the likes
file under `data/` outside every release. `ops/watch.sh` polls `origin/main`
and deploys each new commit through `ops/deploy.sh` (venv from
`backend/requirements.txt`, `npm ci && npm run build` with node 22, candidate
on loopback `15002` against a copy of the data, `/healthz` and `/` gates,
rename swap, screen restart). So **pushing to `main` deploys**: verify
locally first, and never push half-finished work to `main`. `deploy.sh
rollback` walks back `state/activations` and pins the result until `deploy.sh
unpin`. `ops/liveness.sh` and `ops/watcher-liveness.sh` are the cron
restarters, `ops/boot.sh` the `@reboot` entry, and `ops/check.sh` the
read-only "does it need a person" the ops sentinel polls. `ops/` is not
refreshed by a deploy: a change there reaches the host only when copied by
hand, as the manifest describes. Google Analytics is off on the host; the
manifest says how to turn it on with one file and a redeploy.
`deploy/xasprep.manifest.md` is the authorization document for the host: it
allows nothing outside that directory, ports 5002 and 15002, and the
`app-xasprep-*` screens. Do not widen it casually. The `xasprep-ops` skill
under `.claude/skills/` is the operator's runbook.

The public copy on Render (`easyxascalc.onrender.com`) builds with
`render-build.sh` and is separate from the workstation; see `DEPLOY.md`.

## Conventions

- **Minimal, targeted diffs.** Match the surrounding style; clean up orphans
  your change created; do not refactor or delete unrelated code unasked.
- **Comments say why**, not what. The ops scripts explain why a rule exists
  (why `ss` needs `/usr/sbin` on PATH, why `pkill` is banned on the host).
  Match that register.
- **Commit messages** are one plain-prose imperative sentence describing the
  change, sentence case, no ticket IDs.
- **No AI attribution, ever**: no footers, no co-author trailers, and no
  agent identity in the commit author or committer fields, in commits or PR
  bodies.
- Keep `frontend/.env.example` as the only place an Analytics ID is spelled
  in git, and only as a placeholder. A real measurement ID belongs in the
  Render environment or in `ops/env.build` on the host.
- The code is the source of truth. If this file or the README disagrees with
  the code, trust the code and fix the doc in the same change.

## Session hygiene

Keep each session scoped to one task. Once a unit is checkpointed through the
bridge, suggest `/clear` or a fresh session; memory carries the state forward.
