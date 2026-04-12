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

## Project Structure

- `src/bot`: Telegram handlers and message routing
- `src/ai`: OpenAI chat + intent parsing
- `src/db`: SQLite connection, migrations, repositories
- `src/scheduler`: reminder scheduler loop
- `src/config`: environment validation

