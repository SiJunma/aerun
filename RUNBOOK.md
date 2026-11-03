# RUNBOOK.md — операционный справочник

> **Статус:** актуально (2026-11-02). Команды деплоя — `DEPLOY.md`; развёртывание с нуля — `NEW_INSTANCE.md`.

## Локально

| Симптом / задача | Действие |
|---|---|
| Жив ли бэкенд | открыть `http://127.0.0.1:8090/api/aerun/health` → `"status": "ok"` |
| Перезапустить бэкенд | `npm run dev:backend` (сам убьёт старый процесс) |
| Остановить | `npm run dev:backend:stop` |
| Логи бэкенда | `backend/.local-run/stdout.log`, `stderr.log` |
| Порт 8090 занят | `npm run dev:backend:stop`, затем `npm run dev:backend` |
| Логи фронт-сборки | вывод `npm run dev` (Vite) |

## Прод (VPS)

| Задача | Команда |
|---|---|
| Жив ли прод | `python deploy.py health` (безопасно; терпит просроченный сертификат) |
| Статус сервиса + коммит на VPS | `python deploy.py status` |
| Перезапуск сервиса | `python deploy.py restart` |
| Логи сервиса | `ssh deploy@<vps> journalctl -u aerun.service -f` |
| Бэкап БД | `python deploy.py db backup` |
| Применить миграции | `python deploy.py db migrate` (рестарт; обычно не нужно — применяются при старте) |
| Восстановить БД | `python deploy.py db restore --file ~/project/pb_data-backup-<дата>.tgz` (спросит подтверждение, остановит сервис) |
| Подтянуть git без заливки | `python deploy.py sync` |

## Типовые инциденты

| Симптом | Что делать |
|---|---|
| `deploy.py health` ок, сайт не открывается | сертификат: скрипт терпит просроченный серт, браузер — нет |
| `203/EXEC` в журнале сервиса | на VPS попал Windows-бинарь — перезапустить `deploy --only backend` (ELF-проверка отсеет) |
| Красный CI-отчёт | `git fetch origin ci-report && git show origin/ci-report:report.json`; чинить, пушить, перечитать |
| Письма не уходят | `AERUN_MAIL_MODE`/SMTP-переменные; очередь: `GET /admin/outbox-events`, retry `POST /admin/outbox-events/{id}/retry` |
| Ошибки 5xx у пользователей | собрать `X-Request-ID` из ответа, искать в логах; ошибки несут `data.retryable` |

## Регламент

- Бэкап перед любыми ручными операциями с БД.
- Миграции руками не запускать без явной просьбы владельца.
- Секреты не выносить в чат/логи; `.env` и `pb_data` — вне репозитория и публичных бэкапов.
