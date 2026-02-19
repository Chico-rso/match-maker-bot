# match-maker-bot

Telegram-бот для сбора игроков на матч через голосование в чате.

## Локальный запуск

1. Создать `.env` с `BOT_TOKEN`.
2. Установить зависимости:
   ```bash
   npm ci
   ```
3. Запустить:
   ```bash
   npm start
   ```

## CI/CD автодеплой (GitHub Actions)

В репозитории настроен workflow `.github/workflows/deploy.yml`:
- запускается при `push` в `main` и вручную (`workflow_dispatch`);
- копирует код на сервер через `rsync`;
- не перезаписывает `.env` и `bot.db`;
- запускает серверный скрипт `scripts/deploy.sh`, который делает `npm ci --omit=dev` и `pm2 restart bot`.

### Что добавить в GitHub

Repository `Settings -> Secrets and variables -> Actions`:

Secrets:
- `SSH_HOST` (например, `81.163.27.15`)
- `SSH_USER` (например, `root`)
- `SSH_PRIVATE_KEY` (приватный ключ для входа по SSH)

Variables (опционально):
- `SSH_PORT` (по умолчанию `22`)
- `DEPLOY_PATH` (по умолчанию `/root/match-maker-bot`)
- `PM2_APP_NAME` (по умолчанию `bot`)
