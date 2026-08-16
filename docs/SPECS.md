# Specs

Technical implementation detail for everything defined in REQUIREMENTS.md.

## Architecture overview

Three concerns, three Workers:

1. **Crypto Worker** — owns the Crypto Durable Object (MEXC/Binance WebSocket feeds)
2. **FX Worker** — owns the FX Durable Object (Tiingo WebSocket feed, REST fallback)
3. **Telegram Worker** — owns the Telegram webhook, command handling, and D1 access

All three share the same D1 database for alert configs and state.

## Durable Objects

- **Crypto DO** — holds WebSocket connection(s) to MEXC (primary) and Binance
  (fallback). Multiplexes all ~20 symbols over as few connections as the
  exchange API allows, rather than one socket per symbol.
- **FX DO** — holds WebSocket connection to Tiingo's firehose (primary),
  multiplexing all ~10 pairs over one connection. Falls back to REST polling
  (Twelve Data, then Finnhub) if the WebSocket feed is down.
- Each DO normalizes incoming ticks to a common shape:
  `{ symbol, price, source, timestamp }`
- Each DO runs its own reconnect/health-check logic via `alarm()`, independent
  of the other DO — a crypto feed outage doesn't affect FX and vice versa.

## Feed fallback logic

- **Crypto:** MEXC → Binance, automatic, no manual trigger
- **FX:** Tiingo (WebSocket) → Twelve Data (REST) → Finnhub (REST), automatic
- On any fallback trigger, send a Telegram notification that the primary feed
  is down and which backup is now active
- On primary feed recovery, switch back automatically (behavior to confirm
  when we build this — could auto-switch back or require manual confirm)

## D1 schema — draft, TBD

To be finalized in a dedicated schema session. Expected tables:

- `alerts` — symbol, asset type, high target, low target, note, created_at
- `alert_state` — symbol, fire_count, status (active/triggered), last_fired_at
- `feed_status` — feed name, current status (primary/fallback/down), last_checked

## Telegram integration

- **Delivery:** webhook (not polling) — Telegram Worker exposes an HTTP endpoint
  registered as the bot's webhook URL
- **Commands:** `track`, `list`, `remove`, `edit`, `clear`, `triggered`
  (see REQUIREMENTS.md for exact behavior of each)
- **Formatting:** emoji used for alert types (e.g. target emoji), consistent
  formatting across all message types
- **Symbol format:** `BTCUSDT.P` (crypto perps), `GBPUSD` (FX) — Telegram Worker
  validates format on `track`/`edit` before writing to D1

## Alert firing logic

- On each normalized tick, the owning DO checks D1 (or in-memory cache synced
  to D1) for that symbol's targets
- On breach: increment `fire_count`, send Telegram message, repeat on every
  subsequent breach check up to `fire_count = 5`
- At `fire_count = 5`: stop sending, set `status = triggered`, symbol now
  appears in `/triggered` instead of `/list`

## Deployment

- Separate `wrangler.toml` per Worker (crypto, FX, telegram) or one config with
  multiple named environments — decide when scaffolding starts
- **Staging environment** required: separate D1 database + separate Telegram
  bot (or test chat) before anything touches production
- Secrets (MEXC/Binance keys if needed, Tiingo key, Twelve Data key, Finnhub
  key, Telegram bot token) set via `wrangler secret put`, one set per environment
- CI: GitHub Actions triggers `wrangler deploy` on push to main (staging) and
  on a tagged release or manual approval (production) — exact trigger rule TBD

## Open items for future topics

- Full D1 schema (columns, indexes, migrations)
- Exact reconnect/backoff timing for WebSocket handlers
- Fallback-recovery behavior (auto-switch back vs. manual)
- Telegram Mini App (deferred)
