// node bot/ranking_test.mjs — sıralama dönüştürücüsünün sınaması (ağ ve Firestore kullanmaz)
import assert from 'node:assert/strict';
import { toRow, buildRows, chunkRows, topLists } from './ranking.mjs';

const c = (id, rank, extra = {}) => ({
  companyId: id, companyName: `Şirket ${id}`, rank, rankDiff: 1, evaRank: 5, companyValue: 1000, companyValueDiff: -5,
  companyValuePctChange: 0.123456789, buildingsValue: 10, patentsValue: 20, workers: 300, bondsSold: 40, isDeleted: false, fetched: true, ...extra,
});

assert.deepEqual(toRow(c(7, 3)), [7, 'Şirket 7', 3, 1, 5, 1000, -5, 0.12346, 10, 20, 300, 40, 1]);
assert.equal(toRow(c(7, 3, { fetched: false }))[12], 0);
assert.equal(toRow(c(7, 3, { isDeleted: true })), null);
assert.equal(toRow(null), null);
assert.equal(toRow({ companyId: 'x', rank: 1 }), null);
assert.equal(toRow(c(8, 4, { buildingsValue: null }))[8], 0);

// Sayfalar karışık gelse de sıra numarasına göre dizilir, yinelenen şirket bir kez yazılır
const rows = buildRows([{ ranking: [c(3, 3), c(4, 4)] }, { ranking: [c(1, 1), c(2, 2), c(3, 3)] }, null]);
assert.deepEqual(rows.map((x) => x[0]), [1, 2, 3, 4]);

assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunkRows([], 2), []);
// İlk 10: değer sırasına göre; EVA büyükten küçüğe, ayrıntısı olmayan ve EVA'sı 0 olan dışarıda
const rr = [toRow(c(1, 2, { evaRank: 10 })), toRow(c(2, 1, { evaRank: 0 })), toRow(c(3, 3, { evaRank: 50 })), toRow(c(4, 4, { evaRank: 99, fetched: false }))];
const top = topLists(rr, 2);
assert.deepEqual(top.deger.map((x) => x[0]), [2, 1]);
assert.deepEqual(top.eva.map((x) => x[0]), [3, 1]);
console.log('ranking_test: tamam');
