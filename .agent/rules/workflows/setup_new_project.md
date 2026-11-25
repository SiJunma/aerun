---
description: how to deploy a new Aerun Forum instance
---

> ⚠️ **ОТРЕДАКТИВНО / LEGACY FIREBASE**
> Этот файл описывает развёртывание нового проекта на **Firebase**, которое больше не актуально.
> Проект переведён на **Go 1.27 + PocketBase (SQLite)**.
> **Не использовать как руководство для текущих задач.**
> Актуальная документация: `DEPLOY.md`, `backend/deploy/README.md`.

# Setup a New Aerun Forum Instance [ОТРЕДАКТИВНО / LEGACY FIREBASE]

> Этот файл оставлен как исторический артефакт. Всё его содержимое (Firebase, Firestore, `.env`-файлы с Firebase-ключами) больше не актуально: Firebase выведен из эксплуатации, а файлы `.env.development` / `.env.production` удалены из репозитория и не должны создаваться.
>
> Актуальное развёртывание нового инстанса: `DEPLOY.md`, `backend/deploy/README.md`. Секреты (MaxMind, Google OAuth2, SMTP) хранятся в БД и управляются через админку `/admin/secrets`, а не через `.env`-файлы.
