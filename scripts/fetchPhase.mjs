// DentSimco - Ekonomi evresi botu
// Simcotools'tan güncel ekonomi evresini (resesyon / normal / boom) çeker
// ve Firestore'da system/phase dokümanına yazar.
// Güvenlik: npm paketi (firebase-admin) kullanmaz; botun kendi Firestore bağlantısını (bot/firestore.mjs) kullanır.
// Böylece gizli anahtar dışarıdan indirilen hiçbir pakete verilmez.
import { Firestore } from "../bot/firestore.mjs";

const REALMS = [0, 1];
const API = (realm) => `https://api.simcotools.com/v1/realms/${realm}/phases`;
const LABELS = { recession: "Resesyon", normal: "Normal", boom: "Boom" };
const PATH = "system/phase";

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

// Elle evre: MANUAL_PHASE (recession | normal | boom) doluysa kaynak sorgulanmaz; evre, son cuma 15:00 UTC'den
// bir sonraki cuma 15:00 UTC'ye kadar yazılır (oyun evreyi cuma günü değiştirir). MANUAL_REALMS: virgüllü realm listesi (varsayılan 0,1).
const FRIDAY_MS = 7 * 86400000;
function weekRange(t) {
  const d = new Date(t);
  const back = (d.getUTCDay() - 5 + 7) % 7;
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 15);
  if (start > t) start -= FRIDAY_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + FRIDAY_MS).toISOString() };
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON secret'ı bulunamadı.");
  process.exit(1);
}
const db = new Firestore(raw);

const manual = (process.env.MANUAL_PHASE || "").trim().toLowerCase();
if (manual) {
  if (!LABELS[manual]) {
    console.error(`MANUAL_PHASE geçersiz: ${manual}`);
    process.exit(1);
  }
  const realms = (process.env.MANUAL_REALMS || "0,1").split(",").map((x) => Number(x.trim())).filter((x) => REALMS.includes(x));
  const { start, end } = weekRange(Date.now());
  const data = { updatedAt: Date.now() };
  for (const realm of realms) {
    data[`r${realm}`] = { phase: manual, label: LABELS[manual], start, end, fetchedAt: new Date().toISOString(), manual: true };
    console.log(`Realm ${realm}: elle ${LABELS[manual]} (${start} → ${end})`);
  }
  await db.commit([{ type: "merge", path: PATH, data }]);
  console.log("system/phase güncellendi (elle).");
  process.exit(0);
}

const stored = (await db.getMany([PATH])).get(PATH) || {};
const now = Date.now();
const update = {};
let realm0Failed = false;

for (const realm of REALMS) {
  const key = `r${realm}`;
  try {
    const data = await getJson(API(realm));
    if (!Array.isArray(data?.ranges) || data.ranges.length === 0) {
      throw new Error("Yanıtta evre listesi (ranges) yok");
    }
    const cur = newestRange(data.ranges);
    if (!LABELS[cur.phase]) throw new Error(`Bilinmeyen evre: ${cur.phase}`);
    if (!Number.isFinite(Date.parse(cur.start)) || !Number.isFinite(Date.parse(cur.end))) {
      throw new Error("Evre tarihleri okunamadı");
    }

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
      start: String(cur.start),
      end: String(cur.end),
      fetchedAt: new Date().toISOString(),
    };
    console.log(`Realm ${realm}: ${LABELS[cur.phase]} (${cur.start} → ${cur.end})`);
  } catch (e) {
    console.error(`Realm ${realm} hata: ${e.message}`);
    if (realm === 0) realm0Failed = true;
  }
}

if (Object.keys(update).length > 0) {
  // merge: yalnız değişen realm'in alanı (r0 / r1) ve updatedAt yazılır; diğer realm olduğu gibi kalır
  await db.commit([{ type: "merge", path: PATH, data: { ...update, updatedAt: now } }]);
  console.log("system/phase güncellendi.");
} else {
  console.log("Yazılacak değişiklik yok.");
}

if (realm0Failed) process.exit(1);
