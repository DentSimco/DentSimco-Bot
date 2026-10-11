// node bot/news_test.mjs — haber masası sınaması (ağ, Firestore ve Claude kullanmaz; Claude sahte istemciyle taklit edilir)
import assert from 'node:assert/strict';
import { mainQuality, productDigest, buildDigest, askClaude, toArticles, mergeIssue, SCHEMA, KATEGORILER } from './news.mjs';

const today = '2026-10-11';
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// Q0 az, Q1 çok işlem görür; kapanış her gün 1 artar
const daily = new Map();
for (let i = -21; i <= -1; i++) daily.set(day(i), { 0: [1, 1, 1, 10 + i, null, 5, 50], 1: [1, 1, 1, 100 + i, null, 50, 5000] });

assert.equal(mainQuality(daily, [day(-1), day(-2)]), 1);
assert.equal(mainQuality(new Map(), [day(-1)]), null);

const p = productDigest({ id: 7, ad: 'Elma', live: [0, { 1: [110, null, 0, 0, 0] }], dailyByDay: daily, today });
assert.equal(p.q, 1);
assert.equal(p.dun, 99);
assert.equal(p.d1, 11.11);       // 110 / 99
assert.equal(p.d7, 7.61);        // 99 / 92
assert.equal(p.d21, 39.24);      // 110 / 79 (grafiğin başı → bugün)
assert.equal(p.hacimDun, 5000);
assert.equal(p.seri.length, 21);
assert.deepEqual(p.seri.at(-1), [day(-1), 99]);
assert.equal(productDigest({ id: 8, ad: 'X', live: null, dailyByDay: new Map(), today }), null);

const products = Array.from({ length: 12 }, (_, i) => ({ ...p, id: i + 1, ad: `Ürün ${i + 1}`, d1: i - 5, d7: 5 - i, hacimDun: i * 100 }));
const d = buildDigest({ realm: 0, now: 0, products, ranking: { date: 'x', deger: [[1, 'A', 1, 0, 5, 100, 1, 0.01]], eva: [] }, phase: 'boom', previous: ['eski'] });
assert.equal(d.piyasa.gunlukYukselenler[0].id, 12);
// Modelin gördüğü alanlar açık adlı; fiyat ile hacim ayrı
const row = d.piyasa.gunlukYukselenler[0];
assert.equal(row.kalite, 'Q1');
assert.ok('bugunFiyatDegisimiYuzde' in row && 'dunkuIslemHacmiDolar' in row && 'dunkuSatilanAdet' in row);
assert.ok(!('d1' in row) && !('hacimDun' in row));
for (const k of Object.keys(row)) if (!['id', 'urun'].includes(k)) assert.ok(d.alanlar[k], `alan açıklaması eksik: ${k}`);
assert.equal(d.piyasa.gunlukDusenler[0].id, 1);
assert.equal(d.sirketler.degerIlk10[0].degerYuzde, 1);
assert.ok(Object.keys(d.piyasa.seriler).length > 0);
assert.deepEqual(d.oncekiBasliklar, ['eski']);

// Şemadaki her nesne katı olmalı (yapılandırılmış çıktı kuralı)
(function walk(s) {
  if (!s || typeof s !== 'object') return;
  if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort()); }
  Object.values(s).forEach(walk);
})(SCHEMA);

const yazi = (b) => ({ baslik: b, spot: 's', govde: ['p1', '  p2  '] });
const fakeOut = {
  manset: { kategori: 'PİYASA', urun_id: 7, tr: yazi('Elma yükseldi'), en: yazi('Apples up') },
  haberler: [{ kategori: 'YOK', urun_id: 999, tr: yazi('Haber'), en: yazi('News') }, { kategori: 'ÜRETİM', urun_id: null, tr: { baslik: '', govde: [] }, en: yazi('x') }],
  kose: { tr: yazi('Köşe'), en: yazi('Column') },
};

// Sahte istemci: isteğin biçimini denetler
let req = null;
const client = { beta: { messages: { stream(r) { req = r; return { finalMessage: async () => ({ stop_reason: 'end_turn', model: r.model, usage: {}, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(fakeOut) }] }) }; } } } };
const { out } = await askClaude(d, { client });
assert.equal(req.model, 'claude-sonnet-5-5');
assert.equal(req.output_config.format.type, 'json_schema');
assert.equal(req.fallbacks, 'default');
assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
assert.equal(req.thinking.type, 'adaptive');
assert.deepEqual(out, fakeOut);
const refuse = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { category: 'x' }, content: [] }) }) } } };
await assert.rejects(askClaude(d, { client: refuse }), /reddetti/);

const art = toArticles(out, { now: 1000, seriler: { 7: { ad: 'Elma', q: 1, seri: [[day(-1), 99]], canli: 110 } } });
assert.equal(art.manset.grafik.ad, 'Elma');
assert.equal(art.manset.grafik.canli, 110);
assert.deepEqual(art.manset.tr.govde, ['p1', 'p2']);
assert.equal(art.haberler.length, 1, 'boş haber atılır');
assert.equal(art.haberler[0].kategori, 'PİYASA', 'bilinmeyen kategori PİYASA olur');
assert.equal(art.haberler[0].grafik, null, 'serisi olmayan ürünün grafiği yok');
assert.equal(art.kose.yazar, 'Masa');
assert.ok(KATEGORILER.includes('ŞİRKETLER'));
assert.throws(() => toArticles({ manset: null }, { now: 1, seriler: {} }), /Manşet/);

const prev = { manset: { id: 'm0' }, haberler: Array.from({ length: 30 }, (_, i) => ({ id: `h${i}` })), kose: { id: 'k0' } };
const merged = mergeIssue(prev, { manset: { id: 'm1' }, haberler: [{ id: 'n1' }], kose: null });
assert.equal(merged.manset.id, 'm1');
assert.deepEqual(merged.haberler.slice(0, 3).map((h) => h.id), ['n1', 'm0', 'h0']);
assert.equal(merged.haberler.length, 18);
assert.equal(merged.kose.id, 'k0', 'yeni köşe yoksa eskisi kalır');
console.log('news_test: tamam');
