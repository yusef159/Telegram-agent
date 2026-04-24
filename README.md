# Telegram AI Reminder Bot (Node.js + TypeScript)

A modular Telegram bot built with `telegraf` that supports:
- Natural AI conversations (OpenAI-backed)
- Natural-language reminders (e.g. "Remind me to check logs in 2 hours")
- SQLite persistence for sessions and reminders
- Background scheduler that sends reminders at due time

Timezone is fixed to `Asia/Jerusalem`.

## 1) Prerequisites

- Node.js 22+
- npm 10+
- Telegram bot token
- OpenAI API key

## 2) Install and configure

```bash
npm install
cp .env.example .env
```

Update `.env`:
- `TELEGRAM_BOT_TOKEN`
- `AI_API_KEY`

## 3) Run locally (development)

```bash
npm run dev
```

For a production-style local run:

```bash
npm run build
npm start
```

## 4) Docker deployment (ARM64 / Raspberry Pi)

```bash
cp .env.example .env
# edit .env with real values
docker compose up --build -d
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

## 5) GitHub Actions auto-deploy to Raspberry Pi

This repository includes a deployment workflow at `.github/workflows/deploy.yml`.
It triggers on pushes to `main` (and can also be run manually).

### Required GitHub secrets

- `TAILSCALE_AUTHKEY`: Tailscale auth key for GitHub Actions runner
- `PI_HOST`: Raspberry Pi Tailscale IP or MagicDNS hostname
- `PI_USER`: SSH user on the Raspberry Pi
- `PI_SSH_KEY`: private SSH key used by GitHub Actions
- `PI_PORT`: SSH port (usually `22`)
- `PI_APP_DIR`: absolute path on Pi where this repo lives

### One-time server setup

On your Raspberry Pi, clone this repository in `PI_APP_DIR`, create `.env`,
and verify Docker compose works:

```bash
cd /path/to/your/app
cp .env.example .env
# fill real TELEGRAM_BOT_TOKEN and AI_API_KEY
docker compose up --build -d
```

After that, every push to `main` will run build validation in GitHub Actions,
connect to your Tailnet, SSH into your Pi, pull latest changes, and restart
with Docker compose.

## Project Structure

- `src/bot`: Telegram handlers and message routing
- `src/ai`: OpenAI chat + intent parsing
- `src/db`: SQLite connection, migrations, repositories
- `src/scheduler`: reminder scheduler loop
- `src/config`: environment validation

