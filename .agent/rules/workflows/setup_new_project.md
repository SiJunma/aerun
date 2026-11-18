---
description: how to deploy a new Aerun Forum instance
---

> ⚠️ **ОТРЕДАКТИВНО / LEGACY FIREBASE**
> Этот файл описывает развёртывание нового проекта на **Firebase**, которое больше не актуально.
> Проект переведён на **Go 1.27 + PocketBase (SQLite)**.
> **Не использовать как руководство для текущих задач.**
> Актуальная документация: `DEPLOY.md`, `backend/deploy/README.md`.

# Setup a New Aerun Forum Instance [ОТРЕДАКТИВНО / LEGACY FIREBASE]

Follow these steps to deploy and initialize a new forum instance from scratch.

## 1. Firebase Project Setup
1. Create a new project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication**:
   - Go to **Authentication > Sign-in method**.
   - Enable **Google** as a provider.
   - Configure a support email (your email).
3. Create a **Firestore Database** and choose a location.
4. (Optional) Enable **Firebase Storage** if you need avatar uploads.
5. Create a **Web App** in the project settings and copy the configuration.

## 2. Environment Configuration
Create a `.env.production` (or `.env.development`) file with your Firebase keys:
```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_ADMIN_EMAIL=your_email@gmail.com
```

## 3. Deployment
Run the following commands to build and deploy:
```powershell
npm run build:prod
firebase deploy --only "hosting,firestore" --project your_project_id
```

## 4. Initialization
1. Visit your deployed URL.
2. Log in using the **Admin Email** specified in your `.env` file.
3. The system will automatically:
   - Create default **Roles** (Admin, Moderator, Player, Spectator).
   - Create **Global Settings** (Forum Name, Backgrounds, etc.).
4. Go to the `/admin` panel to create your first **Categories** and **Groups**.

## 5. Security Rules
Ensure your `firestore.rules` and `storage.rules` are deployed:
```powershell
firebase deploy --only firestore:rules,storage:rules
```

## 6. Managing Smiles & Stickers
To add or update sticker packs in the editor:
1. Upload your `.gif` or `.png` files to a folder in Firebase Storage under `smiles/` (e.g., `smiles/jcdragon/`).
2. Ensure the files have public read access in `storage.rules`.
3. Update `src/config/smiles.js` by adding a new pack object to `SMILE_PACKS`.
4. For each sticker, provide a `code` (e.g., `[jcdragon]`) and its public `url` (including the `token` parameter if necessary).
5. (Optional) Use the AI Maintenance Guide at `.agents/maintenance/updating_smiles.md` to automate the URL and token retrieval if you have many files.
