// DentSimco Bot v4 — Canlı borsa toplayıcı (Simcotools API)
// GitHub Actions bunu 5 dakikada bir çalıştırır (.github/workflows/borsa.yml). İki realm (0 ve 1), borsada satılan tüm
// ürünler, her ürün için tek istek (tüm kaliteler birlikte gelir).
//
// Simcotools'tan gelen veri:
//   price                  = son işlemin fiyatı (en düşük satış ilanı DEĞİL)
//   timestamp              = o kalitedeki son işlemin zamanı
//   volume                 = son işlemin adedi (borsadaki toplam arz DEĞİL) — kullanılmaz
//   fiveMinutesCandlestick = son işlem görülen 5 dakikalık mum (date = mumun BAŞI; açılış/yüksek/düşük/kapanış + hacim).
//                            O mum henüz sürüyor olabilir: hacmi eksiktir.
//   lastDayCandlestick     = dünün kesin özeti (OHLC + satılan adet + VWAP)
// Satış arzı (borsadaki ilan derinliği) bu API'de yok; o alan boş (null) bırakılır.
//
// Gün içi satış tahmini: sürmekte olan mumun hacmi, mumun geçen kısmına bölünerek tam muma çıkarılır (en çok 5 kat).
// Tamamlanmış mum olduğu gibi alınır. Aynı mum iki turda görülürse yalnız fark eklenir (çift sayım olmaz).
// Dünün kesin rakamları gece lastDayCandlestick'ten yazılır; gün içi değerler yalnız tahmindir.
//
// Firestore'a yazılan biçim eskisiyle aynıdır, dashboard değişmeden okur:
//   live/r{realm}                  data = JSON {v, t, items: {id: [zaman, {q: [fiyat, arz, satış, tutar, sonİşlemZamanı]}]}}  HER turda
//   intraday/r{realm}_{gün}_s{NN}  t{SSDD} = JSON {id: {q: [fiyat, arz, satış, tutar]}}                                   10 dakikada bir
//   daily/r{realm}_{id}_{yıl}      d{AAGG} = JSON {q: [açılış, yüksek, düşük, kapanış, ortArz, satış, tutar]}
//   meta/mstate_r{realm}           data = JSON {v, t, w, q: {id: {q: [mumDk, mumTahmini, biriken satış, biriken tutar]}}}  (yalnız bot okur)
// Gün içi nokta 5 değil 10 dakikada bir yazılır: Firestore belgesi 1 MiB'ı geçmesin (parça başına ~10 ürün × 13 kalite).
// Aradaki turun satışları bir sonraki noktaya eklenir (meta/mstate içinde birikir).

import {
  CONFIG, PATHS, fetchPaced, fetchJson, createPacer, runPool, utcDay, hhmm, addDays, shardOf, range, round, parseJSON, runIfMain,
} from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 4;
const API = 'https://api.simcotools.com/v1';

// Simcotools sınırı: saniyede 2 istek (tüm ürünler ve realmler için ortak). 550 ms aralık güvenli pay bırakır.
// Aralık bu değerin altına inmez; sunucu 429 derse kendiliğinden yavaşlar.
const PACE = { concurrency: 2, startIntervalMs: 550, minIntervalMs: 550, maxIntervalMs: 4000, retries: 4 };
const FETCH_BUDGET_MS = 4 * 60_000; // 5 dakikalık aralığın içinde bitmeli (≈290 istek ≈ 160 sn)
const BUCKET = 5 * 60_000;          // mum süresi
const MIN_FRAC = 0.2;               // sürmekte olan mumun geçen kısmı bunun altına inmez (en çok 5 kat büyütme)
const WRITE_GAP_MS = 9 * 60_000;    // gün içi nokta en az bu aralıkla yazılır (≈ her ikinci tur)
const DAILY_MIN_SHARE = 0.5;        // dünün özeti: ürünlerin en az bu kadarında dünün mumu varsa yazılır

const num = (x) => (Number(x) > 0 ? Number(x) : null);

// Bir ürünün yanıtını sadeleştirir.
//  at    = yanıtın geldiği an (ms)
//  prev  = { t: ürünün önceki ölçüm zamanı, q: {kalite: [mumDk, mumTahmini, biriken satış, biriken tutar]} } ya da null
//  quals[q] = { price, lt (son işlem zamanı), sold (bu turda tahmini satış), value (tahmini tutar), cMin, cEst }
//  daily[q] = { day, row } dünün kesin özeti
export function parseSummaries(json, at, prev = null) {
  const list = json?.resource?.summariesByQuality;
  if (!Array.isArray(list)) throw new Error('beklenmeyen borsa yanıtı');
  const quals = {};
  const daily = {};
  // Önceki turun dilimi ya da sonrası: bundan eski mumda yeni işlem yoktur. İlk turda içinde bulunulan ve bir önceki dilim sayılır.
  const sinceBucket = prev?.t ? Math.floor(prev.t / BUCKET) * BUCKET : Math.floor(at / BUCKET) * BUCKET - BUCKET;
  for (const s of list) {
    const q = Number(s?.quality);
    if (!Number.isInteger(q) || q < 0 || q > 20) continue;
    const price = num(s.price);
    const ltMs = Date.parse(s.timestamp);
    const old = prev?.q?.[q];
    let cMin = Number.isFinite(old?.[0]) ? old[0] : null;
    let cEst = Number(old?.[1]) || 0;
    let sold = 0;
    let ref = price;

    const c = s.fiveMinutesCandlestick;
    const cStart = Date.parse(c?.date);
    if (c && Number.isFinite(cStart) && cStart >= sinceBucket) {
      const volume = Math.max(0, Number(c.volume) || 0);
      // Mum bittiyse hacim kesindir; sürüyorsa geçen kısma bölünerek tam muma çıkarılır.
      const frac = at >= cStart + BUCKET ? 1 : Math.min(1, Math.max(MIN_FRAC, (at - cStart) / BUCKET));
      const est = Math.round(volume / frac);
      const minute = Math.floor(cStart / 60_000);
      if (cMin === minute) sold = Math.max(0, est - cEst); // aynı mum daha önce de görüldü: yalnız fark
      else sold = est;
      cEst = cMin === minute ? Math.max(est, cEst) : est;
      cMin = minute;
      if (num(c.close)) ref = num(c.close);
    }
    quals[q] = { price, lt: Number.isFinite(ltMs) ? ltMs : null, sold, value: ref ? round(sold * ref, 2) : 0, cMin, cEst };

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
  return { quals, daily };
}

// Tur satışlarını biriktirir. write=true ise gün içi noktaya birikmiş toplam yazılır ve birikim sıfırlanır.
//  prevQ  = meta/mstate'teki bu ürünün önceki durumu {kalite: [mumDk, mumTahmini, accS, accV]}
//  Dönüş: intraday (10 dk noktası), live (canlı belge), state (yeni durum)
export function accumulate(prevQ, quals, write) {
  const intraday = {};
  const live = {};
  const state = {};
  for (const [q, x] of Object.entries(quals)) {
    const old = prevQ?.[q];
    const accS = (Number(old?.[2]) || 0) + x.sold;
    const accV = round((Number(old?.[3]) || 0) + x.value, 2);
    intraday[q] = [x.price, null, Math.round(accS), accV];
    live[q] = [x.price, null, x.sold, x.value, x.lt];
    state[q] = [x.cMin, x.cEst, write ? 0 : accS, write ? 0 : accV];
  }
  for (const [q, v] of Object.entries(prevQ || {})) if (!(q in quals)) state[q] = v; // bu turda görünmeyen kalite durumunu korur
  return { intraday, live, state };
}

// Dünün mumu olan ürünler: [[id, {kalite: satır}], ...]
export function yesterdayRows(dailyRows, yesterday) {
  const out = [];
  for (const [id, qualities] of Object.entries(dailyRows || {})) {
    const byQ = {};
    for (const [q, d] of Object.entries(qualities || {})) if (d.day === yesterday) byQ[q] = d.row;
    if (Object.keys(byQ).length) out.push([id, byQ]);
  }
  return out;
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
  const stateKey = (r) => PATHS.meta(`mstate_r${r}`);

  // 1) Önceki durumu tek istekte oku
  const docs = await db.getMany([PATHS.meta('tradable'), PATHS.meta('rollup'), ...realms.map(PATHS.live), ...realms.map(stateKey)]);
  const marker = docs.get(PATHS.meta('rollup'));

  // 2) Hangi ürünler çekilecek
  let tradable = parseJSON(docs.get(PATHS.meta('tradable'))?.data);
  if (!tradable) {
    const all = await fetchJson(`${CONFIG.simcoBase}/api/v2/constants/resources/`, { deadline });
    const ids = Object.values(all).filter((x) => x?.isExchangeTradable).map((x) => Number(x.dbLetter)).filter(Number.isFinite);
    tradable = Object.fromEntries(realms.map((r) => [r, ids.sort((a, b) => a - b)]));
  }
  const prevLive = {};
  const prevState = {};
  for (const r of realms) {
    prevLive[r] = parseJSON(docs.get(PATHS.live(r))?.data)?.items || {};
    prevState[r] = parseJSON(docs.get(stateKey(r))?.data) || {};
  }
  // Gün içi nokta bu turda yazılsın mı: son yazımdan en az 9 dakika geçtiyse (her ikinci tur)
  const writeNow = Object.fromEntries(realms.map((r) => [r, !(t0 - (Number(prevState[r].w) || 0) < WRITE_GAP_MS)]));

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
  const newState = Object.fromEntries(realms.map((r) => [r, { ...(prevState[r].q || {}) }]));
  const dailyRows = Object.fromEntries(realms.map((r) => [r, {}]));

  tasks.forEach(({ r, id }, i) => {
    const res = results[i];
    if (!res || res.error?.deadline) { stats[r].skipped++; return; }
    try {
      if (!res.ok) throw res.error;
      const prevItem = prevLive[r]?.[id];
      const prev = { t: prevItem?.[0] ?? null, q: prevState[r].q?.[id] };
      const { quals, daily } = parseSummaries(res.value.data, res.value.at, prev);
      if (!Object.keys(quals).length) throw new Error('kalite verisi yok');
      const acc = accumulate(prev.q, quals, writeNow[r]);
      newLive[r][id] = [res.value.at, acc.live];
      newState[r][id] = acc.state;
      if (writeNow[r]) {
        ((intraday[`${r}_${shardOf(id)}`] ||= {})[id] = acc.intraday);
        touched.add(`${r}_${shardOf(id)}`);
      }
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
      const w = writeNow[r] && stats[r].ok > 0 ? t0 : Number(prevState[r].w) || 0;
      writes.push({ type: 'set', path: stateKey(r), data: { data: JSON.stringify({ v: 1, t: t0, w, q: newState[r] }), u: t0 } });
    }
  }

  // Dünün kesin özeti: gün değişince her realm için bir kez yazılır. Ürünlerin en az %90'ı çekilmiş ve
  // en az yarısında dünün mumu gelmiş olmalı (Simcotools günü henüz kapatmadıysa sonraki tur yeniden dener).
  const markerNext = {};
  let dailyCount = 0;
  for (const r of realms) {
    const key = `lastDay_r${r}`;
    const total = (tradable[r] || []).length;
    if (marker?.[key] && marker[key] >= yesterday) continue;
    if (!total || stats[r].ok < total * 0.9) continue;
    const rows = yesterdayRows(dailyRows[r], yesterday);
    if (rows.length < total * DAILY_MIN_SHARE) continue;
    const dayField = `d${yesterday.slice(5, 7)}${yesterday.slice(8, 10)}`;
    for (const [id, summaryByQ] of rows) {
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
  const status = { v: VERSION, t: t0, fetchMs, totalMs: Date.now() - t0, throttled, rate, stats, errors, wrote: writeNow };
  writes.push({ type: 'set', path: PATHS.meta('status'), data: { data: JSON.stringify(status), u: t0 } });
  await db.commit(writes);

  console.log(`DentSimco borsa | ${summary} | 429=${throttled} | hız=${rate.perSec}/sn aralık=${rate.intervalMs}ms | çekme=${(fetchMs / 1000).toFixed(1)}sn | toplam=${((Date.now() - t0) / 1000).toFixed(1)}sn | gün içi nokta: ${realms.map((r) => `r${r}=${writeNow[r] ? 'yazıldı' : 'birikti'}`).join(' ')}${dailyCount ? ` | günlük özet=${dailyCount} ürün` : ''}`);
  if (errors.length) console.log('İlk hatalar:', errors.slice(0, 5).join(' ; '));
  const missing = realms.reduce((sum, r) => sum + stats[r].skipped + stats[r].fail, 0);
  if (missing > 0) console.log(`UYARI: ${missing} ürün bu çalışmada çekilemedi; sonraki çalışma en eski üründen devam eder.`);
  if (pacer.stat.note || pacer.stat.retryAfterSeen) console.log(`Sunucu yanıtı (429): ${pacer.stat.note || '-'} | en uzun bekleme=${((pacer.stat.longestPauseMs) / 1000).toFixed(1)}sn`);
  if (totalOk === 0) throw new Error('Hiçbir ürün çekilemedi. Simcotools API erişimini kontrol et.');
}

runIfMain(import.meta.url, main);
