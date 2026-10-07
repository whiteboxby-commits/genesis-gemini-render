# Genesis Extra — Gemini Live Render Proxy

Схема:

Tilda browser
    -> wss://YOUR-APP.onrender.com/gemini
    -> Gemini Live API

API key хранится только в Render Environment Variables и не попадает в Tilda.

## 1. GitHub

Положите в репозиторий:

- server.js
- package.json
- render.yaml
- .gitignore
- .env.example
- README.md

## 2. Render

Создайте Web Service из GitHub-репозитория.

Recommended:
- Region: Frankfurt
- Build Command: npm install
- Start Command: npm start

Environment Variables:
- GEMINI_API_KEY = новый API key
- GEMINI_MODEL = gemini-3.8-live
- GEMINI_VOICE = Puck
- GEMINI_LANGUAGE = ru-RU
- ALLOWED_ORIGINS = https://YOUR-DOMAIN.COM,https://www.YOUR-DOMAIN.COM

После deploy:

https://YOUR-APP.onrender.com/health

должен вернуть JSON с ok=true.

WebSocket:

wss://YOUR-APP.onrender.com/gemini

## 3. Tilda

Удалите из клиентского JavaScript:

- API_KEY
- прямой Google WS_URL
- отправку setup из браузера

Вместо них используйте:

const PROXY_WS_URL = "wss://YOUR-APP.onrender.com/gemini";

Клиент подключается к Render. Render сам открывает Gemini Live-сессию и отправляет setup.

## Важно

Не коммитьте API key в GitHub и не вставляйте его в HTML/Tilda.
