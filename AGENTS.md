# AGENTS.md — guidance for AI coding agents

This file exists for tools that follow the AGENTS.md convention (Codex, OpenCode,
Kilo Code, Gemini CLI, Cursor, ...). **The canonical, maintained agent guide for
this repo is [CLAUDE.md](CLAUDE.md)**: read it in full. Everything below is a
pointer summary kept deliberately short so it cannot drift far.

## Non-negotiables

- **Load and checkpoint shared memory.** Run the exact SessionStart `memoryctl load`
  command (or, in a tool without hooks, `memoryctl load --repo "$PWD" --writer codex
  --session SESSION-ID` with one stable ID you keep for the session), read the full
  index, and load only relevant topics. Checkpoint every meaningful completed unit
  and before stop or compaction through staged `memoryctl begin` / `commit`
  transactions. Never edit canonical memory directly. Use `memoryctl no-op` only
  for a genuinely clean session, with a truthful reason.
- **Verify before claiming done.** There is no test suite: start the server, check
  `/healthz`, build the frontend if you touched it, and exercise what you changed.
- **A push to `main` is a deploy** to the group's workstation. Verify locally first.
- **Minimal, targeted diffs.**
- **Never commit a real Analytics measurement ID** or any secret; `frontend/.env.example`
  holds a placeholder only.
- **No AI-attribution footers** in commits or PR bodies.
- The code is the source of truth. If a doc disagrees, trust the code and fix the doc
  in the same change.
