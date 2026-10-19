// DentSimco Bot — Restoran tüketimi (günlük)
// Her gün çalışır: .github/workflows/restoran.yml. Sim Companies, API için "5 dakikada 1 istek" kuralı koydu:
// realm başına tek istek (resources-retail-info; tüm ürünlerin son ~28 günlük satış verisi tek yanıtta) atılır ve
// iki istek arasında en az GAP_MS beklenir.
//
// Firestore'a yazılan biçim (dashboard okuyabilir):
//   meta/restaurant_r{realm}   data = JSON {v, t, p: {urunId: {AAAA-AA-GG: [tüketilenMiktar, ortFiyat, talep, ilkGörülme, düzeltme?]}}}
//   ilkGörülme = günün satırını bota ilk geldiği an (ms); düzeltme = değer sonradan değişirse son değişim anı (ms).
// Her çalışma önceki kayıtlara ekler (yanıt yalnız ~28 gün verir, geçmiş birikir); en çok KEEP_DAYS gün tutulur.

import { CONFIG, PATHS, fetchJson, parseJSON, sleep, runIfMain, addDays, utcDay, round } from './common.mjs';
import { Firestore } from './firestore.mjs';

export const GAP_MS = 5 * 60_000 + 10_000; // 5 dakika kuralı + pay
const KEEP_DAYS = 400;
const VERSION = 1;

// Yanıttan (ürün listesi) restoranda satılan ürünlerin günlük satırlarını çıkarır: {id: {gün: [miktar, fiyat, talep]}}
export function extractRestaurant(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item?.dbLetter);
    const rows = Array.isArray(item?.retailData) ? item.retailData : [];
    if (!Number.isFinite(id) || !rows.some((r) => Number(r?.amountSoldRestaurant) > 0)) continue;
    const days = {};
    for (const r of rows) {
      const amount = Number(r?.amountSoldRestaurant);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date) || !Number.isFinite(amount)) continue;
      days[r.date] = [amount, round(Number(r.averagePrice) || 0, 2), round(Number(r.demand) || 0, 4)];
    }
    out[id] = days;
  }
  return out;
}

// Yeni gün satırlarını önceki kayıtla birleştirir. Önceki ilk görülme korunur; miktar değişmişse düzeltme anı yazılır.
export function mergeRestaurant(prev, fresh, now) {
  const oldest = addDays(utcDay(now), -KEEP_DAYS);
  const next = {};
  for (const id of new Set([...Object.keys(prev || {}), ...Object.keys(fresh)])) {
    const days = { ...(prev?.[id] || {}) };
    for (const [day, [amount, price, demand]] of Object.entries(fresh[id] || {})) {
      const old = days[day];
      if (!old) days[day] = [amount, price, demand, now];
      else if (old[0] !== amount) days[day] = [amount, price, demand, old[3], now];
      else days[day] = [amount, price, demand, ...old.slice(3)];
    }
    for (const day of Object.keys(days)) if (day < oldest) delete days[day];
    next[id] = days;
  }
  return next;
}

// 429 gelirse bir kez 5 dakikalık beklemeden sonra yeniden dener.
async function fetchRetail(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJson(url, { retries: 0 });
    } catch (e) {
      if (attempt >= 2 || !/HTTP 429/.test(e?.message || '')) throw e;
      await sleep(GAP_MS);
    }
  }
}

export async function main() {
  const t0 = Date.now();
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const lines = [];
  let failed = 0;
  for (const [i, r] of CONFIG.realms.entries()) {
    if (i > 0) await sleep(GAP_MS);
    try {
      const fresh = extractRestaurant(await fetchRetail(`${CONFIG.simcoBase}/api/v4/${r}/resources-retail-info/`));
      if (!Object.keys(fresh).length) throw new Error('yanıtta restoran verisi yok');
      const path = PATHS.meta(`restaurant_r${r}`);
      const prev = parseJSON((await db.getMany([path])).get(path)?.data)?.p;
      const now = Date.now();
      const p = mergeRestaurant(prev, fresh, now);
      await db.commit([{ type: 'set', path, data: { data: JSON.stringify({ v: VERSION, t: now, p }), u: now } }]);
      lines.push(`r${r}: ${Object.keys(p).length} ürün`);
    } catch (e) {
      failed++;
      lines.push(`r${r}: HATA ${e?.message || e}`);
    }
  }
  console.log(`DentSimco restoran | ${lines.join(' | ')} | ${((Date.now() - t0) / 1000).toFixed(0)} sn`);
  if (failed) throw new Error(`${failed} realm yazılamadı`);
}

runIfMain(import.meta.url, main);
