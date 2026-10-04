// DentSimco Bot v2 — Canlı borsa toplayıcı
// GitHub Actions bunu 15 dakikada bir çalıştırır (.github/workflows/borsa.yml).
// Her çalışmada: iki realm, borsada satılan tüm ürünler, her kalite ayrı ayrı.

import {
  CONFIG, PATHS, fetchJson, fetchPaced, createPacer, runPool, utcDay, hhmm, addDays, shardOf, range, round, parseJSON, runIfMain,
} from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 2;

// ---- Borsa ilanlarını okuma -------------------------------------------------

export function parseOrders(json) {
  const list = Array.isArray(json) ? json : json?.results ?? json?.orders ?? json?.data;
  if (!Array.isArray(list)) throw new Error('beklenmeyen borsa yanıtı');
  const orders = [];
  for (const o of list) {
    const p = Number(o?.price);
    const n = Number(o?.quantity ?? o?.amount);
    const q = Number(o?.quality ?? 0);
    if (!(p > 0) || !(n > 0) || !Number.isInteger(q) || q < 0 || q > 20) continue;
    const id = Number(o?.id) || 0;
    const seller = Number(o?.seller?.id ?? o?.seller_id ?? o?.sellerId ?? (typeof o?.seller === 'number' ? o.seller : 0)) || 0;
    orders.push({ id, q, p, n, s: seller });
  }
  return orders;
}

function unpack(flat) {
  const list = [];
  if (!Array.isArray(flat)) return list;
  for (let i = 0; i + 4 < flat.length; i += 5) {
    list.push({ id: flat[i], q: flat[i + 1], p: flat[i + 2], n: flat[i + 3], s: flat[i + 4] });
  }
  return list;
}

// Her kalite için: [en düşük fiyat, arz, tahmini satış adedi, tahmini satış tutarı]
// Satış tahmini: önceki ölçümdeki ilanlar ile şimdiki ilanlar karşılaştırılır.
//  - İlanın adedi azaldıysa aradaki fark satılmıştır.
//  - İlan kaybolduysa ve fiyatı, hâlâ duran en ucuz eski ilandan düşükse satılmıştır.
//    (Alıcılar hep en ucuzdan başlar; pahalı ilanın kaybolması genelde iptaldir.)
//  - Aynı satıcı aynı kalitede yeni ilan açtıysa bu "fiyat değiştirme" sayılır, satış sayılmaz.
export function computeMetrics(orders, prevFlat) {
  const byQ = new Map();
  const slot = (q) => {
    let m = byQ.get(q);
    if (!m) byQ.set(q, (m = { p: Infinity, a: 0, s: 0, v: 0 }));
    return m;
  };
  for (const o of orders) {
    const m = slot(o.q);
    if (o.p < m.p) m.p = o.p;
    m.a += o.n;
  }

  const prev = unpack(prevFlat);
  const trackable = prevFlat !== undefined && orders.every((o) => o.id) && !(orders.length === 0 && prev.length > 20);

  if (trackable) {
    const current = new Map(orders.map((o) => [o.id, o]));
    const prevIds = new Set(prev.map((p) => p.id));
    const survivorMin = new Map();
    for (const p of prev) {
      if (current.has(p.id) && p.p < (survivorMin.get(p.q) ?? Infinity)) survivorMin.set(p.q, p.p);
    }
    const fresh = new Map();
    for (const o of orders) {
      if (!prevIds.has(o.id) && o.s) fresh.set(`${o.s}:${o.q}`, (fresh.get(`${o.s}:${o.q}`) || 0) + o.n);
    }
    for (const p of prev) {
      const now = current.get(p.id);
      let sold = 0;
      if (now) {
        if (now.n < p.n) sold = p.n - now.n;
      } else if (p.p <= (survivorMin.get(p.q) ?? Infinity) + 1e-9) {
        sold = p.n;
        const key = `${p.s}:${p.q}`;
        const relisted = p.s ? fresh.get(key) || 0 : 0;
        if (relisted > 0) {
          const used = Math.min(relisted, sold);
          sold -= used;
          fresh.set(key, relisted - used);
        }
      }
      if (sold > 0) {
        const m = slot(p.q);
        m.s += sold;
        m.v += sold * p.p;
      }
    }
  }

  const out = {};
  for (const [q, m] of [...byQ].sort((x, y) => x[0] - y[0])) {
    out[q] = [
      Number.isFinite(m.p) ? m.p : null,
      m.a,
      trackable ? m.s : null,
      trackable ? round(m.v, 2) : null,
    ];
  }
  return out;
}

// Bir sonraki karşılaştırma için her kalitenin en ucuz ilanlarını saklar.
export function buildState(orders, maxPerQuality = CONFIG.stateMaxPerQuality) {
  if (!orders.every((o) => o.id)) return [];
  const counts = new Map();
  const flat = [];
  for (const o of [...orders].sort((x, y) => x.p - y.p)) {
    const c = counts.get(o.q) || 0;
    if (c >= maxPerQuality) continue;
    counts.set(o.q, c + 1);
    flat.push(o.id, o.q, o.p, o.n, o.s);
  }
  return flat;
}

function shrinkState(items, limit = 800_000) {
  let text = JSON.stringify(items);
  let cap = CONFIG.stateMaxPerQuality;
  while (text.length > limit && cap > 10) {
    cap = Math.floor(cap / 2);
    for (const id of Object.keys(items.items)) {
      items.items[id] = buildState(unpack(items.items[id]), cap);
    }
    text = JSON.stringify(items);
  }
  return text;
}

function interleave(lists) {
  const out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// ---- Günlük özet (gece ilk çalışmada) ---------------------------------------

export function summarize(points) {
  let open = null, high = null, low = null, close = null;
  let supplySum = 0, supplyN = 0, sold = 0, value = 0, soldN = 0;
  for (const [p, a, s, v] of points) {
    if (p != null) {
      if (open == null) open = p;
      close = p;
      high = high == null ? p : Math.max(high, p);
      low = low == null ? p : Math.min(low, p);
    }
    if (a != null) { supplySum += a; supplyN++; }
    if (s != null) { sold += s; value += v || 0; soldN++; }
  }
  return [open, high, low, close, supplyN ? Math.round(supplySum / supplyN) : 0, soldN ? sold : null, soldN ? round(value, 2) : null];
}

async function rollup(db, marker, today) {
  const yesterday = addDays(today, -1);
  const next = {};
  const writes = [];
  let days = 0;
  for (const r of CONFIG.realms) {
    const key = `lastDay_r${r}`;
    let last = marker?.[key];
    if (!last) { next[key] = yesterday; continue; }
    let n = 0;
    while (last < yesterday && n < CONFIG.maxRollupDaysPerRun) {
      const day = addDays(last, 1);
      const paths = range(CONFIG.shards).map((s) => PATHS.intraday(r, day, s));
      const docs = await db.getMany(paths);
      const series = {};
      for (const path of paths) {
        const fields = docs.get(path);
        if (!fields) continue;
        for (const k of Object.keys(fields).filter((f) => /^t\d{4}$/.test(f)).sort()) {
          const snapshot = parseJSON(fields[k]);
          if (!snapshot) continue;
          for (const [id, qualities] of Object.entries(snapshot)) {
            for (const [q, m] of Object.entries(qualities)) ((series[id] ||= {})[q] ||= []).push(m);
          }
        }
      }
      const field = `d${day.slice(5, 7)}${day.slice(8, 10)}`;
      for (const [id, qualities] of Object.entries(series)) {
        const summary = {};
        for (const [q, points] of Object.entries(qualities)) summary[q] = summarize(points);
        writes.push({ type: 'merge', path: PATHS.daily(r, id, day.slice(0, 4)), data: { [field]: JSON.stringify(summary), u: Date.now() } });
      }
      const expired = addDays(day, -CONFIG.rawRetentionDays);
      for (let s = 0; s < CONFIG.shards; s++) writes.push({ type: 'delete', path: PATHS.intraday(r, expired, s) });
      last = day;
      n++;
      days++;
    }
    next[key] = last;
  }
  writes.push({ type: 'merge', path: PATHS.meta('rollup'), data: { ...next, u: Date.now() } });
  await db.commit(writes);
  return days;
}

// ---- Ana akış ---------------------------------------------------------------

export async function main() {
  const t0 = Date.now();
  if (typeof fetch !== 'function') throw new Error('Node 18 veya üstü gerekli');
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const { realms, shards } = CONFIG;
  const day = utcDay(t0);
  const field = `t${hhmm(t0)}`;

  // 1) Önceki durumu tek istekte oku
  const metaPaths = [PATHS.meta('tradable'), PATHS.meta('rollup'), ...realms.map(PATHS.live)];
  const statePaths = realms.flatMap((r) => range(shards).map((s) => PATHS.state(r, s)));
  const docs = await db.getMany([...metaPaths, ...statePaths]);

  const marker = docs.get(PATHS.meta('rollup'));
  const yesterday = addDays(day, -1);
  const needsRollup = realms.some((r) => !marker?.[`lastDay_r${r}`] || marker[`lastDay_r${r}`] < yesterday);
  const deadline = t0 + (needsRollup ? CONFIG.fetchBudgetOnRollupMs : CONFIG.fetchBudgetMs);

  // 2) Hangi ürünler çekilecek
  let tradable = parseJSON(docs.get(PATHS.meta('tradable'))?.data);
  if (!tradable) {
    const all = await fetchJson(`${CONFIG.simcoBase}/api/v2/constants/resources/`, { deadline });
    const ids = Object.values(all).filter((x) => x?.isExchangeTradable).map((x) => Number(x.dbLetter)).filter(Number.isFinite);
    tradable = Object.fromEntries(realms.map((r) => [r, ids.sort((a, b) => a - b)]));
  }

  const prevState = {};
  const prevLive = {};
  for (const r of realms) {
    prevState[r] = {};
    for (let s = 0; s < shards; s++) Object.assign(prevState[r], parseJSON(docs.get(PATHS.state(r, s))?.data)?.items);
    prevLive[r] = parseJSON(docs.get(PATHS.live(r))?.data)?.items || {};
  }

  // 3) Borsayı çek. En uzun süredir güncellenmeyen (ya da hiç çekilmemiş) ürünler öne alınır,
  //    böylece sunucu hız sınırı koysa bile her çalışmada sıradaki ürünlerden devam edilir.
  let tasks = interleave(realms.map((r) => (tradable[r] || []).map((id) => ({ r, id: Number(id) }))));
  // Öncelik = "bayatlık". Sık kullanılan ürünlerin bayatlığı hotFactor kat sayılır, böylece daha sık sıra gelir.
  const hot = new Set(CONFIG.hotProducts || []);
  const staleness = (t) => {
    const seen = prevLive[t.r]?.[t.id]?.[0];
    if (!seen) return Infinity; // hiç çekilmemiş ürünler en öne
    return (t0 - seen) * (hot.has(t.id) ? CONFIG.hotFactor || 1 : 1);
  };
  tasks = tasks.map((t, i) => ({ t, i, s: staleness(t) })).sort((a, b) => (b.s - a.s) || (a.i - b.i)).map((x) => x.t);

  const pacer = createPacer({ deadline, ...CONFIG.market });
  // Çalışma uzun sürebileceği için dakikada bir ilerleme satırı yazılır (Actions log'unda görünür).
  const progress = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const rate = pacer.stat.ok && sec ? (pacer.stat.ok / sec).toFixed(2) : '0';
    console.log(`… ${sec} sn: ${pacer.stat.ok}/${tasks.length} ürün çekildi, hız ${rate}/sn, 429=${pacer.stat.throttled}`);
  }, 60_000);
  progress.unref?.();

  // Her ürünün gerçek çekilme zamanı ayrıca tutulur (çalışma uzun sürerse ürünler farklı anlarda çekilir).
  const results = await runPool(
    tasks,
    async (t) => {
      const data = await fetchPaced(`${CONFIG.simcoBase}/api/v3/market/${t.r}/${t.id}/`, pacer, { deadline, retries: CONFIG.market.retries });
      return { data, at: Date.now() };
    },
    { concurrency: CONFIG.market.concurrency, delayMs: 0, deadline },
  );
  clearInterval(progress);
  const throttled = pacer.stat.throttled;
  const fetchMs = Date.now() - t0;

  // 4) Hesapla
  const stats = Object.fromEntries(realms.map((r) => [r, { ok: 0, fail: 0, skipped: 0 }]));
  const errors = [];
  const intraday = {};
  const touched = new Set();
  const newState = Object.fromEntries(realms.map((r) => [r, { ...prevState[r] }]));
  const newLive = Object.fromEntries(realms.map((r) => [r, { ...prevLive[r] }]));

  tasks.forEach(({ r, id }, i) => {
    const res = results[i];
    if (!res || res.error?.deadline) { stats[r].skipped++; return; }
    try {
      if (!res.ok) throw res.error;
      const orders = parseOrders(res.value.data);
      const metrics = computeMetrics(orders, prevState[r][id]);
      newState[r][id] = buildState(orders);
      newLive[r][id] = [res.value.at, metrics];
      ((intraday[`${r}_${shardOf(id)}`] ||= {})[id] = metrics);
      touched.add(`${r}_${shardOf(id)}`);
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
        const items = {};
        for (const [id, flat] of Object.entries(newState[r])) if (shardOf(id) === s) items[id] = flat;
        writes.push({ type: 'set', path: PATHS.state(r, s), data: { data: shrinkState({ t: t0, items }), u: t0 } });
      }
      writes.push({ type: 'set', path: PATHS.live(r), data: { data: JSON.stringify({ v: VERSION, t: t0, items: newLive[r] }), u: t0 } });
    }
  }
  const rate = { perSec: pacer.stat.ok && fetchMs ? round(pacer.stat.ok / (fetchMs / 1000), 2) : 0, intervalMs: pacer.interval, retryAfterMs: pacer.stat.retryAfterSeen, note: pacer.stat.note };
  const status = { v: VERSION, t: t0, fetchMs, totalMs: Date.now() - t0, throttled, rate, stats, errors };
  writes.push({ type: 'set', path: PATHS.meta('status'), data: { data: JSON.stringify(status), u: t0 } });
  await db.commit(writes);

  // 6) Gün değiştiyse dünün özetini çıkar
  let rolled = 0;
  if (needsRollup && totalOk > 0) rolled = await rollup(db, marker, day);

  console.log(`DentSimco borsa | ${summary} | 429=${throttled} | hız=${rate.perSec}/sn aralık=${rate.intervalMs}ms | çekme=${(fetchMs / 1000).toFixed(1)}sn | toplam=${((Date.now() - t0) / 1000).toFixed(1)}sn${rolled ? ` | günlük özet=${rolled}` : ''}`);
  if (errors.length) console.log('İlk hatalar:', errors.slice(0, 5).join(' ; '));
  const missing = realms.reduce((sum, r) => sum + stats[r].skipped + stats[r].fail, 0);
  if (missing > 0) console.log(`UYARI: ${missing} ürün bu çalışmada çekilemedi; sonraki çalışma en eski üründen devam eder.`);
  if (pacer.stat.note || pacer.stat.retryAfterSeen) console.log(`Sunucu yanıtı (429): ${pacer.stat.note || '-'} | en uzun bekleme=${((pacer.stat.longestPauseMs) / 1000).toFixed(1)}sn`);
  if (totalOk === 0) throw new Error('Hiçbir ürün çekilemedi. Oyun API erişimini kontrol et.');
}

runIfMain(import.meta.url, main);
