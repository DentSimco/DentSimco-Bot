// DentSimco - Ekonomi evresi botu
// Simcotools'tan güncel ekonomi evresini (resesyon / normal / boom) çeker
// ve Firestore'da system/phase dokümanına yazar.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const REALMS = [0, 1];
const API = (realm) => `https://api.simcotools.com/v1/realms/${realm}/phases`;
const LABELS = { recession: "Resesyon", normal: "Normal", boom: "Boom" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.log(`Deneme ${i}/4 başarısız (${url}): ${e.message}`);
      if (i < 4) await sleep(i * 3000);
    }
  }
  throw lastErr;
}

// En yeni başlangıçlı kaydı bulur (liste zaten en yeniden eskiye sıralı ama garantiye alıyoruz)
function newestRange(ranges) {
  return [...ranges].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON secret'ı bulunamadı.");
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();
const ref = db.doc("system/phase");

const stored = (await ref.get()).data() || {};
const now = Date.now();
const update = {};
let realm0Failed = false;

for (const realm of REALMS) {
  const key = `r${realm}`;
  try {
    const data = await getJson(API(realm));
    if (!Array.isArray(data.ranges) || data.ranges.length === 0) {
      throw new Error("Yanıtta evre listesi (ranges) yok");
    }
    const cur = newestRange(data.ranges);
    if (!LABELS[cur.phase]) throw new Error(`Bilinmeyen evre: ${cur.phase}`);

    // Güncel evrenin bitişi geçmişte kalmışsa Simcotools henüz yeni evreyi yayınlamamıştır.
    if (Date.parse(cur.end) <= now) {
      console.log(`Realm ${realm}: yeni evre henüz yayınlanmamış (son kayıt ${cur.end} tarihinde bitmiş). Sonraki denemede tekrar bakılacak.`);
      continue;
    }

    const old = stored[key];
    if (old && old.phase === cur.phase && old.start === cur.start && old.end === cur.end) {
      console.log(`Realm ${realm}: zaten güncel (${LABELS[cur.phase]}), yazılmadı.`);
      continue;
    }

    update[key] = {
      phase: cur.phase,
      label: LABELS[cur.phase],
      start: cur.start,
      end: cur.end,
      fetchedAt: new Date().toISOString(),
    };
    console.log(`Realm ${realm}: ${LABELS[cur.phase]} (${cur.start} → ${cur.end})`);
  } catch (e) {
    console.error(`Realm ${realm} hata: ${e.message}`);
    if (realm === 0) realm0Failed = true;
  }
}

if (Object.keys(update).length > 0) {
  await ref.set({ ...update, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log("system/phase güncellendi.");
} else {
  console.log("Yazılacak değişiklik yok.");
}

if (realm0Failed) process.exit(1);
