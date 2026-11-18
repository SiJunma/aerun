> ⚠️ **ОТРЕДАКТИВНО / LEGACY FIREBASE**
> Этот файл описывает синхронизацию стикеров через **Firebase Storage**, что больше не актуально.
> Проект переведён на **Go 1.27 + PocketBase (SQLite)**.
> **Не использовать как руководство для текущих задач.**
> Актуальная документация: `backend/README.md`, `backend/tools/migration/README.md`.

# Updating Smiles & Stickers Maintenance Guide [ОТРЕДАКТИВНО / LEGACY FIREBASE]

This guide describes how to synchronize sticker packs (smiles) in the forum editor with assets stored in Firebase Storage.

## Prerequisites
- Node.js installed locally.
- Access to the Firebase project's Storage bucket.
- The sticker set must be public and reachable via the Firebase Storage REST API (e.g., in the `smiles/` directory).

## Steps for AI Assistant

### 1. List Files
Get the list of files in the target folder:
```powershell
# Example for jcdragon
# (Currently manual or via a script using fetch on the storage API)
```

### 2. Fetch Download Tokens
Firebase Storage files require a `downloadToken` in the URL to bypass strict security or provide a consistent media link. Use a script to fetch metadata for each file:

```javascript
// Run via node -e
const fs = require('fs');
const names = fs.readFileSync('names.txt', 'utf8').split('\n').map(n => n.trim()).filter(n => n);
const bucket = 'aerun-forum.firebasestorage.app';

async function f() {
  const results = [];
  for (const name of names) {
    const encodedName = encodeURIComponent(name).replace(/%2F/g, '%2f');
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedName}`;
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      results.push({ name, token: data.downloadTokens });
    } catch (e) {
      console.error(`Failed for ${name}:`, e);
    }
  }
  fs.writeFileSync('tokens.json', JSON.stringify(results, null, 2));
}
f();
```

### 3. Generate Configuration
Map the fetched tokens to the `SMILE_PACKS` structure in `src/config/smiles.js`:

```javascript
// Run via node -e
const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));
const bucket = 'aerun-forum.firebasestorage.app';
const smiles = tokens.map(t => {
  const filename = t.name.split('/').pop();
  const codeName = filename.split('_')[1].split('.')[0];
  return {
    code: `[${codeName}]`,
    url: `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${t.name.replace(/\//g, '%2f')}?alt=media&token=${t.token}`
  };
});
console.log(JSON.stringify(smiles, null, 2));
```

### 4. Update Source Code
Update `src/config/smiles.js` with the generated array. Ensure the `id` and `name` of the pack match the storage folder name.

## Important Note on Naming
The forum's parser currently expects codes to start with the pack name (e.g., `[jcdragon...]`). Filenames should follow the pattern `index_packnameextra.gif` for this automation to work perfectly.
