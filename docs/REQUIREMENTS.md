# Requirements

## Goal

Near-zero-latency price alerts for crypto perpetuals and FX pairs, delivered via
Telegram, replacing the current polling-based (GitHub Actions) system.

## Scope

- **Crypto:** ~20 perpetual symbols, changeable at any time (not a fixed list)
- **FX:** ~10 pairs, changeable at any time (not a fixed list)
- **Symbol format:** `BTCUSDT.P` style for crypto perps, `GBPUSD` style for FX
- All symbol and target management happens through Telegram — no manual file edits

## Latency

- Must be real-time (WebSocket push), not interval polling
- Crypto and FX both held to the same real-time standard

## Alerting behavior

- A tracked symbol can have: a high target only, a low target only, or both at once
- Alert fires the moment either target is breached
- No per-symbol custom logic — same rules apply to every symbol
- An alert fires a maximum of **5 times** per symbol, then stops sending new
  notifications and the symbol moves to the `/triggered` list
- No cooldown before the 5-fire limit; every breach check counts

## Telegram commands

- `track` — add a symbol + optional one-line note, with target(s)
- `list` — show all currently tracked symbols
- `remove` — stop tracking a symbol
- `edit` — change a symbol's target(s) or note
- `clear` — clear the chat screen
- `triggered` — show symbols that hit their 5-fire limit
- Messages use relevant emoji (e.g. a target emoji for alerts)
- Delivery via **webhook**, not polling

## Reliability

- **Crypto feed:** MEXC primary, auto-fallback to Binance on failure
- **FX feed:** Tiingo primary, auto-fallback to Twelve Data/Finnhub (REST) on failure
- Telegram notification sent when a feed goes down (not silent)
- Fallback is automatic, no manual intervention required

## Data retention

- Best-fit storage in D1 for alert configs and alert state
- Exact schema to be finalized in SPECS.md

## Deployment

- Separate Cloudflare Workers per concern (not one monolithic Worker)
- Staging environment required before production
- Cutover to the new system happens immediately once it's verified working
- Old GitHub Actions system retired after cutover (see MIGRATION.md)

## Constraints

- Strictly free-tier only: Cloudflare, MEXC, Binance, Tiingo, Twelve Data, Finnhub
- No paid upgrades, even if a limit gets tight, unless explicitly revisited

## Explicitly out of scope (for now)

- Paid data tiers of any kind
- A dedicated Telegram Mini App for viewing tracked symbols (deferred — to be
  discussed separately)
- Historical price logging / analytics beyond live alert state
