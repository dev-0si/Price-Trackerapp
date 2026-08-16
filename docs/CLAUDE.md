# CLAUDE.md

Shared context for any LLM (Claude, or otherwise) working in this repository.
Read this first. It links to the documents that hold the real detail —
don't duplicate their content here, keep this file as a map and a status line.

## What this project is

A real-time price alert bot (crypto perps + FX) delivered via Telegram, built
on Cloudflare Workers + Durable Objects + D1. Full detail in
[README.md](./README.md), [REQUIREMENTS.md](./REQUIREMENTS.md), and
[SPECS.md](./SPECS.md).

## Current phase

Docs and architecture decisions are being finalized before any code is
written. No Worker, DO, or D1 schema exists yet. See CHANGELOG.md for the
latest state.

## Conventions

- One concern per Worker — do not merge crypto, FX, and Telegram logic into
  a single Worker
- Symbol format is fixed: `BTCUSDT.P` (crypto perps), `GBPUSD` (FX) — validate
  on input, don't silently accept other formats
- No per-symbol custom alert logic — all symbols follow the same rules
- Free tier only across every external provider — flag it clearly if a change
  would require a paid tier, don't silently assume it's fine
- Staging must exist and be used before anything touches production

## Where things live (once scaffolded)

- `/workers/crypto/` — Crypto Worker + Durable Object
- `/workers/fx/` — FX Worker + Durable Object
- `/workers/telegram/` — Telegram Worker (webhook + commands)
- `/docs/` — this file and its siblings

(Folder structure not yet created — update this section once it exists.)

## Rules for working in this repo

- Don't invent scope beyond what's in REQUIREMENTS.md — if something seems
  missing, flag it as a question rather than assuming an answer
- Keep REQUIREMENTS.md, SPECS.md, and CLAUDE.md in sync when a decision
  changes — stale docs are worse than no docs
- Log meaningful changes in CHANGELOG.md
