# Price Tracker — Real-Time Edition

A Telegram-driven price alert bot for crypto perpetuals and FX pairs, running on
Cloudflare Workers + Durable Objects + D1 for near-zero-latency alerts.

## Status

Migrating from the original GitHub Actions + polling version to a real-time,
WebSocket-driven Cloudflare architecture. See [MIGRATION.md](./MIGRATION.md).

## What it does

- Tracks crypto perpetual symbols (e.g. `BTCUSDT.P`) and FX pairs (e.g. `GBPUSD`)
- Symbols and price targets are managed entirely via Telegram commands
- Alerts fire the instant a target price is hit — no polling delay
- Auto-fails over to a backup data feed if the primary feed drops

## Doc map

| File | Purpose |
|---|---|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | What the system must do, and why |
| [SPECS.md](./SPECS.md) | How it's built — architecture, feeds, schema, deployment |
| [CLAUDE.md](./CLAUDE.md) | Shared context for any LLM working in this repo |
| [MIGRATION.md](./MIGRATION.md) | Old system vs new system, cutover plan |
| [CHANGELOG.md](./CHANGELOG.md) | Dated log of what changed |

## Stack

- Cloudflare Workers (separate Worker per concern)
- Durable Objects (one for crypto, one for FX)
- D1 (alert configs + state)
- Telegram Bot API (webhook-based)
- Data feeds: MEXC/Binance (crypto), Tiingo (FX), Twelve Data/Finnhub (FX fallback)

## Constraints

Strictly free-tier across every provider — no paid upgrades for now.

## Quick start

Not yet buildable — architecture and schema are still being finalized.
This section will be filled in once the first Worker is scaffolded.
