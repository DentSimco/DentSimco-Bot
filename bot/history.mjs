// DentSimco Bot — Şirket geçmişi (son 30 gün)
// Sıralama botu (ranking.mjs) her gün tüm şirketleri çeker; bu dosya o satırları şirket başına en çok 30 günlük geçmişe ekler.
// 30 günden eski gün her yazımda kendiliğinden düşer (ayrıca silme işi yoktur).
//
// Firestore'a yazılan biçim (dashboard sirket-gecmis.js okur):
//   meta/rhist_r{realm}            data = JSON {v, t, date, chunks, days, n}   (index: günler artan, YYYYMMDD sayı)
//   meta/rhist_r{realm}_{NNN}      data = JSON {"<id>": [gün, ...], ...}       (NNN = şirket numarası % 256, 3 hane)
//   gün = [YYYYMMDD, sıra, evaSırası (1 en iyi, 0 yok), değer, bina, patent, işçi, bono, ayrıntıVar(0|1)]  (artan tarih)
//   meta/rhistbf_r{realm}_{NNN}    aynı biçim; yalnız geri doldurma (history_backfill.mjs) yazar, günlük işe karışmaz.
//                                  Günlük geçmiş 30 güne tamamlanınca silinir (istemci iki belgeyi tarihe göre birleştirir).

import { parseJSON } from './common.mjs';

export const HIST_DAYS = 30;
export const HIST_CHUNKS = 256;
export const histPath = (r, i) => `meta/rhist_r${r}_${String(i).padStart(3, '0')}`;
export const histBfPath = (r, i) => `meta/rhistbf_r${r}_${String(i).padStart(3, '0')}`;
export const histIndexPath = (r) => `meta/rhist_r${r}`;
export const histChunkOf = (id) => Number(id) % HIST_CHUNKS;

// 'YYYY-MM-DD...' → YYYYMMDD sayısı; bozuksa null
export function dayNum(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr ?? ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}
// YYYYMMDD sayısından n gün sonrası (n negatif olabilir)
export function addDays(day, n) {
  const d = new Date(Date.UTC(Math.floor(day / 10000), Math.floor(day / 100) % 100 - 1, day % 100 + n));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
export const cutoffOf = (day) => addDays(day, -(HIST_DAYS - 1));

// ranking.mjs satırı [id, ad, sıra, sıraFarkı, eva, değer, değerFarkı, yüzde, bina, patent, işçi, bono, ayrıntıVar] → geçmiş günü
export function toHistDay(row, day) {
  const d = row[12] === 1;
  return [day, row[2], row[4], row[5], d ? row[8] : null, d ? row[9] : null, d ? row[10] : null, d ? row[11] : null, d ? 1 : 0];
}

// Şirketin eski günlerine bugünü ekler: aynı gün varsa yenisi geçer (ayrıntı gün içinde dolar; yeni ayrıntısızsa eski ayrıntı kalır),
// 30 günlük pencerenin dışı atılır, sonuç artan tarihlidir.
export function mergeDays(old, today, day) {
  const cut = cutoffOf(day);
  const out = new Map();
  for (const x of Array.isArray(old) ? old : []) if (Array.isArray(x) && x[0] >= cut && x[0] <= day) out.set(x[0], x);
  if (today) {
    const prev = out.get(today[0]);
    out.set(today[0], prev && prev[8] === 1 && today[8] === 0 ? [today[0], today[1], today[2], today[3], prev[4], prev[5], prev[6], prev[7], 1] : today);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

// Bir parçanın yeni içeriği: yalnız bugünkü sıralamada olan şirketler kalır (kapanan şirketler düşer).
export function mergeChunk(oldMap, rows, day) {
  const out = {};
  for (const row of rows) out[row[0]] = mergeDays(oldMap?.[row[0]], toHistDay(row, day), day);
  return out;
}

// Geçmiş parçalarındaki farklı günler (artan)
export function distinctDays(chunkMaps) {
  const s = new Set();
  for (const m of chunkMaps) for (const list of Object.values(m || {})) for (const x of list) s.add(x[0]);
  return [...s].sort((a, b) => a - b);
}

// Bir realm'in geçmişini günceller. rows: ranking.mjs satırları, date: API'nin sıralama tarihi (örn. '2026-10-15T00:00:00Z').
// Dönüş: { n, days } — yazılan şirket sayısı ve geçmişteki farklı gün sayısı. Tarih okunamazsa hiçbir şey yazmaz.
export async function updateHistory(db, r, rows, date, t0) {
  const day = dayNum(date);
  if (!day) return { n: 0, days: 0, skipped: true };
  const paths = Array.from({ length: HIST_CHUNKS }, (_, i) => histPath(r, i));
  const prev = await db.getMany(paths);
  const byChunk = Array.from({ length: HIST_CHUNKS }, () => []);
  for (const row of rows) byChunk[histChunkOf(row[0])].push(row);
  const writes = [];
  const maps = [];
  for (let i = 0; i < HIST_CHUNKS; i++) {
    const map = mergeChunk(parseJSON(prev.get(paths[i])?.data), byChunk[i], day);
    maps.push(map);
    writes.push({ type: 'set', path: paths[i], data: { data: JSON.stringify(map), u: t0 } });
  }
  const days = distinctDays(maps);
  const index = { v: 1, t: t0, date: String(date), chunks: HIST_CHUNKS, days, n: rows.length };
  writes.push({ type: 'set', path: histIndexPath(r), data: { data: JSON.stringify(index), u: t0 } });
  // Günlük geçmiş 30 güne tamamlandıysa geri doldurma belgeleri artık gereksiz
  if (days.length >= HIST_DAYS) for (let i = 0; i < HIST_CHUNKS; i++) writes.push({ type: 'delete', path: histBfPath(r, i) });
  await db.commit(writes);
  return { n: rows.length, days: days.length };
}
