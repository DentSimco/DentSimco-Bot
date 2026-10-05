// DentSimco Bot v3 — Canlı borsa toplayıcı (Simcotools API)
// GitHub Actions bunu 10 dakikada bir çalıştırır (.github/workflows/borsa.yml).
// Her çalışmada: iki realm, borsada satılan tüm ürünler, her ürün için tek istek (tüm kaliteler birlikte gelir).
//
// Simcotools'tan gelen veri:
//   price                 = son işlemin fiyatı (en düşük satış ilanı DEĞİL)
//   volume                = son işlemin adedi (borsadaki toplam arz DEĞİL) — kullanılmaz
//   fiveMinutesCandlestick = son 5 dakikalık mum (açılış/yüksek/düşük/kapanış + satılan adet)
//   lastDayCandlestick     = dünün kesin özeti (OHLC + satılan adet + VWAP)
// Satış arzı (borsadaki ilan derinliği) bu API'de yok; o alan boş (null) bırakılır.
//
// Firestore'a yazılan biçim eskisiyle aynıdır, dashboard değişmeden okur:
//   live/r{realm}                  data = JSON {v, t, items: {id: [zaman, {q: [fiyat, arz, satış, tutar]}]}}
//   intraday/r{realm}_{gün}_s{NN}  t{SSDD} = JSON {id: {q: [fiyat, arz, satış, tutar]}}
//   daily/r{realm}_{id}_{yıl}      d{AAGG} = JSON {q: [açılış, yüksek, düşük, kapanış, ortArz, satış, tutar]}

import {
  CONFIG, PATHS, fetchPaced, fetchJson, createPacer, runPool, utcDay, hhmm, addDays, shardOf, range, round, parseJSON, runIfMain,
} from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 3;
const API = 'https://api.simcotools.com/v1';

// Simcotools sınırı: saniyede 2 istek (tüm ürünler için ortak). 550 ms aralık güvenli pay bırakır.
// Aralık bu değerin altına inmez; sunucu 429 derse kendiliğinden yavaşlar.
const PACE = { concurrency: 2, startIntervalMs: 550, minIntervalMs: 550, maxIntervalMs: 4000, retries: 4 };
const FETCH_BUDGET_MS = 8 * 60_000; // 10 dakikalık aralığın içinde bitmeli
const BUCKET = 5 * 60_000;          // mum süresi
const SAMPLE_SCALE = 2;             // 10 dakikalık aralık ÷ 5 dakikalık mum: gün içi satış tahmini için çarpan

const num = (x) => (Number(x) > 0 ? Number(x) : null);

// Bir ürünün yanıtını sadeleştirir.
//  metrics[q] = [fiyat, arz(null), tahmini satış adedi, tahmini tutar]
//  daily[q]   = {day, row} dünün kesin özeti
export function parseSummaries(json, at) {
  const list = json?.resource?.summariesByQuality;
  if (!Array.isArray(list)) throw new Error('beklenmeyen borsa yanıtı');
  const metrics = {};
  const daily = {};
  const bucketStart = Math.floor(at / BUCKET) * BUCKET;
  for (const s of list) {
    const q = Number(s?.quality);
    if (!Number.isInteger(q) || q < 0 || q > 20) continue;
    const price = num(s.price);

    // Gün içi satış tahmini: son 5 dakikalık mum yeniyse (içinde bulunulan ya da bir önceki dilim)
    // adedini 2 ile çarparız. Eskiyse bu kalitede yakın zamanda işlem olmamıştır → 0.
    const c = s.fiveMinutesCandlestick;
    const cAt = Date.parse(c?.date);
    let sold = 0;
    let ref = price;
    if (c && Number.isFinite(cAt) && cAt >= bucketStart - BUCKET) {
      sold = Math.max(0, Math.round((Number(c.volume) || 0) * SAMPLE_SCALE));
      if (num(c.close)) ref = num(c.close);
    }
    metrics[q] = [price, null, sold, ref ? round(sold * ref, 2) : 0];

    // Dünün kesin özeti
    const d = s.lastDayCandlestick;
    if (d && typeof d.date === 'string') {
      const volume = Math.max(0, Number(d.volume) || 0);
      const vwap = num(d.vwap) ?? num(d.close) ?? 0;
      daily[q] = {
        day: d.date.slice(0, 10),
        row: [num(d.open), num(d.high), num(d.low), num(d.close), null, volume, round(volume * vwap, 2)],
      };
    }
  }
  return { metrics, daily };
}

function interleave(lists) {
  const out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// ---- Ana akış ---------------------------------------------------------------

export async function main() {
  const t0 = Date.now();
  if (typeof fetch !== 'function') throw new Error('Node 18 veya üstü gerekli');
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const { realms, shards } = CONFIG;
  const day = utcDay(t0);
  const yesterday = addDays(day, -1);
  const field = `t${hhmm(t0)}`;
  const deadline = t0 + FETCH_BUDGET_MS;

  // 1) Önceki durumu tek istekte oku
  const docs = await db.getMany([PATHS.meta('tradable'), PATHS.meta('rollup'), ...realms.map(PATHS.live)]);
  const marker = docs.get(PATHS.meta('rollup'));

  // 2) Hangi ürünler çekilecek
  let tradable = parseJSON(docs.get(PATHS.meta('tradable'))?.data);
  if (!tradable) {
    const all = await fetchJson(`${CONFIG.simcoBase}/api/v2/constants/resources/`, { deadline });
    const ids = Object.values(all).filter((x) => x?.isExchangeTradable).map((x) => Number(x.dbLetter)).filter(Number.isFinite);
    tradable = Object.fromEntries(realms.map((r) => [r, ids.sort((a, b) => a - b)]));
  }
  const prevLive = {};
  for (const r of realms) prevLive[r] = parseJSON(docs.get(PATHS.live(r))?.data)?.items || {};

  // En uzun süredir güncellenmeyen ürünler öne alınır (süre yetmezse kalanı sonraki çalışma sürdürür).
  let tasks = interleave(realms.map((r) => (tradable[r] || []).map((id) => ({ r, id: Number(id) }))));
  const staleness = (t) => {
    const seen = prevLive[t.r]?.[t.id]?.[0];
    return seen ? t0 - seen : Infinity;
  };
  tasks = tasks.map((t, i) => ({ t, i, s: staleness(t) })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).map((x) => x.t);

  // 3) Borsayı çek
  const pacer = createPacer({ deadline, ...PACE });
  const progress = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`… ${sec} sn: ${pacer.stat.ok}/${tasks.length} ürün çekildi, 429=${pacer.stat.throttled}`);
  }, 60_000);
  progress.unref?.();

  const results = await runPool(
    tasks,
    async (t) => {
      const data = await fetchPaced(`${API}/realms/${t.r}/market/resources/${t.id}`, pacer, { deadline, retries: PACE.retries });
      return { data, at: Date.now() };
    },
    { concurrency: PACE.concurrency, delayMs: 0, deadline },
  );
  clearInterval(progress);
  const throttled = pacer.stat.throttled;
  const fetchMs = Date.now() - t0;

  // 4) Hesapla
  const stats = Object.fromEntries(realms.map((r) => [r, { ok: 0, fail: 0, skipped: 0 }]));
  const errors = [];
  const intraday = {};
  const touched = new Set();
  const newLive = Object.fromEntries(realms.map((r) => [r, { ...prevLive[r] }]));
  const dailyRows = Object.fromEntries(realms.map((r) => [r, {}]));

  tasks.forEach(({ r, id }, i) => {
    const res = results[i];
    if (!res || res.error?.deadline) { stats[r].skipped++; return; }
    try {
      if (!res.ok) throw res.error;
      const { metrics, daily } = parseSummaries(res.value.data, res.value.at);
      if (!Object.keys(metrics).length) throw new Error('kalite verisi yok');
      newLive[r][id] = [res.value.at, metrics];
      ((intraday[`${r}_${shardOf(id)}`] ||= {})[id] = metrics);
      touched.add(`${r}_${shardOf(id)}`);
      dailyRows[r][id] = daily;
      stats[r].ok++;
    } catch (e) {
      stats[r].fail++;
      if (errors.length < 15) errors.push(`r${r}/${id}: ${e?.message || e}`);
    }
  });

  const totalOk = realms.reduce((sum, r) => sum + stats[r].ok, 0);
  const summary = `r${realms.map((r) => `${r} tamam=${stats[r].ok} hata=${stats[r].fail} atlandı=${stats[r].skipped}`).join(' | r')}`;

  // 5) Kaydet
  const writes = [];
  if (totalOk > 0) {
    for (const r of realms) {
      for (let s = 0; s < shards; s++) {
        const key = `${r}_${s}`;
        if (!touched.has(key)) continue;
        writes.push({ type: 'merge', path: PATHS.intraday(r, day, s), data: { [field]: JSON.stringify(intraday[key]), u: t0 } });
      }
      writes.push({ type: 'set', path: PATHS.live(r), data: { data: JSON.stringify({ v: VERSION, t: t0, items: newLive[r] }), u: t0 } });
    }
  }

  // Dünün kesin özeti: gün değişince her realm için bir kez yazılır (ürünlerin en az %90'ı çekildiyse).
  const markerNext = {};
  let dailyCount = 0;
  for (const r of realms) {
    const key = `lastDay_r${r}`;
    const total = (tradable[r] || []).length;
    if (marker?.[key] && marker[key] >= yesterday) continue;
    if (!total || stats[r].ok < total * 0.9) continue;
    const dayField = `d${yesterday.slice(5, 7)}${yesterday.slice(8, 10)}`;
    for (const [id, qualities] of Object.entries(dailyRows[r])) {
      const summaryByQ = {};
      for (const [q, d] of Object.entries(qualities)) if (d.day === yesterday) summaryByQ[q] = d.row;
      if (!Object.keys(summaryByQ).length) continue;
      writes.push({ type: 'merge', path: PATHS.daily(r, id, yesterday.slice(0, 4)), data: { [dayField]: JSON.stringify(summaryByQ), u: t0 } });
      dailyCount++;
    }
    // Süresi dolan gün-içi belgeleri sil
    const expired = addDays(yesterday, -CONFIG.rawRetentionDays);
    for (let s = 0; s < shards; s++) writes.push({ type: 'delete', path: PATHS.intraday(r, expired, s) });
    markerNext[key] = yesterday;
  }
  if (Object.keys(markerNext).length) writes.push({ type: 'merge', path: PATHS.meta('rollup'), data: { ...markerNext, u: t0 } });

  const rate = { perSec: pacer.stat.ok && fetchMs ? round(pacer.stat.ok / (fetchMs / 1000), 2) : 0, intervalMs: pacer.interval, retryAfterMs: pacer.stat.retryAfterSeen, note: pacer.stat.note };
  const status = { v: VERSION, t: t0, fetchMs, totalMs: Date.now() - t0, throttled, rate, stats, errors };
  writes.push({ type: 'set', path: PATHS.meta('status'), data: { data: JSON.stringify(status), u: t0 } });
  await db.commit(writes);

  console.log(`DentSimco borsa | ${summary} | 429=${throttled} | hız=${rate.perSec}/sn aralık=${rate.intervalMs}ms | çekme=${(fetchMs / 1000).toFixed(1)}sn | toplam=${((Date.now() - t0) / 1000).toFixed(1)}sn${dailyCount ? ` | günlük özet=${dailyCount} ürün` : ''}`);
  if (errors.length) console.log('İlk hatalar:', errors.slice(0, 5).join(' ; '));
  const missing = realms.reduce((sum, r) => sum + stats[r].skipped + stats[r].fail, 0);
  if (missing > 0) console.log(`UYARI: ${missing} ürün bu çalışmada çekilemedi; sonraki çalışma en eski üründen devam eder.`);
  if (pacer.stat.note || pacer.stat.retryAfterSeen) console.log(`Sunucu yanıtı (429): ${pacer.stat.note || '-'} | en uzun bekleme=${((pacer.stat.longestPauseMs) / 1000).toFixed(1)}sn`);
  if (totalOk === 0) throw new Error('Hiçbir ürün çekilemedi. Simcotools API erişimini kontrol et.');
}

runIfMain(import.meta.url, main);
