// DentSimco Bot v2 — ortak ayarlar ve yardımcı fonksiyonlar
// Ayar değiştirmek gerekirse sadece CONFIG kısmına dokun.
//
// FIRESTORE VERİ HARİTASI (dashboard bunları okur)
//   live/r{realm}                  data = JSON {t, items: {id: [t, {q: [p,a,s,v]}]}}   son ölçüm
//   intraday/r{realm}_{gün}_s{NN}  t{SSDD} = JSON {id: {q: [p,a,s,v]}}             15 dk'lık noktalar
//   daily/r{realm}_{id}_{yıl}      d{AAGG} = JSON {q: [açılış,yüksek,düşük,kapanış,ortArz,satış,değer]}
//   state/r{realm}_s{NN}           data = JSON {t, items: {id: [ilanId,q,fiyat,adet,satıcı,...]}}
//   meta/products_r{realm}, meta/tradable, meta/buildings, meta/core,
//   meta/modifiers_r{realm}, meta/retail_r{realm}, meta/status, meta/rollup
//
//   p = en düşük satış fiyatı, a = satıştaki toplam adet (arz),
//   s = tahmini satılan adet (önceki ölçümden beri), v = tahmini satış tutarı
//   VWAP = toplam v / toplam s.  Parça (shard) numarası = ürün ID % 16.  Saatler UTC.

import { pathToFileURL } from 'node:url';

export const CONFIG = {
  realms: [0, 1],
  simcoBase: 'https://www.simcompanies.com',
  encyclopedia: { lang: 'tr', phase: 0 }, // Türkçe ürün adları; faz 0 = Durgunluk (hesap motoru diğer fazları formülle bulur)

  shards: 16,
  rawRetentionDays: 35,

  // Her çalışma 1 dakikanın altında kalsın diye borsa çekme işi bu süre sonunda durur (ms).
  // Repo herkese açık olduğu için GitHub Actions dakikası sınırsız. Bot 15 dakikada bir başlar ve
  // tüm ürünler çekilene kadar çalışır; 30 dakikada bitiremezse kalanı sonraki çalışma en bayat üründen sürdürür.
  fetchBudgetMs: 30 * 60_000,
  fetchBudgetOnRollupMs: 30 * 60_000,

  // Sunucu "yavaş ol" (429) deyince hız kendiliğinden düşer, sorun çıkmadıkça yeniden artar.
  // retries: 429 dışındaki hatalarda (sunucu 5xx, bağlantı kopması) kaç kez yeniden denenir. 429'da süre bitene kadar beklenir.
  market: { concurrency: 6, startIntervalMs: 250, minIntervalMs: 100, maxIntervalMs: 4000, retries: 6 },

  // Sunucu hız sınırı koyduğunda her ürüne yetişilemez. En çok girdi olarak kullanılan ürünler
  // (Taşıma, Enerji, Su, Tohum, Çelik, Alüminyum...) diğerlerinden yaklaşık 4 kat sık güncellenir.
  hotProducts: [13, 1, 2, 66, 18, 21, 43, 19, 17, 22, 135, 23, 120, 117],
  hotFactor: 4,
  constants: { concurrency: 3, delayMs: 300 },

  stateMaxPerQuality: 250,
  maxRollupDaysPerRun: 3,
};

const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; DentSimco-Bot/2.0)',
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const pad2 = (n) => String(n).padStart(2, '0');
export const range = (n) => Array.from({ length: n }, (_, i) => i);
export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
export const shardOf = (id) => Number(id) % CONFIG.shards;

export function parseJSON(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export function hhmm(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d.getTime());
}

export const PATHS = {
  live: (r) => `live/r${r}`,
  state: (r, s) => `state/r${r}_s${pad2(s)}`,
  intraday: (r, day, s) => `intraday/r${r}_${day}_s${pad2(s)}`,
  daily: (r, id, year) => `daily/r${r}_${id}_${year}`,
  meta: (name) => `meta/${name}`,
};

// Oyun API'sinden JSON çeker. 429 ve 5xx hatalarında bekleyip tekrar dener.
export async function fetchJson(url, { deadline = Infinity, retries = 3, onThrottle } = {}) {
  let lastError = new Error('bilinmeyen hata');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('süre doldu'), { deadline: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(15000, remaining));
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      if (Date.now() >= deadline - 50) throw Object.assign(new Error('süre doldu'), { deadline: true });
      lastError = e;
      await sleep(800 * (attempt + 1));
      continue;
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429 && onThrottle) onThrottle();
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1);
      lastError = new Error(`HTTP ${res.status}`);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }
  throw lastError;
}

// ---- Uyarlanabilir hız kontrolü ----
// Tüm istekler tek kapıdan geçer: iki istek arası en az `interval` ms olur.
// Sunucu 429 verirse herkes birlikte bekler (Retry-After varsa ona uyulur) ve aralık büyür.
// Sorunsuz istekler birikince aralık yavaş yavaş küçülür.
export function createPacer({ deadline = Infinity, startIntervalMs = 350, minIntervalMs = 120, maxIntervalMs = 4000 } = {}) {
  let interval = startIntervalMs;
  let nextAt = 0;
  let blockedUntil = 0;
  let penalty = 0;
  let streak = 0;
  const stat = { ok: 0, throttled: 0, longestPauseMs: 0, retryAfterSeen: null, note: null, firstAt: 0, lastAt: 0 };
  return {
    stat,
    get interval() { return interval; },
    async take() {
      for (;;) {
        const now = Date.now();
        if (now >= deadline) return false;
        const at = Math.max(nextAt, blockedUntil, now);
        if (at >= deadline) return false;
        if (at === now) {
          nextAt = now + interval;
          if (!stat.firstAt) stat.firstAt = now;
          return true;
        }
        await sleep(Math.min(at - now, 400));
      }
    },
    success() {
      stat.ok++;
      stat.lastAt = Date.now();
      penalty = 0;
      // Toparlanma hızlı olmalı: 3 sorunsuz istekte aralık %20 kısalır (4 sn'den 250 ms'ye yaklaşık 1 dakikada iner).
      if (++streak >= 3) {
        streak = 0;
        interval = Math.max(minIntervalMs, Math.round(interval * 0.8));
      }
    },
    throttle(retryAfterMs = 0, note = null) {
      stat.throttled++;
      streak = 0;
      if (retryAfterMs > 0) stat.retryAfterSeen = Math.max(stat.retryAfterSeen || 0, retryAfterMs);
      if (note && !stat.note) stat.note = note;
      const now = Date.now();
      if (now < blockedUntil) return; // biri zaten bekletiyor
      penalty = Math.min(6, penalty + 1);
      const pause = retryAfterMs > 0 ? Math.min(retryAfterMs, 60_000) : Math.min(20_000, 1000 * 2 ** penalty);
      blockedUntil = now + pause;
      stat.longestPauseMs = Math.max(stat.longestPauseMs, pause);
      interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
    },
  };
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

// fetchJson'ın hız kontrollü sürümü: 429 alınca kalan denemeyi harcamadan sırada bekler.
export async function fetchPaced(url, pacer, { deadline = Infinity, retries = 6 } = {}) {
  let lastError = new Error('bilinmeyen hata');
  let hardFails = 0; // 429 dışı hatalar; 429'da süre bitene kadar beklenir
  for (;;) {
    if (!(await pacer.take())) throw Object.assign(new Error('süre doldu'), { deadline: true });
    const remaining = deadline - Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15000, remaining)));
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (++hardFails > retries) throw lastError;
      continue;
    }
    clearTimeout(timer);
    if (res.status === 429) {
      let note = null;
      try { note = `${res.headers.get('retry-after') ? `retry-after=${res.headers.get('retry-after')} ` : ''}${(await res.text()).replace(/\s+/g, ' ').slice(0, 120)}`; } catch { /* önemsiz */ }
      pacer.throttle(parseRetryAfter(res.headers.get('retry-after')), note);
      lastError = new Error('HTTP 429');
      continue;
    }
    if (res.status >= 500) {
      // Tek ürüne özgü sunucu hatası tüm botu yavaşlatmamalı: sadece bu ürün kısa bekleyip yeniden dener.
      lastError = new Error(`HTTP ${res.status}`);
      if (++hardFails > retries) throw lastError;
      await sleep(Math.min(3000, 500 * hardFails));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    pacer.success();
    return json;
  }
}

// İşleri aynı anda en fazla `concurrency` tane olacak şekilde çalıştırır.
// Süre dolunca yeni iş başlatmaz; başlatılamayan işlerin sonucu undefined kalır.
export async function runPool(items, worker, { concurrency = 3, delayMs = 0, deadline = Infinity } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let delay = delayMs;
  const control = {
    slowDown() { delay = Math.min(2000, Math.max(250, delay * 2)); },
  };
  async function loop() {
    while (Date.now() < deadline) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], control) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
      if (delay > 0) await sleep(delay);
    }
  }
  await Promise.all(range(Math.min(concurrency, items.length)).map(loop));
  return results;
}

// Tek dosyayı doğrudan çalıştırınca main() çağrılır; test ederken çağrılmaz.
export function runIfMain(metaUrl, main) {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
  if (metaUrl !== entry) return;
  main().then(
    () => process.exit(0),
    (error) => {
      console.error('HATA:', error?.stack || error);
      process.exit(1);
    },
  );
}
