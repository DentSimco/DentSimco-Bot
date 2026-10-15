// node bot/history_test.mjs — şirket geçmişi (son 30 gün) mantığının sınaması (ağ ve Firestore kullanmaz)
import assert from 'node:assert/strict';
import { dayNum, addDays, cutoffOf, toHistDay, mergeDays, mergeChunk, distinctDays, histChunkOf, histPath, updateHistory, HIST_DAYS, HIST_CHUNKS } from './history.mjs';
import { apiDay, apiDays } from './history_backfill.mjs';

// satır: [id, ad, sıra, sıraFarkı, eva, değer, değerFarkı, yüzde, bina, patent, işçi, bono, ayrıntıVar]
const row = (id, rank, extra = {}) => [id, `Ş${id}`, rank, 0, 5, 1000 + id, 0, 0, 10, 20, 300, 40, 1].map((v, i) => extra[i] ?? v);

assert.equal(dayNum('2026-10-15T00:00:00Z'), 20261015);
assert.equal(dayNum('bozuk'), null);
assert.equal(dayNum(undefined), null);
assert.equal(addDays(20261001, -1), 20260930);
assert.equal(addDays(20260101, -1), 20251231);
assert.equal(cutoffOf(20261015), 20260916, '30 günlük pencere: bugün dahil 30 gün');

assert.deepEqual(toHistDay(row(7, 3), 20261015), [20261015, 3, 5, 1007, 10, 20, 300, 40, 1]);
assert.deepEqual(toHistDay(row(7, 3, { 12: 0 }), 20261015), [20261015, 3, 5, 1007, null, null, null, null, 0], 'ayrıntısı gelmemiş şirkette bina, patent, işçi, bono boş');

// Yeni gün eklenir, artan sıra; 30 günün dışı düşer
let h = [];
for (let d = 0; d < 35; d++) h = mergeDays(h, [addDays(20260901, d), d + 1, 5, 100 + d, 1, 1, 1, 1, 1], addDays(20260901, d));
assert.equal(h.length, HIST_DAYS, '35 gün eklenince 30 gün kalır');
assert.equal(h[0][0], addDays(20260901, 5), 'en eski 5 gün düştü');
assert.equal(h.at(-1)[0], addDays(20260901, 34));
assert.deepEqual(h.map((x) => x[0]), [...h.map((x) => x[0])].sort((a, b) => a - b), 'artan tarih');

// Aynı gün yeniden gelirse yenisi geçer; yeni ayrıntısızsa eski ayrıntı kalır
const gun = (d, extra) => [d, 1, 5, 100, ...extra];
const a = mergeDays([gun(20261015, [7, 8, 9, 10, 1])], gun(20261015, [null, null, null, null, 0]), 20261015);
assert.deepEqual(a[0].slice(4), [7, 8, 9, 10, 1], 'ayrıntı geri gitmez');
const b = mergeDays([gun(20261015, [null, null, null, null, 0])], gun(20261015, [7, 8, 9, 10, 1]), 20261015);
assert.deepEqual(b[0].slice(4), [7, 8, 9, 10, 1], 'ayrıntı gelince dolar');
assert.equal(mergeDays([gun(20261016, [1, 1, 1, 1, 1])], null, 20261015).length, 0, 'gelecek tarihli kayıt atılır');

// Parça: yalnız bugünkü sıralamadaki şirketler kalır
const eski = { 1: [[20261014, 2, 5, 900, 1, 1, 1, 1, 1]], 99: [[20261014, 9, 5, 5, 1, 1, 1, 1, 1]] };
const yeni = mergeChunk(eski, [row(1, 1)], 20261015);
assert.deepEqual(Object.keys(yeni), ['1'], 'kapanan şirket (99) düşer');
assert.equal(yeni[1].length, 2);
assert.deepEqual(distinctDays([yeni, { 5: [[20261013, 1, 1, 1, 1, 1, 1, 1, 1]] }]), [20261013, 20261014, 20261015]);

assert.equal(histChunkOf(1664165), 1664165 % HIST_CHUNKS);
assert.equal(histPath(0, 5), 'meta/rhist_r0_005');

// API satırı → gün; ayrıntısı yoksa boş; son 30 gün dışarısı atılır
const api = (date, extra = {}) => ({ date, rank: 1, evaRank: 68, value: 21e9, buildingsValue: 5, patentsValue: 6, workers: 7, bondsSold: 8, fetched: true, ...extra });
assert.deepEqual(apiDay(api('2026-10-15T00:00:00Z')), [20261015, 1, 68, 21e9, 5, 6, 7, 8, 1]);
assert.deepEqual(apiDay(api('2026-10-15T00:00:00Z', { fetched: false })).slice(4), [null, null, null, null, 0]);
assert.equal(apiDay({ date: 'x', rank: 1, value: 1 }), null);
const days = apiDays({ history: [api('2026-10-15T00:00:00Z'), api('2026-10-14T00:00:00Z'), api('2026-09-16T00:00:00Z'), api('2026-09-15T00:00:00Z')] }, 20261015);
assert.deepEqual(days.map((x) => x[0]), [20260916, 20261014, 20261015], '15 Eylül 30 gün dışında');

// updateHistory: sahte Firestore ile; ikinci gün eklenir, 30 güne ulaşınca geri doldurma belgeleri silinir
const db = (() => {
  const store = new Map();
  const commits = [];
  return {
    store, commits,
    async getMany(paths) { return new Map(paths.map((p) => [p, store.get(p) ?? null])); },
    async commit(writes) { commits.push(writes); for (const w of writes) { if (w.type === 'set') store.set(w.path, w.data); else store.delete(w.path); } },
  };
})();
const rows = [row(1, 1), row(257, 2), row(2, 3)]; // 1 ve 257 aynı parçada (257 % 256 = 1)
let r = await updateHistory(db, 0, rows, '2026-10-14T00:00:00Z', 1);
assert.deepEqual([r.n, r.days], [3, 1]);
r = await updateHistory(db, 0, rows, '2026-10-15T00:00:00Z', 2);
assert.equal(r.days, 2);
const chunk1 = JSON.parse(db.store.get(histPath(0, 1)).data);
assert.deepEqual(Object.keys(chunk1).sort(), ['1', '257']);
assert.equal(chunk1[1].length, 2);
const index = JSON.parse(db.store.get('meta/rhist_r0').data);
assert.deepEqual([index.chunks, index.days, index.n], [HIST_CHUNKS, [20261014, 20261015], 3]);
assert.equal(db.commits.at(-1).filter((w) => w.type === 'delete').length, 0, '30 güne ulaşmadan geri doldurma silinmez');
assert.deepEqual(await updateHistory(db, 0, rows, 'bozuk tarih', 3), { n: 0, days: 0, skipped: true }, 'tarih okunamazsa yazılmaz');
const iso = (day) => `${String(day).slice(0, 4)}-${String(day).slice(4, 6)}-${String(day).slice(6, 8)}T00:00:00Z`;
for (let d = 1; d <= 29; d++) r = await updateHistory(db, 0, rows, iso(addDays(20261015, d)), 10 + d);
assert.equal(r.days, 30, '30 güne ulaştı');
assert.equal(db.commits.at(-1).filter((w) => w.type === 'delete').length, HIST_CHUNKS, '30 güne ulaşınca geri doldurma belgeleri silinir');
r = await updateHistory(db, 0, rows, iso(addDays(20261015, 30)), 99);
assert.equal(r.days, 30, '31. gün eklenince en eski gün düşer, 30 gün kalır');
console.log('history_test: tamam');
