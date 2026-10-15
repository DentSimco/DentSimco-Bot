// DentSimco Bot — Şirket geçmişi geri doldurma (tek seferlik, kaldığı yerden devam eder)
// Günlük birikim (history.mjs) bugünden başlar; bu iş ilk 30 günü Simcotools'un şirket geçmişi API'sinden doldurur:
//   GET /v1/realms/{realm}/companies/{id}/history?page=1&page_size=31   (şirket başına bir istek)
// Sıra: şirketler değere göre (en değerli ilk). Her ~500 şirkette ve süre dolunca kaydeder; ilerleme meta/rhistbf_p_r{realm} içindedir,
// sonraki çalışma kaldığı yerden devam eder. Bitince ya da günlük geçmiş 30 güne tamamlanınca (history.mjs belgeleri siler) kendiliğinden durur.
// Yazdığı belgeler günlük geçmişten AYRIDIR (meta/rhistbf_r{realm}_{NNN}); böylece iki yazar birbirinin belgesini ezmez.
// Hız: borsa botuyla aynı Simcotools sınırını paylaştığı için yavaştır (≈1 istek/sn); 429 gelirse kendiliğinden yavaşlar.

import { CONFIG, createPacer, fetchPaced, parseJSON, runIfMain } from './common.mjs';
import { Firestore } from './firestore.mjs';
import { HIST_DAYS, HIST_CHUNKS, histBfPath, histIndexPath, histChunkOf, dayNum, cutoffOf, mergeDays } from './history.mjs';

const API = 'https://api.simcotools.com/v1';
const BUDGET_MS = 5 * 3600_000; // GitHub işi en çok 6 saat; kaydetmeye pay bırakılır
const CHECKPOINT = 500;          // şirket
const PACE = { startIntervalMs: 1100, minIntervalMs: 1000, maxIntervalMs: 6000, retries: 3 };
const progressPath = (r) => `meta/rhistbf_p_r${r}`;

// API geçmiş satırı → geçmiş günü [YYYYMMDD, sıra, eva, değer, bina, patent, işçi, bono, ayrıntıVar] (history.mjs ile aynı biçim)
export function apiDay(h) {
  const day = dayNum(h?.date);
  if (!day || !Number.isFinite(Number(h.rank)) || !Number.isFinite(Number(h.value))) return null;
  const d = h.fetched === true;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return [day, n(h.rank), n(h.evaRank), n(h.value), d ? n(h.buildingsValue) : null, d ? n(h.patentsValue) : null, d ? n(h.workers) : null, d ? n(h.bondsSold) : null, d ? 1 : 0];
}
// Yanıttaki son 30 gün (refDay dahil), artan tarihli
export function apiDays(json, refDay) {
  const cut = cutoffOf(refDay);
  const out = new Map();
  for (const h of json?.history || []) {
    const x = apiDay(h);
    if (x && x[0] >= cut && x[0] <= refDay) out.set(x[0], x);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

async function rankedIds(db, r) {
  const idx = parseJSON((await db.getMany([`meta/ranking_r${r}`])).get(`meta/ranking_r${r}`)?.data);
  if (!idx?.chunks) return null;
  const paths = Array.from({ length: idx.chunks }, (_, i) => `meta/ranking_r${r}_c${String(i).padStart(2, '0')}`);
  const docs = await db.getMany(paths);
  const rows = [];
  for (const p of paths) for (const row of parseJSON(docs.get(p)?.data) || []) rows.push(row);
  rows.sort((a, b) => a[2] - b[2]);
  return { ids: rows.map((x) => x[0]), date: idx.date };
}

async function backfillRealm(db, r, deadline, lines) {
  const idxDoc = parseJSON((await db.getMany([histIndexPath(r)])).get(histIndexPath(r))?.data);
  if (idxDoc?.days?.length >= HIST_DAYS) { lines.push(`r${r}: günlük geçmiş ${idxDoc.days.length} güne ulaştı, atlandı`); return; }
  const prog = parseJSON((await db.getMany([progressPath(r)])).get(progressPath(r))?.data) || { done: 0, finished: false, failed: 0 };
  if (prog.finished) { lines.push(`r${r}: geri doldurma bitti, atlandı`); return; }
  const list = await rankedIds(db, r);
  const refDay = dayNum(list?.date);
  if (!list || !refDay) { lines.push(`r${r}: sıralama yok, atlandı (önce siralama.yml çalışmalı)`); return; }

  const paths = Array.from({ length: HIST_CHUNKS }, (_, i) => histBfPath(r, i));
  const old = await db.getMany(paths);
  const maps = paths.map((p) => parseJSON(old.get(p)?.data) || {});
  const dirty = new Set();
  const pacer = createPacer({ deadline, ...PACE });
  let i = Math.min(prog.done || 0, list.ids.length);
  let failed = prog.failed || 0;
  const t0 = Date.now();

  const save = async (finished) => {
    const writes = [...dirty].map((c) => ({ type: 'set', path: paths[c], data: { data: JSON.stringify(maps[c]), u: t0 } }));
    writes.push({ type: 'set', path: progressPath(r), data: { data: JSON.stringify({ done: i, total: list.ids.length, failed, date: list.date, finished, t: t0 }), u: t0 } });
    await db.commit(writes);
    dirty.clear();
  };

  for (; i < list.ids.length; i++) {
    const id = list.ids[i];
    try {
      const json = await fetchPaced(`${API}/realms/${r}/companies/${id}/history?page=1&page_size=${HIST_DAYS + 1}`, pacer, { deadline, retries: PACE.retries });
      const days = apiDays(json, refDay);
      if (days.length) {
        const c = histChunkOf(id);
        let list2 = maps[c][id] || [];
        for (const x of days) list2 = mergeDays(list2, x, refDay);
        maps[c][id] = list2;
        dirty.add(c);
      }
    } catch (e) {
      if (e?.deadline) break;
      failed++; // tek şirketin hatası (ör. silinmiş) işi durdurmaz
    }
    if ((i + 1) % CHECKPOINT === 0) await save(false);
  }
  const finished = i >= list.ids.length;
  await save(finished);
  lines.push(`r${r}: ${i}/${list.ids.length} şirket${finished ? ' (BİTTİ)' : ''}, hata ${failed}, 429=${pacer.stat.throttled}`);
}

export async function main() {
  const t0 = Date.now();
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const deadline = t0 + BUDGET_MS;
  const lines = [];
  for (const r of CONFIG.realms) {
    if (Date.now() >= deadline) { lines.push(`r${r}: süre doldu, sonraki çalışmada`); continue; }
    try { await backfillRealm(db, r, deadline, lines); } catch (e) { lines.push(`r${r}: HATA ${e?.message || e}`); }
  }
  console.log(`DentSimco geçmiş geri doldurma | ${lines.join(' | ')} | ${((Date.now() - t0) / 60000).toFixed(0)} dk`);
}

runIfMain(import.meta.url, main);
