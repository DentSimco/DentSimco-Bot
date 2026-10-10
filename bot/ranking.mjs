// DentSimco Bot — Şirket sıralaması (Simcotools API)
// GitHub Actions bunu günde bir kez çalıştırır (.github/workflows/siralama.yml). İki realm (0 ve 1), tüm şirketler.
//
// Simcotools: GET /v1/realms/{realm}/ranking?page=N&page_size=100 (en çok 100). Realm başına ~26 bin şirket = ~260 istek.
// Sıralamanın ayrıntıları (bina, patent, işçi, tahvil) sayfa sayfa gün içinde dolar: sondaki sayfalar sabaha doğru hazır olur
// (siralama.yml bu yüzden öğleye yakın çalışır). Hazır olmayan şirkette `fetched` false gelir; alanlar 0 yazılır.
//
// Firestore'a yazılan biçim (dashboard sirketler.js okur):
//   meta/ranking_r{realm}          data = JSON {v, t, date, total, chunks, size}
//   meta/ranking_r{realm}_c{NN}    data = JSON [satır, ...]   (NN = 00..; parça başına en çok ROWS_PER_CHUNK satır)
//   satır = [id, ad, sıra, sıraFarkı, evaSırası, değer, değerFarkı, değerYüzde, bina, patent, işçi, tahvil, ayrıntıVar(0|1)]
// Parça sayısı sabit değildir; index belgesindeki `chunks` kadar okunur. Eski parçalar yeni yazımda üzerine yazılır,
// fazlası silinir.

import { CONFIG, createPacer, fetchPaced, round, runIfMain } from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 1;
const API = 'https://api.simcotools.com/v1';
const PAGE_SIZE = 100;
const ROWS_PER_CHUNK = 2000; // ~120 bayt/satır → parça başına ~250 KB (Firestore sınırı 1 MiB)
const MAX_OLD_CHUNKS = 40;   // eski parçaları silerken bakılan üst sınır
const BUDGET_MS = 25 * 60_000;
const MIN_SHARE = 0.98;      // sayfaların en az bu kadarı gelmeden realm yazılmaz (yarım liste eski ama tam listeyi bozmasın)
const PACE = { startIntervalMs: 550, minIntervalMs: 550, maxIntervalMs: 4000, retries: 4 };

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// API satırını kısa diziye çevirir. Silinmiş şirket null döner.
export function toRow(c) {
  if (!c || c.isDeleted || !Number.isFinite(Number(c.companyId)) || !Number.isFinite(Number(c.rank))) return null;
  return [
    Number(c.companyId), String(c.companyName ?? ''), n(c.rank), n(c.rankDiff), n(c.evaRank),
    n(c.companyValue), n(c.companyValueDiff), round(n(c.companyValuePctChange), 5),
    n(c.buildingsValue), n(c.patentsValue), n(c.workers), n(c.bondsSold), c.fetched ? 1 : 0,
  ];
}

// Sayfa yanıtlarından (sıra numarasına göre) tek bir liste kurar; aynı şirket iki sayfada çıkarsa ilki kalır.
export function buildRows(pages) {
  const seen = new Set();
  const rows = [];
  for (const page of pages) {
    for (const c of page?.ranking || []) {
      const row = toRow(c);
      if (!row || seen.has(row[0])) continue;
      seen.add(row[0]);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a[2] - b[2]);
}

export function chunkRows(rows, size = ROWS_PER_CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const chunkPath = (r, i) => `meta/ranking_r${r}_c${String(i).padStart(2, '0')}`;

async function fetchRealm(r, deadline) {
  const pacer = createPacer({ deadline, ...PACE });
  const get = (page) => fetchPaced(`${API}/realms/${r}/ranking?page=${page}&page_size=${PAGE_SIZE}`, pacer, { deadline, retries: PACE.retries });
  const first = await get(1);
  const last = Math.max(1, Number(first?.metadata?.lastPage) || 1);
  const pages = [first];
  let failed = 0;
  for (let p = 2; p <= last; p++) {
    try { pages.push(await get(p)); } catch (e) {
      if (e?.deadline) { failed += last - p + 1; break; }
      failed++;
    }
  }
  return { pages, last, failed, date: first?.date ?? null, total: Number(first?.metadata?.totalRecords) || 0, throttled: pacer.stat.throttled };
}

export async function main() {
  const t0 = Date.now();
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const deadline = t0 + BUDGET_MS;
  const writes = [];
  const lines = [];
  let wrote = 0;

  for (const r of CONFIG.realms) {
    const got = await fetchRealm(r, deadline);
    const rows = buildRows(got.pages);
    const okPages = got.last - got.failed;
    if (okPages < got.last * MIN_SHARE || !rows.length) {
      lines.push(`r${r}: ATLANDI (${okPages}/${got.last} sayfa, ${rows.length} şirket)`);
      continue;
    }
    const chunks = chunkRows(rows);
    chunks.forEach((c, i) => writes.push({ type: 'set', path: chunkPath(r, i), data: { data: JSON.stringify(c), u: t0 } }));
    for (let i = chunks.length; i < MAX_OLD_CHUNKS; i++) writes.push({ type: 'delete', path: chunkPath(r, i) });
    const index = { v: VERSION, t: t0, date: got.date, total: rows.length, chunks: chunks.length, size: ROWS_PER_CHUNK };
    writes.push({ type: 'set', path: `meta/ranking_r${r}`, data: { data: JSON.stringify(index), u: t0 } });
    wrote++;
    lines.push(`r${r}: ${rows.length} şirket, ${chunks.length} parça, ${okPages}/${got.last} sayfa, 429=${got.throttled}`);
  }

  if (writes.length) await db.commit(writes);
  console.log(`DentSimco sıralama | ${lines.join(' | ')} | ${((Date.now() - t0) / 1000).toFixed(0)} sn`);
  if (!wrote) throw new Error('Hiçbir realmın sıralaması alınamadı. Simcotools API erişimini kontrol et.');
}

runIfMain(import.meta.url, main);
