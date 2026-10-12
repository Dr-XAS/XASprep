# AGENTS.md — guidance for AI coding agents

This file exists for tools that follow the AGENTS.md convention (Codex, OpenCode,
Kilo Code, Gemini CLI, Cursor, ...). **The canonical, maintained agent guide for
this repo is [CLAUDE.md](CLAUDE.md)**: read it in full. Everything below is a
pointer summary kept deliberately short so it cannot drift far.

## Non-negotiables

- **Verify before claiming done.** There is no test suite: start the server, check
  `/healthz`, build the frontend if you touched it, and exercise what you changed.
- **A push to `main` is a deploy** to the group's workstation. Verify locally first.
- **Minimal, targeted diffs.**
- **Never commit a real Analytics measurement ID** or any secret; `frontend/.env.example`
  holds a placeholder only.
- **No AI-attribution footers** in commits or PR bodies.
- The code is the source of truth. If a doc disagrees, trust the code and fix the doc
  in the same change.
