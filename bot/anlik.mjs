// DentSimco Bot — Anlık borsa toplayıcı (Sim Companies oyun API'si)
// GitHub Actions bunu ayrı bir iş akışında çalıştırır (.github/workflows/anlik-borsa.yml). SimcoTools borsa botundan (market.mjs,
// borsa.yml) bağımsızdır: ikisi aynı anda çalışabilir, birinin hatası ya da yavaşlığı ötekini etkilemez.
//
// Her ürün için GET /api/v3/market/all/{realm}/{ürün}/ → kalite başına anlık borsa fiyatı (ask: kalitesi ≥ q olan en ucuz ilan)
// ve satış arzı (tam q kalitesindeki toplam adet). Ayrıntı: exchange.mjs.
//
// Hız: sabit saniyede 2 istek (500 ms aralık, en çok 2 istek aynı anda). 429 gelirse 1 saniye beklenir ve devam edilir;
// o ürün kuyruğun sonuna eklenir. Tur tüm ürünler bitene kadar sürer (iş en çok BUDGET_MS); bitmeyen ürünler sonraki turda öne alınır.
// Veri tur sürerken parça parça yazılır (FLUSH_MS'de bir), dashboard tur bitmeden dolmaya başlar.
//
// Firestore'a yazılan (SimcoTools botunun alanlarına dokunmaz; hepsi alan bazında birleştirilerek yazılır):
//   live/r{realm}                 anlik = JSON {v, t, items: {id: [askZamanı, {q: [ask, arz]}]}}
//   intraday/r{realm}_{gün}_a{NN} a{SSDD} = JSON {id: {q: [ask, arz]}}     ürün başına en sık 10 dakikada bir örnek
//   daily/r{realm}_{id}_{yıl}     a{AAGG} = JSON {q: ortalama arz}          gün bitince bir kez
//   botstate/xstate_r{realm}      günlük ortalama arz için örnek toplamları (yalnız bu bot okur)
//   meta/anlik_status             son çalışmanın özeti

import { CONFIG, PATHS, HEADERS, sleep, parseJSON, runIfMain, utcDay, addDays, hhmm, shardOf } from './common.mjs';
import { Firestore } from './firestore.mjs';
import { parseOrders, summarizeOrders, addSupplySamples, averageSupply } from './exchange.mjs';

const VERSION = 1;
const RATE_MS = 500;                    // saniyede 2 istek (sabit)
const MAX_INFLIGHT = 2;                 // aynı anda en çok 2 istek
const PAUSE_429_MS = 1000;              // 429 gelince 1 saniye bekle, sonra devam
const MAX_TRIES = 3;                    // 429 dışındaki hatalarda (5xx, ağ) ürün başına deneme
const BUDGET_MS = 320 * 60_000;         // iş en çok bu kadar sürer (GitHub işi 6 saatte kesilir)
const FLUSH_MS = 2 * 60_000;            // canlı veri en sık bu aralıkla yazılır
const INTRADAY_GAP_MS = 9 * 60_000;     // bir ürünün gün içi örneği en sık bu aralıkla alınır
const INTRADAY_FLUSH_MS = 10 * 60_000;  // gün içi örnekler bu aralıkla yazılır
const REQUEST_TIMEOUT_MS = 15_000;

// Oyun geliştiricisinin tanımladığı tanıma başlığı (doluysa her isteğe eklenir)
const EX_HEADERS = process.env.SIMCO_HEADER_NAME && process.env.SIMCO_HEADER_VALUE
  ? { ...HEADERS, [process.env.SIMCO_HEADER_NAME]: process.env.SIMCO_HEADER_VALUE } : HEADERS;

const dayField = (day) => `a${day.slice(5, 7)}${day.slice(8, 10)}`;

/** Tek istek: { status, json, note } döner, ağ hatasında status 0 */
async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: EX_HEADERS, signal: controller.signal });
    if (res.status === 429) {
      let note = null;
      try { note = (await res.text()).replace(/\s+/g, ' ').slice(0, 200); } catch { /* önemsiz */ }
      return { status: 429, note };
    }
    if (!res.ok) return { status: res.status };
    return { status: res.status, json: await res.json() };
  } catch (e) {
    return { status: 0, note: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export const newStat = () => ({ ok: 0, fail: 0, throttled: 0, requests: 0, note: null, errors: [], left: 0 });

/**
 * Kuyruğu sabit hızla işler. handle(task, json, at) başarılı yanıtı işler; tick() her döngüde çağrılır (ara yazım için).
 * 429: PAUSE_429_MS beklenir, ürün kuyruğun sonuna eklenir (sınırsız; süre dolana kadar). Diğer hatalar: MAX_TRIES'tan sonra bırakılır.
 */
export async function runQueue(tasks, { fetcher, handle, tick, deadline, now = Date.now, wait = sleep, rateMs = RATE_MS, pauseMs = PAUSE_429_MS, stat = newStat() } = {}) {
  const queue = [...tasks];
  const inflight = new Set();
  let nextAt = 0;
  const run = async (task) => {
    stat.requests++;
    const res = await fetcher(task);
    if (res.status === 429) {
      stat.throttled++;
      if (!stat.note && res.note) stat.note = res.note;
      nextAt = Math.max(nextAt, now() + pauseMs);
      queue.push(task);
      return;
    }
    if (res.json !== undefined) {
      try { handle(task, res.json, now()); stat.ok++; return; } catch (e) { res.status = -1; res.note = e?.message || String(e); }
    }
    task.tries = (task.tries || 0) + 1;
    if (task.tries < MAX_TRIES) { queue.push(task); return; }
    stat.fail++;
    if (stat.errors.length < 10) stat.errors.push(`r${task.r}/${task.id}: ${res.status ? `HTTP ${res.status}` : 'ağ'}${res.note ? ` ${res.note}` : ''}`);
  };
  while ((queue.length || inflight.size) && now() < deadline) {
    if (tick) await tick();
    if (queue.length && inflight.size < MAX_INFLIGHT && now() >= nextAt) {
      const task = queue.shift();
      nextAt = now() + rateMs;
      const p = run(task).finally(() => inflight.delete(p));
      inflight.add(p);
      continue;
    }
    await wait(20);
  }
  await Promise.all(inflight);
  stat.left = queue.length;
  return stat;
}

export async function main() {
  const t0 = Date.now();
  if (typeof fetch !== 'function') throw new Error('Node 18 veya üstü gerekli');
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const { realms } = CONFIG;
  const deadline = t0 + BUDGET_MS;
  const stateKey = (r) => PATHS.botState(`xstate_r${r}`);

  const docs = await db.getMany([PATHS.meta('tradable'), ...realms.map(PATHS.live), ...realms.map(stateKey)]);
  let tradable = parseJSON(docs.get(PATHS.meta('tradable'))?.data);
  if (!tradable) {
    const res = await fetchOnce(`${CONFIG.simcoBase}/api/v2/constants/resources/`);
    const ids = Object.values(res.json || {}).filter((x) => x?.isExchangeTradable).map((x) => Number(x.dbLetter)).filter(Number.isFinite);
    tradable = Object.fromEntries(realms.map((r) => [r, ids.sort((a, b) => a - b)]));
  }
  const items = {};
  const st = {};
  for (const r of realms) {
    items[r] = parseJSON(docs.get(PATHS.live(r))?.anlik)?.items || {};
    st[r] = parseJSON(docs.get(stateKey(r))?.data) || {};
    st[r].q ||= {};
    st[r].iw ||= {};
  }

  // Anlık verisi en eski ürün önce (realm'ler sırayla karışık)
  const lists = realms.map((r) => (tradable[r] || []).map((id) => ({ r, id: Number(id) }))
    .sort((a, b) => (Number(items[r]?.[a.id]?.[0]) || 0) - (Number(items[r]?.[b.id]?.[0]) || 0)));
  const tasks = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) for (const l of lists) if (i < l.length) tasks.push(l[i]);

  const buffer = {}; // `${r}_${parça}` → {id: {q: [ask, arz]}}: yazılmayı bekleyen gün içi örnekler
  let dirty = false;
  let lastFlush = Date.now();
  let lastIntraday = Date.now();
  let stat = null;

  const handle = (t, json, at) => {
    const summary = summarizeOrders(parseOrders(json));
    const rows = Object.fromEntries(Object.entries(summary).map(([q, v]) => [q, [v.ask, v.supply]]));
    items[t.r][t.id] = [at, rows];
    st[t.r].q[t.id] = addSupplySamples(st[t.r].q[t.id] || {}, summary, utcDay(at));
    if (!(at - (Number(st[t.r].iw[t.id]) || 0) < INTRADAY_GAP_MS)) {
      (buffer[`${t.r}_${shardOf(t.id)}`] ||= {})[t.id] = rows;
      st[t.r].iw[t.id] = at;
    }
    dirty = true;
  };

  async function flush(final) {
    const now = Date.now();
    const writes = [];
    for (const r of realms) {
      writes.push({ type: 'merge', path: PATHS.live(r), data: { anlik: JSON.stringify({ v: VERSION, t: now, items: items[r] }), au: now } });
    }
    if (final || now - lastIntraday >= INTRADAY_FLUSH_MS) {
      const day = utcDay(now);
      const field = `a${hhmm(now)}`;
      for (const [key, rows] of Object.entries(buffer)) {
        const [r, s] = key.split('_').map(Number);
        writes.push({ type: 'merge', path: PATHS.intradayAnlik(r, day, s), data: { [field]: JSON.stringify(rows), u: now } });
        delete buffer[key];
      }
      lastIntraday = now;
    }
    // Gün bitince: dünün ortalama arzı (bir kez) ve süresi dolan gün içi belgeler
    const yesterday = addDays(utcDay(now), -1);
    for (const r of realms) {
      if (st[r].dd === yesterday) continue;
      for (const [id, byQ] of Object.entries(st[r].q)) {
        const avg = {};
        for (const [q, s] of Object.entries(byQ || {})) { const a = averageSupply(s, yesterday); if (a != null) avg[q] = a; }
        if (Object.keys(avg).length) writes.push({ type: 'merge', path: PATHS.daily(r, id, yesterday.slice(0, 4)), data: { [dayField(yesterday)]: JSON.stringify(avg), u: now } });
      }
      const expired = addDays(yesterday, -CONFIG.rawRetentionDays);
      for (let s = 0; s < CONFIG.shards; s++) writes.push({ type: 'delete', path: PATHS.intradayAnlik(r, expired, s) });
      st[r].dd = yesterday;
    }
    for (const r of realms) writes.push({ type: 'set', path: stateKey(r), data: { data: JSON.stringify({ v: VERSION, t: now, ...st[r] }), u: now } });
    if (stat) writes.push({ type: 'set', path: PATHS.meta('anlik_status'), data: { data: JSON.stringify({ v: VERSION, t: t0, at: now, final, ...stat, total: tasks.length }), u: now } });
    await db.commit(writes);
    dirty = false;
    lastFlush = now;
  }

  let flushing = null;
  const tick = async () => {
    if (flushing) return;
    if (dirty && Date.now() - lastFlush >= FLUSH_MS) {
      flushing = flush(false).catch((e) => console.log(`Ara yazım hatası: ${e?.message || e}`)).finally(() => { flushing = null; });
    }
  };
  const progress = setInterval(() => {
    const s = stat || {};
    console.log(`… ${Math.round((Date.now() - t0) / 1000)} sn: ${s.ok ?? 0}/${tasks.length} ürün, 429=${s.throttled ?? 0}, istek=${s.requests ?? 0}`);
  }, 60_000);
  progress.unref?.();

  stat = newStat(); // kuyruk bu nesneyi canlı günceller; ara yazımlar meta/anlik_status'a güncel sayıları yazar
  const result = await runQueue(tasks, {
    fetcher: (t) => fetchOnce(`${CONFIG.simcoBase}/api/v3/market/all/${t.r}/${t.id}/`),
    handle,
    tick,
    deadline,
    stat,
  });
  clearInterval(progress);
  if (flushing) await flushing;
  await flush(true);

  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(`DentSimco anlık borsa | tamam=${result.ok}/${tasks.length} hata=${result.fail} kalan=${result.left} | 429=${result.throttled} | istek=${result.requests} | ${sec} sn${EX_HEADERS === HEADERS ? '' : ' | tanıma başlığı: var'}`);
  if (result.note) console.log(`Sunucu yanıtı (429): ${result.note}`);
  if (result.errors.length) console.log('İlk hatalar:', result.errors.slice(0, 5).join(' ; '));
  if (result.ok === 0) throw new Error('Hiçbir ürünün anlık borsa verisi alınamadı.');
}

runIfMain(import.meta.url, main);
