# Migration: GitHub Actions → Cloudflare Workers

## Old system

- GitHub Actions workflow on a schedule (5-min native + external cron for
  faster ~1-2 min checks via `repository_dispatch`)
- Python script (`scripts/price_alert.py`) polling REST APIs
- State stored in JSON files in the repo (`alerts.json`, `alert_state.json`,
  `telegram_offset.json`)
- Telegram via polling (`getUpdates`)
- Feeds: Twelve Data + Finnhub (FX), MEXC + Binance (crypto), all REST

## New system

- Cloudflare Workers + Durable Objects, WebSocket-driven, real push updates
- State stored in D1, not JSON files in the repo
- Telegram via webhook
- Feeds: MEXC/Binance WebSocket (crypto), Tiingo WebSocket (FX), with
  Twelve Data/Finnhub REST kept as fallback only

## What changes for the user

- Alerts fire instantly instead of within a 1-5 min polling window
- New commands: `clear`, `triggered` (in addition to existing track/list/
  remove/edit)
- Alerts stop after 5 fires per symbol instead of firing indefinitely

## What stays the same

- Symbol tracking and target-setting workflow via Telegram
- Free-tier-only constraint
- Fallback philosophy (always have a backup feed)

## Cutover plan

1. Build the new system fully in a staging environment
2. Verify feed accuracy and alert timing against the old system running in
   parallel
3. Once verified working, cut over immediately — no extended parallel-run
   period
4. Retire the GitHub Actions workflow and delete the old JSON state files
   after cutover is confirmed stable

## Rollback

If the new system fails after cutover, the GitHub Actions workflow files
should not be deleted until the new system has run cleanly for a reasonable
period — keep them available for a quick revert until then.
