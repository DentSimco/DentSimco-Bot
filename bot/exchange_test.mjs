// DentSimco — anlık borsa (Sim Companies market/all) sınamaları. Çalıştırma: node bot/exchange_test.mjs
// İlan örneği, oyun API'sinin 19 Ekim 2026 tarihli gerçek yanıtından kısaltılmıştır (Enerji, ürün 1, realm 0).

import { parseOrders, summarizeOrders, addSupplySample, addSupplySamples, averageSupply } from './exchange.mjs';
import { runQueue } from './anlik.mjs';

const results = [];
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
  })());
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
// ---- Kuyruk: sabit saniyede 2 istek; 429'da 1 sn bekle, ürünü sona ekle; tüm ürünler bitene kadar ----
const sahteSaat = () => {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
};
const runSync = async (tasks, responses, extra = {}) => {
  const clock = sahteSaat();
  const sent = [];
  const handled = [];
  const stat = await runQueue(tasks, {
    fetcher: async (task) => { sent.push([clock.now(), task.id]); const r = responses(task, sent.length); return r; },
    handle: (task) => handled.push(task.id),
    deadline: extra.deadline ?? 1e9, now: clock.now, wait: clock.wait, rateMs: 500, pauseMs: 1000,
  });
  return { stat, sent, handled };
};
const ids = (n) => Array.from({ length: n }, (_, i) => ({ r: 0, id: i + 1 }));

test('Kuyruk: istekler en az 500 ms arayla (saniyede 2) gider ve hepsi biter', async () => {
  const { stat, sent, handled } = await runSync(ids(6), () => ({ status: 200, json: [] }));
  eq(stat.ok, 6); eq(handled.length, 6); eq(stat.left, 0);
  for (let i = 1; i < sent.length; i++) ok(sent[i][0] - sent[i - 1][0] >= 500, `aralık ${sent[i][0] - sent[i - 1][0]}`);
});
test('Kuyruk: 429 gelince 1 sn beklenir, ürün sona eklenir ve sonunda çekilir', async () => {
  let first = true;
  const { stat, sent, handled } = await runSync(ids(3), (task) => {
    if (task.id === 1 && first) { first = false; return { status: 429, note: 'Ratelimited' }; }
    return { status: 200, json: [] };
  });
  eq(stat.throttled, 1); eq(stat.ok, 3); eq(stat.note, 'Ratelimited');
  eq(handled.at(-1), 1, '429 alan ürün sona kaldı');
  const i429 = sent.findIndex(([, id]) => id === 1);
  ok(sent[i429 + 1][0] - sent[i429][0] >= 1000, '429 sonrası en az 1 sn beklenir');
});
test('Kuyruk: 429 hiç bitmese de süre dolunca durur; kalan sayılır', async () => {
  const { stat } = await runSync(ids(2), () => ({ status: 429 }), { deadline: 20_000 });
  ok(stat.throttled > 5, 'denemeye devam eder'); eq(stat.ok, 0); eq(stat.left > 0, true);
});
test('Kuyruk: 5xx ya da bozuk yanıt 3 denemeden sonra bırakılır, diğerleri sürer', async () => {
  const { stat, handled } = await runSync(ids(3), (task) => (task.id === 2 ? { status: 500 } : { status: 200, json: [] }));
  eq(stat.fail, 1); eq(stat.ok, 2); eq(handled.includes(2), false);
});

await Promise.all(pending);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'tamam' : 'HATA '} ${r.name}${r.ok ? '' : ' → ' + r.error}`);
console.log(`\n${results.length - failed.length}/${results.length} sınama geçti`);
if (failed.length) process.exit(1);
