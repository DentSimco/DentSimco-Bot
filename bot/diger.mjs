// DentSimco Bot — "Diğer" bölümünün verisi: Government Order (devlet siparişi), bina verileri, ekonomi evreleri, sertifikalar
// GitHub Actions saatte bir çalıştırır (.github/workflows/diger.yml). İki realm (0 ve 1).
//
// Hız: iki kaynak (Simcotools ve Sim Companies) için TEK kapı; iki istek arası en az GAP_MS (saniyede 2 istekten az).
// 429 gelirse WAIT_429_MS beklenir ve aynı istek yeniden denenir. Yalnız GET isteği atılır.
//
// Kaynaklar (GET):
//   Sim Companies  /api/v3/government-orders/{realm}/                ilandaki ve yürüyen siparişler (miktar, çarpan, tahmini değer)
//                  /api/v2/building-auctions/{realm}/                açık bina açık artırmaları
//                  /api/v2/certificates-explorer/{realm}/latest/     son verilen sertifikalar
//                  /api/v2/certificates-explorer/{realm}/rarest/     sertifika nadirliği
//                  /api/v2/certificates-explorer/{realm}/certificate/{tür}/-/-/   türü taşıyan şirket sayısı, en çok toplayanlar
//   Simcotools     /v1/realms/{realm}                                realm özeti (bugün)
//                  /v1/realms/{realm}/summaries                      günlük realm özeti (2022'den bu yana)
//                  /v1/realms/{realm}/phases | events | contests      ekonomi evreleri, üretim olayları, yarışmalar
//                  /v1/realms/{realm}/government-orders              geçmiş siparişlerin tamamı (miktarsız)
//                  /v1/realms/{realm}/stats/buildings                bina türü başına sayı
//                  /v1/realms/{realm}/certificates[/{tür}]           sertifika türleri ve kazananları
//
// Firestore'a yazılan (dashboard public/diger*.js okur; hepsi data = JSON):
//   meta/go_r{realm}        {v, t, stT, orders: {id: {id, k, n, c, d, s, m, e, r: [[ürün, kalite, temelMiktar|null]], f, l}}}
//                           k = proje anahtarı, n = İngilizce proje adı, c = oluşturulma (ms), d = teslim günü, s = büyüklük,
//                           m = verilen çarpan (ilandayken null), e = tahmini temel değer, f = ilk görülme, l = Sim Companies'te son görülme
//   meta/bina_r{realm}      {v, t, date, total, counts: {harf: [sayı, pay]}, hist: {YYYYMMDD: {harf: sayı}}}
//   meta/ihale_r{realm}     {v, t, list: [[id, harf, seviye, robot, enAzTeklif, garantiliGeri, kapanış, başlangıç, öne çıkan, satıcıNo, satıcı, bolluk]]}
//   meta/evre_r{realm}      {v, t, realm: {...}, ranges: [[evre, baş, bit]], days: [[YYYYMMDD, aktifŞirket, değer, bina, bono, evre]],
//                            events: [[id, ürün, hız%, baş, bit, bina]], contests: [[id, ad, ürün, baş, bit]]}
//   meta/sert_r{realm}      {v, t, full, kinds: {tür: {rel, res, total, cnt, rar, score, vk}}, latest: [[id, şirketNo, şirket, tür, değer, zaman]]}
//   meta/sert_r{realm}_k{tür} {v, t, total, full, vk, rows: [[id, şirketNo, şirket, dönem, ürün|null, değer|null, zaman]], top: [[şirketNo, şirket, adet]]}
//   meta/diger_status       son çalışmanın özeti

import { CONFIG, HEADERS, PATHS, sleep, parseJSON, runIfMain } from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 1;
const ST = 'https://api.simcotools.com/v1';
const SC = CONFIG.simcoBase;
export const GAP_MS = 550;          // iki istek arası en az (saniyede 2'den az)
export const WAIT_429_MS = 2000;    // 429 gelince bekleme
const MAX_429 = 20;                 // aynı istekte en çok bu kadar 429 beklenir
const MAX_FAIL = 3;                 // 429 dışı hatalarda deneme
const TIMEOUT_MS = 30_000;
const BUDGET_MS = 25 * 60_000;
const ST_PAGE = 100;                // Simcotools sayfa boyu üst sınırı
const FULL_EVERY_MS = 20 * 3600_000;   // ağır kısımlar (sertifika kazananları, tam GO ve günlük özet listesi) günde bir
const CERT_MAX_PAGES = 80;          // kazananı bundan çok sayfa olan türde (ör. emektar: 50 binden çok) yalnız ilk sayfa (son 100) alınır
const DOC_MAX = 900_000;            // Firestore belge sınırı 1 MiB; aşan listede en eski satırlar düşer
const BINA_HIST_DAYS = 400;

// Oyun geliştiricisinin tanımladığı tanıma başlığı (doluysa Sim Companies isteklerine eklenir)
const SC_HEADERS = process.env.SIMCO_HEADER_NAME && process.env.SIMCO_HEADER_VALUE
  ? { ...HEADERS, [process.env.SIMCO_HEADER_NAME]: process.env.SIMCO_HEADER_VALUE } : HEADERS;

// ---- Tek kapı ----
export function createGate({ gapMs = GAP_MS, wait429Ms = WAIT_429_MS, deadline = Infinity, fetcher = fetch, wait = sleep, now = Date.now } = {}) {
  let next = 0;
  const stat = { req: 0, ok: 0, n429: 0, fail: 0 };
  async function slot() {
    const at = Math.max(next, now());
    if (at >= deadline) throw Object.assign(new Error('süre doldu'), { deadline: true });
    next = at + gapMs;
    if (at > now()) await wait(at - now());
  }
  async function get(url) {
    let n429 = 0;
    let fails = 0;
    for (;;) {
      await slot();
      stat.req++;
      let res;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        res = await fetcher(url, { method: 'GET', headers: url.startsWith(SC) ? SC_HEADERS : HEADERS, signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        if (++fails >= MAX_FAIL) { stat.fail++; throw new Error(`ağ hatası: ${e?.message || e}`); }
        continue;
      }
      clearTimeout(timer);
      if (res.status === 429) {
        stat.n429++;
        if (++n429 > MAX_429) { stat.fail++; throw new Error('HTTP 429 (çok kez)'); }
        await wait(wait429Ms);
        continue;
      }
      if (res.status >= 500) {
        if (++fails >= MAX_FAIL) { stat.fail++; throw new Error(`HTTP ${res.status}`); }
        await wait(1500 * fails);
        continue;
      }
      if (!res.ok) { stat.fail++; throw new Error(`HTTP ${res.status}`); }
      const json = await res.json();
      stat.ok++;
      return json;
    }
  }
  return { get, stat };
}

// Simcotools'un sayfalı listesinin tüm sayfaları (key = yanıttaki dizi alanı). Sayfa sayısı maxPages'i aşarsa yalnız ilk sayfa alınır.
export async function allPages(get, base, key, { maxPages = 200, extra = '' } = {}) {
  const sep = base.includes('?') ? '&' : '?';
  const first = await get(`${base}${sep}page=1&page_size=${ST_PAGE}${extra}`);
  const items = [...(first?.[key] || [])];
  const last = Math.max(1, Number(first?.metadata?.lastPage) || 1);
  const total = Number(first?.metadata?.totalRecords) || items.length;
  const upto = last > maxPages ? 1 : last;
  for (let p = 2; p <= upto; p++) items.push(...((await get(`${base}${sep}page=${p}&page_size=${ST_PAGE}${extra}`))?.[key] || []));
  return { items, total, complete: upto >= last };
}

const ms = (s) => { const x = Date.parse(s); return Number.isFinite(x) ? x : null; };
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? '')); return m ? Number(m[1] + m[2] + m[3]) : null; };
const PHASE = { recession: 0, normal: 1, boom: 2 };

// ---- Government Order ----
// Sim Companies satırı → arşiv kaydı (miktarlı)
export function goFromSc(o) {
  const id = num(o?.id);
  if (id == null) return null;
  return {
    id,
    k: o.projectKey ?? null,
    c: ms(o.created),
    d: num(o.daysToFulfill),
    s: num(o.size),
    m: num(o.resourceMultiplierAwarded),
    e: num(o.estimatedBaseValue),
    r: (o.governmentorderrequiredresourceSet || []).map((x) => [num(x.kind), num(x.quality), num(x.amountBase)]).filter((x) => x[0] != null),
  };
}
// Simcotools satırı → arşiv kaydı (miktarsız)
export function goFromSt(o) {
  const id = num(o?.id);
  if (id == null) return null;
  return {
    id,
    n: o.projectName ?? null,
    c: ms(o.created),
    d: num(o.daysToFulfill),
    r: (o.resources || []).map((x) => [num(x.resourceId), num(x.quality), null]).filter((x) => x[0] != null),
  };
}

// Arşivi günceller. Sim Companies kaydı miktarları getirir ve önceliklidir; Simcotools yalnız eksik alanları doldurur.
// Daha önce görülmüş miktar/çarpan, kaynaktan kalksa da korunur (ilandan kalkan sipariş geçmişte miktarıyla kalır).
export function mergeGo(prev, scList, stList, now) {
  const out = {};
  for (const [id, o] of Object.entries(prev || {})) out[id] = { ...o };
  for (const raw of stList || []) {
    const o = goFromSt(raw);
    if (!o) continue;
    const old = out[o.id];
    if (!old) { out[o.id] = { ...o, f: now }; continue; }
    old.n = o.n ?? old.n;
    old.c ??= o.c;
    old.d ??= o.d;
    if (!old.r?.length) old.r = o.r;
  }
  for (const raw of scList || []) {
    const o = goFromSc(raw);
    if (!o) continue;
    const old = out[o.id] || { f: now };
    const r = o.r.length ? o.r : old.r || [];
    out[o.id] = { ...old, ...o, n: old.n ?? null, m: o.m ?? old.m ?? null, e: o.e ?? old.e ?? null, r, l: now };
  }
  return out;
}

// ---- Bina ----
export function buildingCounts(json) {
  const counts = {};
  for (const b of json?.buildings || []) {
    const id = String(b?.id ?? '');
    const n = num(b?.count);
    if (id && n != null) counts[id] = [n, num(b.proportion) ?? 0];
  }
  return counts;
}

// Günlük sayıları geçmişe ekler (aynı gün yeniden yazılır), BINA_HIST_DAYS'ten eskisi düşer.
export function addBuildingDay(hist, day, counts) {
  const out = { ...(hist || {}) };
  if (day) out[day] = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v[0]]));
  const keys = Object.keys(out).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - BINA_HIST_DAYS))) delete out[k];
  return out;
}

export function compactAuction(a) {
  const id = num(a?.id);
  if (id == null) return null;
  return [
    id, String(a.buildingKind ?? ''), num(a.buildingSize), num(a.buildingRobots), num(a.minBid), num(a.guaranteedReturn),
    ms(a.closesAt), ms(a.startedAt), a.promoted ? 1 : 0, num(a.sellerId ?? a.seller?.id), String(a.seller?.company ?? ''),
    (a.auctionbuildingabundanceSet || []).map((x) => [num(x.resourceKind), String(x.abundanceLevel ?? '')]),
  ];
}

// ---- Evre ----
export function compactSummaries(list) {
  const rows = new Map();
  for (const s of list || []) {
    const d = ymd(s?.date);
    if (!d) continue;
    rows.set(d, [d, num(s.activeCompanies), num(s.companiesValue), num(s.totalBuildings), num(s.bondsSold), PHASE[s.phase] ?? null]);
  }
  return rows;
}
export function mergeDays(prevRows, fresh) {
  const m = new Map((prevRows || []).map((r) => [r[0], r]));
  for (const [d, r] of fresh) {
    const old = m.get(d);
    // Yarım gün (Simcotools'un "completed: false" satırı) eksik alanlarını eskisinden doldur
    m.set(d, old ? r.map((v, i) => v ?? old[i]) : r);
  }
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
export const compactRanges = (list) => (list || [])
  .map((x) => [x?.phase, ms(x?.start), ms(x?.end)])
  .filter((x) => x[0] in PHASE && x[1] != null)
  .sort((a, b) => a[1] - b[1]);
export const compactEvents = (list) => (list || [])
  .map((e) => [num(e?.id), num(e?.resource), num(e?.speedModifier), ms(e?.since), ms(e?.until), String(e?.producedAt ?? '')])
  .filter((x) => x[0] != null)
  .sort((a, b) => b[3] - a[3] || b[0] - a[0]);
export const compactContests = (list) => (list || [])
  .map((c) => [num(c?.id), String(c?.name ?? ''), num(c?.resourceId), ms(c?.startDate), ms(c?.endDate)])
  .filter((x) => x[0] != null)
  .sort((a, b) => b[3] - a[3]);

// ---- Sertifika ----
// certInfo'daki sayısal alan (datetime dışı ilk alan): amount, goldenBars, governmentOrderRevenue, yearStarted, contestId…
export function certValue(info) {
  for (const [k, v] of Object.entries(info || {})) if (k !== 'datetime' && Number.isFinite(Number(v))) return [k, Number(v)];
  return [null, null];
}
export function certPeriod(d) {
  if (!d || !num(d.year)) return '';
  if (num(d.month) != null) return `${d.year}-${String(d.month).padStart(2, '0')}`;
  if (num(d.week) != null) return `${d.year}-W${String(d.week).padStart(2, '0')}`;
  return String(d.year);
}
export function compactCert(c) {
  const id = num(c?.id);
  if (id == null) return null;
  const [, v] = certValue(c.certInfo);
  return [id, num(c.companyId), String(c.companyName ?? ''), certPeriod(c.date), num(c.resourceKind), v, ms(c.certInfo?.datetime)];
}

// Satırlar (yeniden eskiye) belge sınırına sığmazsa en eskiler düşer
export function fitRows(rows, limit = DOC_MAX) {
  let out = rows;
  while (out.length && JSON.stringify(out).length > limit) out = out.slice(0, Math.floor(out.length * 0.8));
  return { rows: out, cut: out.length < rows.length };
}

// ---- Çalıştırma ----
export async function realmRun(r, { get, now, prevDocs, full, errors }) {
  const writes = [];
  const put = (name, obj) => writes.push({ type: 'set', path: PATHS.meta(name), data: { data: JSON.stringify(obj), u: now } });
  const prev = (name) => parseJSON(prevDocs.get(PATHS.meta(name))?.data);
  const step = async (ad, fn) => { try { await fn(); } catch (e) { if (e?.deadline) throw e; errors.push(`r${r} ${ad}: ${e?.message || e}`); } };

  let realm = null; // bugünün realm özeti (evre ve bina tarihi)
  await step('realm', async () => { realm = (await get(`${ST}/realms/${r}`))?.summary || null; });

  // Government Order
  await step('go', async () => {
    const old = prev(`go_r${r}`);
    let sc = null;
    try { sc = (await get(`${SC}/api/v3/government-orders/${r}/`))?.governmentOrders || []; } catch (e) { errors.push(`r${r} go sc: ${e.message}`); }
    const tamGo = full || !old?.stT;
    let st = null;
    try {
      st = tamGo ? (await allPages(get, `${ST}/realms/${r}/government-orders`, 'orders', { extra: '&sort=-id' })).items
        : (await get(`${ST}/realms/${r}/government-orders?page=1&page_size=${ST_PAGE}&sort=-id`))?.orders || [];
    } catch (e) { errors.push(`r${r} go st: ${e.message}`); }
    if (!sc && !st) throw new Error('iki kaynak da alınamadı');
    const orders = mergeGo(old?.orders, sc, st, now);
    put(`go_r${r}`, { v: VERSION, t: now, stT: st && tamGo ? now : old?.stT ?? null, orders });
  });

  // Evre: realm özeti, günlük özetler, evreler, olaylar, yarışmalar
  await step('evre', async () => {
    const old = prev(`evre_r${r}`);
    const tamGun = full || !old?.days?.length;
    const sums = tamGun ? (await allPages(get, `${ST}/realms/${r}/summaries`, 'summaries')).items
      : (await get(`${ST}/realms/${r}/summaries?page=1&page_size=${ST_PAGE}`))?.summaries || [];
    const ranges = compactRanges((await allPages(get, `${ST}/realms/${r}/phases`, 'ranges')).items);
    const events = compactEvents((await allPages(get, `${ST}/realms/${r}/events`, 'events')).items);
    const contests = compactContests((await allPages(get, `${ST}/realms/${r}/contests`, 'contests')).items);
    put(`evre_r${r}`, {
      v: VERSION, t: now, realm: realm || old?.realm || null, ranges: ranges.length ? ranges : old?.ranges || [], days: mergeDays(old?.days, compactSummaries(sums)),
      events: events.length ? events : old?.events || [], contests: contests.length ? contests : old?.contests || [],
    });
  });

  // Bina sayıları ve açık artırmalar
  await step('bina', async () => {
    const old = prev(`bina_r${r}`);
    const json = await get(`${ST}/realms/${r}/stats/buildings?page=1&page_size=${ST_PAGE}`);
    const counts = buildingCounts(json);
    if (!Object.keys(counts).length) throw new Error('bina sayısı boş');
    const date = ymd(realm?.date) || ymd(new Date(now).toISOString());
    put(`bina_r${r}`, { v: VERSION, t: now, date, total: num(json?.totalBuildings), counts, hist: addBuildingDay(old?.hist, date, counts) });
  });
  await step('ihale', async () => {
    const list = ((await get(`${SC}/api/v2/building-auctions/${r}/`))?.buildingAuctions || []).map(compactAuction).filter(Boolean);
    put(`ihale_r${r}`, { v: VERSION, t: now, list });
  });

  // Sertifikalar
  await step('sert', async () => {
    const old = prev(`sert_r${r}`);
    const kindsJson = await get(`${ST}/realms/${r}/certificates`);
    const kinds = {};
    for (const k of kindsJson?.certificates_kinds || []) {
      const kind = num(k?.kind);
      if (kind == null) continue;
      kinds[kind] = { ...(old?.kinds?.[kind] || {}), rel: k.relevant ? 1 : 0, res: Array.isArray(k.resources) ? k.resources : null };
    }
    const rar = await get(`${SC}/api/v2/certificates-explorer/${r}/rarest/`).catch((e) => { errors.push(`r${r} sert nadir: ${e.message}`); return null; });
    for (const x of rar?.rarestCertificates || []) {
      const kind = num(x.kind);
      if (kind == null) continue;
      kinds[kind] = { ...(kinds[kind] || { rel: 0, res: null }), rar: num(x.rarity), score: num(x.score) };
    }
    const latestJson = await get(`${SC}/api/v2/certificates-explorer/${r}/latest/`).catch((e) => { errors.push(`r${r} sert son: ${e.message}`); return null; });
    const latest = (latestJson?.latestCertificates || []).map((c) => [num(c.id), num(c.companyId), String(c.company?.company ?? ''), num(c.kind), num(c.value), ms(c.datetime)]).filter((x) => x[0] != null);
    const tamSert = full || !old?.full;
    if (tamSert) {
      for (const kind of Object.keys(kinds).map(Number).sort((a, b) => a - b)) {
        try {
          const { items, total, complete } = await allPages(get, `${ST}/realms/${r}/certificates/${kind}`, 'certificates', { maxPages: CERT_MAX_PAGES });
          const det = await get(`${SC}/api/v2/certificates-explorer/${r}/certificate/${kind}/-/-/`).catch(() => null);
          const vk = items.map((c) => certValue(c.certInfo)[0]).find(Boolean) || null;
          kinds[kind] = { ...kinds[kind], total, cnt: num(det?.companiesCount), vk };
          if (det?.certificateRarity) kinds[kind] = { ...kinds[kind], rar: num(det.certificateRarity.rarity) ?? kinds[kind].rar, score: num(det.certificateRarity.score) ?? kinds[kind].score };
          const top = (det?.topHunters || []).map((h) => [num(h.company?.id ?? h.id), String(h.company?.company ?? ''), num(h.value)]).filter((x) => x[0] != null);
          const { rows, cut } = fitRows(items.map(compactCert).filter(Boolean).sort((a, b) => b[0] - a[0]));
          put(`sert_r${r}_k${kind}`, { v: VERSION, t: now, total, full: complete && !cut, vk, rows, top });
        } catch (e) {
          if (e?.deadline) throw e;
          errors.push(`r${r} sert ${kind}: ${e.message}`);
        }
      }
    }
    put(`sert_r${r}`, { v: VERSION, t: now, full: tamSert ? now : old?.full ?? null, kinds, latest: latest.length ? latest : old?.latest || [] });
  });

  return writes;
}

export async function main() {
  const t0 = Date.now();
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const gate = createGate({ deadline: t0 + BUDGET_MS });
  const errors = [];
  const names = CONFIG.realms.flatMap((r) => [`go_r${r}`, `evre_r${r}`, `bina_r${r}`, `sert_r${r}`]);
  const prevDocs = await db.getMany([...names.map(PATHS.meta), PATHS.meta('diger_status')]);
  const status = parseJSON(prevDocs.get(PATHS.meta('diger_status'))?.data);
  const full = process.env.DIGER_FULL === '1' || !status?.full || t0 - status.full >= FULL_EVERY_MS;
  let written = 0;
  for (const r of CONFIG.realms) {
    let writes = [];
    try {
      writes = await realmRun(r, { get: gate.get, now: t0, prevDocs, full, errors });
    } catch (e) {
      errors.push(`r${r}: ${e?.message || e}`);
    }
    if (writes.length) { await db.commit(writes); written += writes.length; }
  }
  const ok = written > 0;
  const st = { v: VERSION, t: t0, ms: Date.now() - t0, full: full && ok ? t0 : status?.full ?? null, written, ...gate.stat, errors: errors.slice(0, 40) };
  await db.commit([{ type: 'set', path: PATHS.meta('diger_status'), data: { data: JSON.stringify(st), u: t0 } }]);
  console.log(`DentSimco diğer | ${full ? 'tam' : 'hafif'} | ${written} belge | istek=${gate.stat.req} 429=${gate.stat.n429} hata=${gate.stat.fail} | ${((Date.now() - t0) / 1000).toFixed(0)} sn`);
  if (errors.length) console.log(`Uyarılar (${errors.length}):`, errors.slice(0, 12).join(' ; '));
  if (!ok) throw new Error('Hiçbir belge yazılamadı.');
}

runIfMain(import.meta.url, main);
