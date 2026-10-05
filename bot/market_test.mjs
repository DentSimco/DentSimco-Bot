// DentSimco — borsa botu sınamaları. Çalıştırma: node bot/market_test.mjs
// Örnek yanıt, Simcotools'un 5 Ekim 2026 20:14'teki gerçek yanıtından kısaltılmıştır (Enerji, ürün 1).
// Mantık realm'e bağlı değildir: realm 0 ve realm 1 aynı kodla işlenir (testte ikisi de denenir).

import { parseSummaries, accumulate, yesterdayRows } from './market.mjs';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const eq = (a, b, label = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} beklenen ${JSON.stringify(b)}, bulunan ${JSON.stringify(a)}`); };
const near = (a, b, tol, label = '') => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${label} beklenen ${b} ±${tol}, bulunan ${a}`); };
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };

const T = (s) => Date.parse(s);
const AT = T('2026-10-05T20:14:57.400Z');

const sample = (extra = {}) => ({
  resource: {
    resourceId: 1,
    summariesByQuality: [
      { quality: 0, timestamp: '2026-10-05T20:14:57.298832Z', price: 0.249, volume: 1000,
        fiveMinutesCandlestick: { date: '2026-10-05T20:10:00Z', open: 0.25, low: 0.248, high: 0.25, close: 0.249, volume: 1519771 },
        lastDayCandlestick: { date: '2026-10-04T00:00:00Z', open: 0.252, low: 0.245, high: 0.254, close: 0.254, volume: 654314212, vwap: 0.25045058 } },
      { quality: 5, timestamp: '2026-10-05T20:08:37.068963Z', price: 0.255, volume: 19651,
        fiveMinutesCandlestick: { date: '2026-10-05T20:05:00Z', open: 0.254, low: 0.254, high: 0.255, close: 0.255, volume: 4349798 },
        lastDayCandlestick: { date: '2026-10-04T00:00:00Z', open: 0.257, low: 0.247, high: 0.258, close: 0.255, volume: 419689889, vwap: 0.25480878 } },
      { quality: 12, timestamp: '2026-10-05T19:15:28.229257Z', price: 0.257, volume: 2559215,
        fiveMinutesCandlestick: { date: '2026-10-05T19:15:00Z', open: 0.257, low: 0.257, high: 0.257, close: 0.257, volume: 2559215 },
        lastDayCandlestick: { date: '2026-10-04T00:00:00Z', open: 0.258, low: 0.256, high: 0.26, close: 0.258, volume: 40851534, vwap: 0.258307 } },
      ...(extra.list || []),
    ],
  },
});

for (const realm of [0, 1]) {
  test(`Realm ${realm}: sürmekte olan mum geçen kısmına bölünür (Q0, mumun %99'u geçti)`, () => {
    const { quals } = parseSummaries(sample(), AT);
    const frac = (AT - T('2026-10-05T20:10:00Z')) / 300000;
    near(quals[0].sold, Math.round(1519771 / frac), 1);
    ok(quals[0].sold > 1519771 && quals[0].sold < 1560000, 'kısmen büyütülmeli');
    near(quals[0].value, quals[0].sold * 0.249, 0.01);
    eq(quals[0].price, 0.249);
    eq(quals[0].lt, T('2026-10-05T20:14:57.298832Z'));
  });
}

test('Tamamlanmış mum (Q5, 20:05–20:10) olduğu gibi alınır', () => {
  const { quals } = parseSummaries(sample(), AT);
  eq(quals[5].sold, 4349798);
});

test('İlk turda eski mumda (Q12, 19:15) satış sayılmaz, fiyat ve son işlem zamanı yine gelir', () => {
  const { quals } = parseSummaries(sample(), AT);
  eq(quals[12].sold, 0);
  eq(quals[12].value, 0);
  eq(quals[12].price, 0.257);
  eq(quals[12].lt, T('2026-10-05T19:15:28.229257Z'));
});

test('Mumun ilk saniyelerinde büyütme en çok 5 kat', () => {
  const at = T('2026-10-05T20:10:06Z'); // mumun %2'si geçti
  const { quals } = parseSummaries(sample(), at);
  eq(quals[0].sold, 1519771 * 5);
});

test('Aynı mum iki turda görülürse yalnız fark eklenir (çift sayım yok)', () => {
  const at1 = T('2026-10-05T20:12:30Z'); // %50 → 2 kat
  const a = parseSummaries(sample(), at1);
  eq(a.quals[0].sold, 1519771 * 2);
  const st = accumulate(null, a.quals, false).state;
  const at2 = T('2026-10-05T20:14:57Z'); // aynı mum, daha çok hacim
  const j = sample(); j.resource.summariesByQuality[0].fiveMinutesCandlestick.volume = 3500000;
  const b = parseSummaries(j, at2, { t: at1, q: st });
  const est2 = Math.round(3500000 / ((at2 - T('2026-10-05T20:10:00Z')) / 300000));
  eq(b.quals[0].sold, est2 - 1519771 * 2);
  ok(b.quals[0].sold > 0);
});

test('Aynı mumda tahmin düşerse (daha geç, daha az büyütme) satış eksiye düşmez', () => {
  const at1 = T('2026-10-05T20:12:30Z');
  const st = accumulate(null, parseSummaries(sample(), at1).quals, false).state;
  const b = parseSummaries(sample(), T('2026-10-05T20:14:57Z'), { t: at1, q: st }); // hacim aynı, büyütme azaldı
  eq(b.quals[0].sold, 0);
  eq(b.quals[0].cEst, 1519771 * 2); // tahmin geriye gitmez
});

test('Hacim azalmış görünse bile satış eksiye düşmez', () => {
  const at1 = T('2026-10-05T20:14:30Z');
  const a = parseSummaries(sample(), at1);
  const st = accumulate(null, a.quals, false).state;
  const j = sample(); j.resource.summariesByQuality[0].fiveMinutesCandlestick.volume = 100;
  const b = parseSummaries(j, T('2026-10-05T20:14:50Z'), { t: at1, q: st });
  eq(b.quals[0].sold, 0);
});

test('Yeni mum başladıysa tamamı sayılır; önceki mumdan kalan kayıp kabul edilir', () => {
  const at1 = T('2026-10-05T20:14:00Z');
  const st = accumulate(null, parseSummaries(sample(), at1).quals, false).state;
  const j = sample();
  j.resource.summariesByQuality[0].fiveMinutesCandlestick = { date: '2026-10-05T20:15:00Z', open: 0.249, low: 0.249, high: 0.25, close: 0.25, volume: 500000 };
  const at2 = T('2026-10-05T20:17:30Z'); // yeni mumun %50'si
  const b = parseSummaries(j, at2, { t: at1, q: st });
  eq(b.quals[0].sold, 1000000);
});

test('Önceki turdan eski mum (işlem yok) → satış 0, durum korunur', () => {
  const at1 = T('2026-10-05T20:14:00Z');
  const st = accumulate(null, parseSummaries(sample(), at1).quals, false).state;
  const at2 = T('2026-10-05T20:19:30Z'); // aynı eski mum 20:10: önceki tur 20:10 dilimindeydi → aynı mum, fark 0
  const b = parseSummaries(sample(), at2, { t: at1, q: st });
  eq(b.quals[0].sold, Math.max(0, 1519771 - st[0][1])); // tamamlandı: 1.519.771; önceki tahmin daha büyükse 0
  const j = sample(); j.resource.summariesByQuality[0].fiveMinutesCandlestick.date = '2026-10-05T19:00:00Z';
  const c = parseSummaries(j, at2, { t: at1, q: st });
  eq(c.quals[0].sold, 0);
  eq(c.quals[0].cMin, st[0][0]);
});

test('Fiyatı olmayan kalite hata vermez', () => {
  const j = sample({ list: [{ quality: 7, timestamp: null, price: 0, fiveMinutesCandlestick: null, lastDayCandlestick: null }] });
  const { quals } = parseSummaries(j, AT);
  eq(quals[7].price, null);
  eq(quals[7].lt, null);
  eq(quals[7].sold, 0);
});

test('Dünün özeti: açılış, yüksek, düşük, kapanış, satış ve tutar (hacim × VWAP)', () => {
  const { daily } = parseSummaries(sample(), AT);
  eq(daily[0].day, '2026-10-04');
  eq(daily[0].row.slice(0, 4), [0.252, 0.254, 0.245, 0.254]);
  eq(daily[0].row[4], null);
  eq(daily[0].row[5], 654314212);
  near(daily[0].row[6], 654314212 * 0.25045058, 0.01);
});

test('Beklenmeyen yanıt hata verir', () => {
  let threw = false;
  try { parseSummaries({}, AT); } catch { threw = true; }
  ok(threw);
});

test('Biriktirme: ara tur yazılmaz, satış birikir; yazma turunda toplam gider ve birikim sıfırlanır', () => {
  const q1 = { 0: { price: 0.25, lt: 1, sold: 100, value: 25, cMin: 10, cEst: 100 } };
  const a = accumulate(null, q1, false);
  eq(a.state[0], [10, 100, 100, 25]);
  eq(a.live[0], [0.25, null, 100, 25, 1]);
  const q2 = { 0: { price: 0.26, lt: 2, sold: 50, value: 13, cMin: 11, cEst: 50 } };
  const b = accumulate(a.state, q2, true);
  eq(b.intraday[0], [0.26, null, 150, 38]);
  eq(b.state[0], [11, 50, 0, 0]);
  const c = accumulate(b.state, { 0: { price: 0.26, lt: 3, sold: 7, value: 1.8, cMin: 12, cEst: 7 } }, false);
  eq(c.state[0], [12, 7, 7, 1.8]);
});

test('Biriktirme: bu turda görünmeyen kalitenin durumu korunur', () => {
  const prev = { 3: [5, 500, 40, 10] };
  const r = accumulate(prev, { 0: { price: 1, lt: 1, sold: 1, value: 1, cMin: 1, cEst: 1 } }, true);
  eq(r.state[3], [5, 500, 40, 10]);
});

test('Dünün satırları: yalnız dünün mumu olan ürünler; eski tarihli mum sayılmaz', () => {
  const rows = yesterdayRows({
    1: { 0: { day: '2026-10-04', row: [1] }, 1: { day: '2026-10-03', row: [2] } },
    2: { 0: { day: '2026-10-03', row: [3] } },
    3: {},
  }, '2026-10-04');
  eq(rows, [['1', { 0: [1] }]]);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
console.log(failed.length ? `\n${failed.length} test başarısız.` : `\n${results.length}/${results.length} test geçti.`);
process.exit(failed.length ? 1 : 0);
