// DentSimco — anlık borsa (Sim Companies market/all) sınamaları. Çalıştırma: node bot/exchange_test.mjs
// İlan örneği, oyun API'sinin 19 Ekim 2026 tarihli gerçek yanıtından kısaltılmıştır (Enerji, ürün 1, realm 0).

import { parseOrders, summarizeOrders, mergeLive, mergeIntraday, addSupplySample, addSupplySamples, averageSupply } from './exchange.mjs';
import { accumulate } from './market.mjs';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const eq = (a, b, label = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} beklenen ${JSON.stringify(b)}, bulunan ${JSON.stringify(a)}`); };
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };

const order = (quality, price, quantity, extra = {}) => ({
  id: Math.floor(Math.random() * 1e9), kind: 1, quantity, quality, price,
  datetimeDecayUpdated: '2026-10-19T12:58:25.920529+00:00',
  seller: { id: 5760320, company: 'ENERGY ENERGY ENERGY', realmId: 0, ip: '74853d' },
  posted: '2026-10-19T12:58:25.920529+00:00', fees: 30740, ...extra,
});
const SAMPLE = [
  order(1, 0.242, 3175600), order(1, 0.243, 5000), order(1, 0.244, 145875),
  order(3, 0.25, 100), order(0, 0.3, 10),
];

test('parseOrders: dizi ve alan içindeki dizi okunur, geçersiz ilanlar atılır', () => {
  eq(parseOrders(SAMPLE).length, 5);
  eq(parseOrders({ orders: SAMPLE }).length, 5);
  eq(parseOrders([order(1, 0.2, 5), order(99, 0.2, 5), order(2, 0, 5), order(2, 0.2, 0), null, {}]).length, 1);
});
test('parseOrders: ilan listesi olmayan yanıt hata verir', () => {
  let err = null;
  try { parseOrders({ message: 'x' }); } catch (e) { err = e; }
  ok(err, 'hata beklenir');
});
test('summarizeOrders: ask kalitesi ≥ q olan en ucuz ilandır (yukarı doğru artmaz azalmaz)', () => {
  const s = summarizeOrders(parseOrders(SAMPLE));
  eq(s[0].ask, 0.242);
  eq(s[1].ask, 0.242);
  eq(s[2].ask, 0.25, 'Q2: Q1 ilanları sayılmaz');
  eq(s[3].ask, 0.25);
  ok(!(4 in s), 'Q4 ve üstü: ilan yok');
  let prev = 0;
  for (const q of Object.keys(s).map(Number).sort((a, b) => a - b)) { ok(s[q].ask >= prev, `ask azalmamalı (Q${q})`); prev = s[q].ask; }
});
test('summarizeOrders: arz tam kalitedeki toplam adettir', () => {
  const s = summarizeOrders(parseOrders(SAMPLE));
  eq(s[0].supply, 10);
  eq(s[1].supply, 3175600 + 5000 + 145875);
  eq(s[2].supply, 0, 'Q2 ilanı yok ama Q3 ilanı olduğu için anlık fiyatı var');
  eq(s[3].supply, 100);
});
test('summarizeOrders: ilan yoksa boş sonuç', () => { eq(summarizeOrders([]), {}); });

test('mergeLive: anlık veri gelince arz ve ask işlenir; ilanı kalmayan kalite 0 / boş olur', () => {
  const liveQ = { 1: [0.241, null, 5000, 1200, 1000], 2: [0.25, null, 0, 0, 900] };
  const ex = { 1: { ask: 0.242, supply: 80 } };
  const m = mergeLive(liveQ, {}, ex);
  eq(m[1], [0.241, 80, 5000, 1200, 1000, 0.242]);
  eq(m[2], [0.25, 0, 0, 0, 900, null]);
});
test('mergeLive: yalnız ilanı olan kalite (işlem yok) fiyatsız satır olur', () => {
  const m = mergeLive({}, {}, { 5: { ask: 0.9, supply: 7 } });
  eq(m[5], [null, 7, 0, 0, null, 0.9]);
});
test('mergeLive: ilanlar çekilemediyse önceki arz ve ask korunur', () => {
  const prevQ = { 1: [0.24, 80, 0, 0, 1000, 0.242] };
  const m = mergeLive({ 1: [0.241, null, 5000, 1200, 1100] }, prevQ, null);
  eq(m[1], [0.241, 80, 5000, 1200, 1100, 0.242]);
});
test('mergeLive: SimcoTools da çekilemediyse yalnız önceki anlık veri taşınır', () => {
  const prevQ = { 1: [0.24, 80, 3, 4, 1000, 0.242], 2: [0.3, null, 0, 0, 5, null] };
  const m = mergeLive(prevQ, prevQ, null);
  eq(m[1], prevQ[1]);
});
test('mergeIntraday: anlık veri yoksa arz ve ask boş (null) yazılır', () => {
  const live = { 1: [0.241, 80, 5000, 1200, 1000, 0.242] };
  eq(mergeIntraday({ 1: [0.241, null, 4000, 900] }, live, true), { 1: [0.241, 80, 4000, 900, 0.242] });
  eq(mergeIntraday({ 1: [0.241, null, 4000, 900] }, live, false), { 1: [0.241, null, 4000, 900, null] });
});

test('Günlük ortalama arz: gün içinde örnek ortalaması, gün değişince dünkü değer saklanır', () => {
  let s = addSupplySample(null, '2026-10-18', 100);
  s = addSupplySample(s, '2026-10-18', 300);
  eq(averageSupply(s, '2026-10-18'), 200);
  s = addSupplySample(s, '2026-10-19', 50);
  eq(averageSupply(s, '2026-10-18'), 200, 'dünün ortalaması korunur');
  eq(averageSupply(s, '2026-10-19'), 50);
  eq(averageSupply(s, '2026-10-17'), null);
});
test('addSupplySamples: daha önce arzı izlenen ama ilanı kalmayan kalite 0 sayılır', () => {
  let st = addSupplySamples({}, { 1: { ask: 0.2, supply: 100 } }, '2026-10-19');
  st = addSupplySamples(st, {}, '2026-10-19');
  eq(averageSupply(st[1], '2026-10-19'), 50);
});
test('accumulate: arz alanları turlar arasında korunur (eski 4 elemanlı durum da çalışır)', () => {
  const quals = { 1: { price: 0.241, lt: 1000, sold: 10, value: 2.4, cMin: 5, cEst: 10 } };
  const withSupply = { 1: addSupplySample([5, 10, 0, 0], '2026-10-19', 123) };
  const acc = accumulate(withSupply, quals, true);
  eq(acc.state[1].slice(4), withSupply[1].slice(4));
  const old = accumulate({ 1: [5, 10, 0, 0] }, quals, false);
  eq(old.state[1].length, 4);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'tamam' : 'HATA '} ${r.name}${r.ok ? '' : ' → ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} sınama geçti`);
if (failed.length) process.exit(1);
