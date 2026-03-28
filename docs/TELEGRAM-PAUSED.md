# Telegram Channel — Paused

Telegram is disabled as of 2026-03-27. Only Discord is actively used.

## What was done

1. **`.env`** — `TELEGRAM_BOT_TOKEN` commented out (line preserved with `#` prefix)
2. **Railway production** — `TELEGRAM_BOT_TOKEN` variable deleted
3. **Railway dev** — was already unset

No code was changed. The channel factory in `src/channels/telegram.ts` returns `null` when no token is found, so it simply skips loading at startup.

## How to re-enable

1. Uncomment `TELEGRAM_BOT_TOKEN` in `.env` (remove the `#`)
2. Set it on Railway:
   ```bash
   railway variable set TELEGRAM_BOT_TOKEN=<token> --service nanoclaw --environment production
   ```
3. Restart or redeploy — Telegram will auto-load at startup
