// DentSimco — restoran botu sınaması. Çalıştırma: node bot/restaurant_test.mjs (ağa çıkılmaz)
import { extractRestaurant, mergeRestaurant, GAP_MS } from './restaurant.mjs';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label || 'eşit değil'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const satir = (date, amount, extra = {}) => ({ date, amountSoldRestaurant: amount, averagePrice: 59.0149, demand: 0.31265234, ...extra });
const yanit = [
  { dbLetter: 124, retailData: [satir('2026-10-01', 5721609), satir('2026-10-02', 5540626)] },
  { dbLetter: 4, retailData: [satir('2026-10-01', 0), satir('2026-10-02', 0)] },          // restoranda satılmaz
  { dbLetter: 7, retailData: [{ date: '2026-10-01', averagePrice: 3 }] },                 // alan yok
  { dbLetter: 'x', retailData: [satir('2026-10-01', 5)] },                                 // bozuk id
];

test('yalnız restoranda satılan ürünler alınır, değerler yuvarlanır', () => {
  const out = extractRestaurant(yanit);
  eq(Object.keys(out), ['124']);
  eq(out[124]['2026-10-01'], [5721609, 59.01, 0.3127]);
});
test('bozuk yanıt çökmez', () => {
  eq(extractRestaurant(null), {});
  eq(extractRestaurant([{}, { dbLetter: 1, retailData: 'x' }]), {});
});
test('birleştirme: yeni gün eklenir, ilk görülme yazılır', () => {
  const fresh = extractRestaurant(yanit);
  const m = mergeRestaurant(undefined, fresh, 1000);
  eq(m[124]['2026-10-02'], [5540626, 59.01, 0.3127, 1000]);
});
test('birleştirme: aynı değer ilk görülmeyi korur, düzeltme yazmaz', () => {
  const fresh = extractRestaurant(yanit);
  const a = mergeRestaurant(undefined, fresh, 1000);
  const b = mergeRestaurant(a, fresh, 2000);
  eq(b[124]['2026-10-01'][3], 1000);
  eq(b[124]['2026-10-01'].length, 4);
});
test('birleştirme: değer değişirse yenisi yazılır, düzeltme anı eklenir', () => {
  const a = mergeRestaurant(undefined, extractRestaurant(yanit), 1000);
  const degisen = [{ dbLetter: 124, retailData: [satir('2026-10-01', 5800000)] }];
  const b = mergeRestaurant(a, extractRestaurant(degisen), 3000);
  eq([b[124]['2026-10-01'][0], b[124]['2026-10-01'][3], b[124]['2026-10-01'][4]], [5800000, 1000, 3000]);
  ok(b[124]['2026-10-02'], 'yanıtta olmayan eski gün silinmemeli');
});
test('birleştirme: 400 günden eski satırlar atılır', () => {
  const now = Date.parse('2026-10-18T03:00:00Z');
  const prev = { 124: { '2024-01-01': [1, 1, 1, 1], '2026-10-01': [2, 1, 1, 1] } };
  const b = mergeRestaurant(prev, {}, now);
  eq(Object.keys(b[124]), ['2026-10-01']);
});
test('istekler arası bekleme 5 dakikadan uzun', () => ok(GAP_MS > 5 * 60_000));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
console.log(`${results.length - failed.length}/${results.length} test geçti.`);
process.exit(failed.length ? 1 : 0);
