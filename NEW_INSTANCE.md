# NEW_INSTANCE.md — развёртывание Aerun с нуля

> **Статус:** актуально (2026-11-02). Стек: Go 1.27 + PocketBase v0.40.4 (встроен, отдельная установка не нужна) + React 19 + Node.js 20.19+/22.12+.
> Операционные команды (рестарт, бэкап, деплой) — в `RUNBOOK.md` и `DEPLOY.md`; конфигурация окружения — ниже.

---

## 1. Локальный запуск с нуля (без секретов)

1. **Клонировать и установить зависимости:**
   ```bash
   git clone https://github.com/SiJunma/aerun.git
   cd aerun && npm ci
   ```
2. **Запустить бэкенд** (первым, терминал держать открытым):
   ```powershell
   npm run dev:backend            # Windows (PowerShell); остановка: npm run dev:backend:stop
   # macOS/Linux:
   cd backend && go run ./cmd/aerun
   ```
   - Бэкенд слушает `127.0.0.1:8090`; готовность — `http://127.0.0.1:8090/api/aerun/health` возвращает `"status": "ok"`.
   - Первый запуск создаёт SQLite-базу в `backend/pb_data/`, применяет все миграции и печатает **одноразовый URL установщика суперадмина** (`/_/#/pbinstall/<token>`, живёт 30 минут) — открыть его в браузере и создать первого администратора. CLI-аргументы процесс отклоняет; `superuser upsert` недоступен — на свежей базе используйте installer URL (или удалите `pb_data/` для регенерации).
   - Порт 8090 занят — `npm run dev:backend` сам убьёт старый процесс; логи: `backend/.local-run/stdout.log` / `stderr.log`.
3. **Запустить фронтенд** (второй терминал): `npm run dev` → открыть адрес Vite (обычно `http://localhost:5173`); фронт по умолчанию ходит на `http://127.0.0.1:8090`.
4. Никаких `.env` и секретов для локального старта не требуется. Google OAuth опционален (§4).

## 2. Переменные окружения (`AERUN_*`)

Источник: `backend/.env.example` и `backend/internal/config/config.go`. Валидация жёсткая: невалидное значение = процесс не стартует.

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `AERUN_ENV` | `local` | `local` или `production` |
| `AERUN_LISTEN` | `127.0.0.1:8090` | Только loopback-IP; TLS — задача reverse proxy |
| `AERUN_DATA_DIR` | `./pb_data` | Каталог SQLite; рабочий каталог процесса важен |
| `AERUN_PUBLIC_URL` | `http://127.0.0.1:8090` | HTTP(S) origin; в production — только HTTPS |
| `AERUN_ALLOWED_ORIGINS` | — | Явный список CORS-origins, без wildcard |
| `AERUN_ENCRYPTION_KEY` | — | Ровно 32 байта; **обязателен** в production |
| `AERUN_MAIL_MODE` | `dashboard` | `disabled` / `dashboard` / `smtp` |
| `AERUN_SMTP_HOST` / `AERUN_SMTP_PORT` | — | SMTP-релей (при `AERUN_MAIL_MODE=smtp`) |
| `AERUN_SMTP_AUTH_METHOD` | `PLAIN` | Метод аутентификации SMTP |
| `AERUN_SMTP_TLS` | `false` | `true` = STARTTLS/TLS |
| `AERUN_SMTP_USERNAME` / `AERUN_SMTP_PASSWORD` | — | Учётка SMTP |
| `AERUN_MAIL_SENDER_ADDRESS` / `AERUN_MAIL_SENDER_NAME` | — / `Aerun` | Отправитель писем |
| `AERUN_GOOGLE_CLIENT_ID` / `AERUN_GOOGLE_CLIENT_SECRET` | — | Только парой; включает провайдер `google` (§4) |

Прод-минимум (см. `backend/deploy/README.md`): `AERUN_ENV=production`, `AERUN_LISTEN=127.0.0.1:8090`, `AERUN_PUBLIC_URL=https://<домен>`, `AERUN_ALLOWED_ORIGINS=https://<домен>`, `AERUN_DATA_DIR=<абсолютный путь>/pb_data`, `AERUN_ENCRYPTION_KEY=<32 случайных байта>`. Файл `.env` на VPS: mode 600, gitignored.

## 3. Production-развёртывание (VPS)

Топология и точные пути — в `backend/deploy/README.md` (Caddy, `aerun.service`, Caddyfile). Кратко:

1. VPS: user `deploy`, репозиторий `~/project`, Caddy терминирует TLS, бэкенд на `127.0.0.1:8090` под systemd.
2. Подготовить `.env` по §2 (production-минимум), `systemctl daemon-reload` при изменении юнита.
3. Первый старт: `sudo systemctl start aerun.service` — миграции применяются автоматически; открыть installer URL через туннель/логи и создать суперадмина.
4. Проверить health: локально `curl http://127.0.0.1:8090/api/aerun/health`, публично `https://<домен>/api/aerun/health`.
5. Дальнейшие обновления — только через `deploy.py` (`python deploy.py deploy --yes`), см. `DEPLOY.md`; конфиги Caddy/systemd держать в репозитории (`backend/deploy/`).

## 4. Google OAuth (опционально)

- Google Cloud Console → разрешённые redirect URI: `<AERUN_PUBLIC_URL origin>/api/oauth2-redirect` (локально `http://127.0.0.1:8090/api/oauth2-redirect`) + фронтенд-origins `http://localhost:5173`, `http://127.0.0.1:5173`.
- **Путь без кода (по умолчанию):** включить провайдер `google` в PocketBase admin UI (users → OAuth2) — рестарты ничего не затирают.
- **Путь через окружение:** задать пару `AERUN_GOOGLE_CLIENT_ID/SECRET` — тогда провайдер принудительно включается с этими credentials при каждом старте.
- Ограничения: email Google-аккаунта, которого нет в `users`, не саморегистрируется (профильные поля невыводимы из провайдера); импортированные/зарегистрированные аккаунты линкуются по email при первом входе. Парольный вход не затрагивается.

## 5. Чек-лист после первого старта

- [ ] `GET /api/aerun/health` → `"status": "ok"` (локально и, для прода, публично через Caddy)
- [ ] Суперадмин создан через installer URL; URL одноразовый
- [ ] Роли засеяны миграциями (`roles`: root/admin/… — seed), root-владелец определён
- [ ] Категории/группы созданы в админке; публичный форум открывается гостем
- [ ] Регистрация нового аккаунта отправляет верификационное письмо (или честно сообщает `mail_error` при выключенной почте)
- [ ] В production: `AERUN_ENCRYPTION_KEY` задан, `pb_data/` не в git и не в публичных бэкапах
