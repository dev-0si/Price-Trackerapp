# Changelog

## 2026-08-16

- Defined full scope for the Cloudflare Workers + D1 real-time upgrade
- Decided on split Durable Object architecture (crypto DO, FX DO)
- Chose data feeds: MEXC/Binance (crypto, WebSocket), Tiingo (FX, WebSocket),
  Twelve Data/Finnhub kept as REST fallback
- Finalized alerting rules: high/low targets (either or both), 5-fire limit
  before moving to `/triggered`
- Finalized Telegram command set: track, list, remove, edit, clear, triggered
- Decided on webhook-based Telegram delivery (replacing polling)
- Decided on separate Workers per concern, staging environment required,
  immediate cutover once verified
- Created initial doc set: README.md, REQUIREMENTS.md, SPECS.md, CLAUDE.md,
  MIGRATION.md, CHANGELOG.md
- No code written yet — D1 schema and reconnect/backoff details still open
