
import { initializeApp } from 'firebase/app';
import { getStorage, ref, listAll } from 'firebase/storage';

const firebaseConfig = {
    apiKey: "AIzaSyAmHHvhdJHNEz_ruuKWyDIeuVYMjITElQo",
    authDomain: "aerun-forum.firebaseapp.com",
    projectId: "aerun-forum",
    storageBucket: "aerun-forum.firebasestorage.app",
    messagingSenderId: "501549998830",
    appId: "1:501549998830:web:7596c64eba96454d1cc9ff"
};

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

async function listPossumSmiles() {
    console.log("Listing smiles from smiles/possum/...");
    const listRef = ref(storage, 'smiles/possum');

    try {
        const res = await listAll(listRef);
        console.log("Found folders:", res.prefixes.length);
        console.log("Found files:", res.items.length);
        
        const files = res.items.map(item => item.name);
        console.log(JSON.stringify(files, null, 2));
    } catch (error) {
        console.error("Error listing files:", error);
    }
}

listPossumSmiles();
