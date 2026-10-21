// DentSimco — "Diğer" botu sınaması. Çalıştırma: node bot/diger_test.mjs (ağa çıkılmaz)
import {
  createGate, allPages, mergeGo, goFromSc, buildingCounts, addBuildingDay, compactSummaries, mergeDays,
  compactRanges, compactEvents, certValue, certPeriod, compactCert, fitRows, GAP_MS, WAIT_429_MS,
} from './diger.mjs';

const results = [];
const asyncTests = [];
function test(name, fn) {
  const done = (error) => results.push(error ? { name, ok: false, error: error.message } : { name, ok: true });
  try {
    const r = fn();
    if (r?.then) asyncTests.push(r.then(() => done(), done));
    else done();
  } catch (e) { done(e); }
}
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label || 'eşit değil'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// Sahte saat: bekleme anında ilerler
function sahteSaat() {
  let t = 0;
  return { now: () => t, wait: async (ms) => { t += ms; } };
}
const yanit = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('kapı: istekler arası en az GAP_MS (saniyede 2 istekten az), yalnız GET', async () => {
  ok(GAP_MS >= 500, 'aralık 500 ms altına inmemeli');
  const saat = sahteSaat();
  const anlar = [];
  const yontemler = [];
  const gate = createGate({ ...saat, fetcher: async (url, o) => { anlar.push(saat.now()); yontemler.push(o.method); return yanit(200, { url }); } });
  for (let i = 0; i < 5; i++) await gate.get(`https://api.simcotools.com/v1/x${i}`);
  for (let i = 1; i < anlar.length; i++) ok(anlar[i] - anlar[i - 1] >= GAP_MS, `aralık ${anlar[i] - anlar[i - 1]}`);
  eq([...new Set(yontemler)], ['GET']);
  eq(gate.stat.ok, 5);
});

test('kapı: 429 gelince 2 sn beklenir ve aynı istek yeniden denenir', async () => {
  eq(WAIT_429_MS, 2000);
  const saat = sahteSaat();
  const anlar = [];
  let n = 0;
  const gate = createGate({ ...saat, fetcher: async () => { anlar.push(saat.now()); return ++n <= 2 ? yanit(429, {}) : yanit(200, { tamam: 1 }); } });
  eq(await gate.get('https://api.simcotools.com/v1/y'), { tamam: 1 });
  eq(gate.stat.n429, 2);
  ok(anlar[1] - anlar[0] >= WAIT_429_MS && anlar[2] - anlar[1] >= WAIT_429_MS, `beklemeler ${anlar}`);
});

test('kapı: 404 hemen hata verir, süre dolunca istek atılmaz', async () => {
  const saat = sahteSaat();
  const gate = createGate({ ...saat, fetcher: async () => yanit(404, {}) });
  let hata = null;
  try { await gate.get('https://api.simcotools.com/v1/z'); } catch (e) { hata = e; }
  ok(/404/.test(hata?.message), 'HTTP 404 beklenirdi');
  const bitti = createGate({ ...saat, deadline: 0, fetcher: async () => yanit(200, {}) });
  let d = null;
  try { await bitti.get('https://api.simcotools.com/v1/z'); } catch (e) { d = e; }
  ok(d?.deadline, 'süre doldu hatası beklenirdi');
});

test('sayfalı liste: tüm sayfalar; çok sayfalı listede yalnız ilk sayfa', async () => {
  const sayfa = (p, last) => ({ metadata: { lastPage: last, totalRecords: last * 2 }, items: [p * 10, p * 10 + 1] });
  const istenen = [];
  const get = async (url) => { istenen.push(url); const p = Number(/page=(\d+)/.exec(url)[1]); return sayfa(p, 3); };
  const a = await allPages(get, 'https://x/l', 'items');
  eq(a.items, [10, 11, 20, 21, 30, 31]);
  eq(a.complete, true);
  ok(istenen.every((u) => /page_size=100/.test(u)), 'sayfa boyu 100');
  const b = await allPages(get, 'https://x/l?sort=-id', 'items', { maxPages: 2 });
  eq(b.items, [10, 11]);
  eq(b.complete, false);
  eq(b.total, 6);
});

const SC_GO = {
  id: 868, projectKey: 'MEDICAL_SUPPLIES_2', size: 1, created: '2026-10-14T13:00:33.563205+00:00', realm: 0, resourceMultiplierAwarded: 90,
  estimatedBaseValue: 4420711, daysToFulfill: 6,
  governmentorderrequiredresourceSet: [{ id: 1, templateId: 868, kind: 61, quality: 1, amountBase: 96224 }, { id: 2, templateId: 868, kind: 26, quality: 0, amountBase: 1781 }],
};
const ST_GO = { id: 868, daysToFulfill: 6, resources: [{ resourceId: 61, quality: 1, resourceName: 'Gloves' }], created: '2026-10-14T13:00:33.563205Z', projectName: 'Medical Supplies' };

test('GO: Sim Companies satırı miktarlarıyla sadeleşir', () => {
  const o = goFromSc(SC_GO);
  eq([o.id, o.k, o.d, o.s, o.m, o.e], [868, 'MEDICAL_SUPPLIES_2', 6, 1, 90, 4420711]);
  eq(o.r, [[61, 1, 96224], [26, 0, 1781]]);
  eq(o.c, Date.parse('2026-10-14T13:00:33.563Z'));
});

test('GO: iki kaynak birleşir; ilandan kalkan sipariş miktar ve çarpanını korur', () => {
  const a = mergeGo(null, [SC_GO], [ST_GO, { ...ST_GO, id: 29, projectName: 'Fire Trucks' }], 1000);
  eq(Object.keys(a).sort(), ['29', '868']);
  eq([a[868].n, a[868].k, a[868].m, a[868].r.length, a[868].f, a[868].l], ['Medical Supplies', 'MEDICAL_SUPPLIES_2', 90, 2, 1000, 1000]);
  eq(a[29].r, [[61, 1, null]]);
  // Sonraki tur: sipariş Sim Companies listesinde yok, Simcotools'ta var
  const b = mergeGo(a, [], [ST_GO], 2000);
  eq([b[868].m, b[868].r[0][2], b[868].l, b[868].f], [90, 96224, 1000, 1000]);
  // İlandaki sipariş (çarpan yok) sonra çarpan kazanır
  const ilan = { ...SC_GO, id: 900, resourceMultiplierAwarded: undefined };
  const c = mergeGo(b, [ilan], [], 3000);
  eq(c[900].m, null);
  eq(mergeGo(c, [{ ...ilan, resourceMultiplierAwarded: 120 }], [], 4000)[900].m, 120);
});

test('bina: sayılar, geçmiş günü ve eski günlerin düşmesi', () => {
  const counts = buildingCounts({ buildings: [{ id: 'E', name: 'Power plant', count: 35069, proportion: 0.113 }, { id: 'P', count: 'x' }] });
  eq(counts, { E: [35069, 0.113] });
  let h = {};
  for (let i = 0; i < 405; i++) h = addBuildingDay(h, 20250000 + i, counts);
  eq(Object.keys(h).length, 400);
  ok(!(20250000 in h) && (20250404 in h), 'en eski günler düşmeli');
  eq(h[20250404], { E: 35069 });
});

test('evre: günlük özet birleşir, yarım gün eksiğini eskiden alır; evreler sıralanır', () => {
  const a = compactSummaries([{ date: '2026-10-20T00:00:00Z', activeCompanies: 5, companiesValue: 9, totalBuildings: 3, bondsSold: 1, phase: 'normal' }]);
  const b = compactSummaries([{ date: '2026-10-20T00:00:00Z', activeCompanies: 6, companiesValue: 10, phase: 'boom' }, { date: '2026-10-21T00:00:00Z', activeCompanies: 7, phase: 'boom' }]);
  const m = mergeDays(mergeDays([], a), b);
  eq(m, [[20261020, 6, 10, 3, 1, 2], [20261021, 7, null, null, null, 2]]);
  eq(compactRanges([{ phase: 'boom', start: '2026-02-01T15:00:00Z', end: 'x' }, { phase: 'normal', start: '2026-01-01T15:00:00Z', end: '2026-02-01T15:00:00Z' }, { phase: '?', start: '2026-01-01' }])
    .map((x) => x[0]), ['normal', 'boom']);
  eq(compactEvents([{ id: 1, resource: 13, speedModifier: -27, since: '2026-10-19T00:00:00Z', until: '2026-11-09T00:00:00Z', producedAt: 'S' }])[0].slice(0, 3), [1, 13, -27]);
});

test('sertifika: değer alanı, dönem ve kısa satır', () => {
  eq(certValue({ datetime: 'x', goldenBars: 236579 }), ['goldenBars', 236579]);
  eq(certValue({ datetime: 'x' }), [null, null]);
  eq(certPeriod({ month: 9, year: 2026 }), '2026-09');
  eq(certPeriod({ week: 42, year: 2026 }), '2026-W42');
  eq(certPeriod(undefined), '');
  eq(compactCert({ id: 1, companyId: 2, companyName: 'A', certInfo: { amount: 5, datetime: '2026-10-01T00:00:00+00:00' }, date: { month: 9, year: 2026 }, resourceKind: 155 }),
    [1, 2, 'A', '2026-09', 155, 5, Date.parse('2026-10-01T00:00:00Z')]);
});

test('belge sınırı: büyük listede en eski satırlar düşer', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [1000 - i, 'şirket adı uzun']);
  const a = fitRows(rows, 5000);
  ok(a.cut && JSON.stringify(a.rows).length <= 5000 && a.rows[0][0] === 1000, 'en yeni satır kalmalı');
  eq(fitRows(rows.slice(0, 3)).cut, false);
});

await Promise.all(asyncTests);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
console.log(`${results.length - failed.length}/${results.length} test geçti.`);
process.exit(failed.length ? 1 : 0);
