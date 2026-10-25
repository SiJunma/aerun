# Команды: что запустить и когда

Всё запускается из корня проекта (`forum-Aerun`). Без агентов, без магии.

## Локальная разработка (твой компьютер)

| Хочу... | Команда |
|---|---|
| Пересобрать бэкенд и перезапустить локальный сервер | `npm run dev:backend` |
| Остановить локальный сервер | `npm run dev:backend:stop` |
| Перезапустить без пересборки (поменял только фронт) | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-backend.ps1 -NoBuild` |
| Запустить фронт для разработки | `npm run dev` |
| Проверить, жив ли локальный бэкенд | открыть `http://127.0.0.1:8090/api/aerun/health` в браузере |

Локальный сервер: `backend/.local-run/aerun.exe`, логи — `stdout.log` / `stderr.log`
рядом. Порт `8090` занят? `npm run dev:backend` сам убьёт старый процесс.

## Деплой на VPS (прод, ветка `main`)

Сначала убедиться, что код запушен: `git push origin main`.
Потом одна из команд:

| Хочу... | Команда |
|---|---|
| Выкатить всё (фронт + бэкенд) | `python deploy.py deploy --yes` |
| Выкатить только фронт (без рестарта) | `python deploy.py deploy --only frontend --yes` |
| Выкатить только бэкенд (с рестартом) | `python deploy.py deploy --only backend --yes` |
| Залить без пересборки (уже собирал, повторить) | добавить `--skip-build` |
| Залить, но не рестартить сервис | добавить `--skip-restart` |
| Просто глянуть, жив ли прод | `python deploy.py health` (безопасно) |
| Состояние сервиса + какой коммит на VPS | `python deploy.py status` |
| Перезапустить сервис на VPS | `python deploy.py restart` |
| Подтянуть git на VPS без заливки | `python deploy.py sync` |

Через npm (то же самое): `npm run deploy:vps -- --yes`,
`npm run deploy:vps:frontend -- --yes`, `npm run deploy:vps:backend -- --yes`.

Скрипт сам: подтянет код, соберёт фронт (`VITE_POCKETBASE_URL` прод),
скомпилирует бэкенд под Linux, проверит что это ELF (не Windows),
зальёт по чанкам с проверкой sha256, распакует, перезапустит
`aerun.service` и проверит health локально, на VPS и публично.

## База данных на VPS (до релиза)

| Хочу... | Команда |
|---|---|
| Сделать бэкап базы | `python deploy.py db backup` |
| Применить миграции (рестарт, они сами) | `python deploy.py db migrate` |
| Восстановить базу из бэкапа | `python deploy.py db restore --file ~/project/pb_data-backup-<дата>.tgz` |

`db restore` спросит подтверждение и остановит сервис на время замены.

## Если что-то пошло не так

| Симптом | Что делать |
|---|---|
| `deploy.py health` говорит healthy, а сайт не открывается | проверить сертификат: скрипт терпит просроченный серт, а браузер — нет |
| `203/EXEC` в журнале сервиса | на VPS попал Windows-бинарник — запусти `deploy --only backend` заново, ELF-проверка не пропустит битый файл |
| Порт `8090` занят локально | `npm run dev:backend:stop`, потом `npm run dev:backend` |
| Заливка оборвалась на середине | запусти ту же команду ещё раз — чанки докачаются, а не зальются заново |
