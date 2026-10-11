// DentSimco Bot — Haber masası (Claude API)
// GitHub Actions bunu her sabah 08:00'de (TR) bir kez çalıştırır (.github/workflows/haber.yml). Simcotools'a HİÇ istek atmaz:
// yalnız diğer botların Firestore'a yazdığı veriyi okur (canlı borsa, günlük özetler, şirket sıralaması, ekonomi evresi).
//
// Akış: her realm için veriden bir "masa özeti" (digest) kurulur → Claude hangi haberlerin yazılacağına kendisi karar verir
// ve manşeti, haberleri ve köşe yazısını Türkçe + İngilizce yazar → sonuç doğrulanır, grafik serisi eklenir → Firestore.
// Model yalnız özetteki sayıları kullanır; sayı uydurmaması sistem isteminde açıkça yazılıdır.
//
// Firestore'a yazılan biçim (dashboard haberler.js okur):
//   meta/news_r{realm}  data = JSON {v, t, manset: Haber, haberler: [Haber, ...], kose: Kose, fiyatlar: {id: [ad, dünküKapanış, anaKalite]}}
//   Haber = {id, t, kategori, tr: {baslik, spot, govde: [paragraf]}, en: {...}, grafik: {id, ad, q, seri: [[gün, kapanış]]} | null}
//   Kose  = {id, t, yazar, tr: {baslik, spot, govde}, en: {...}}
// Önceki çalışmanın manşeti ve haberleri listede kalır (en çok MAX_ITEMS, en eskisi düşer); model önceki başlıkları görür
// ve aynı haberi tekrar yazmaz.

import { CONFIG, PATHS, parseJSON, round, runIfMain, utcDay, addDays } from './common.mjs';
import { Firestore } from './firestore.mjs';

const VERSION = 1;
export const MODEL = 'claude-sonnet-5-5';
const MAX_ITEMS = 18;          // sayfadaki haber listesi (manşet hariç)
const SERIES_DAYS = 21;        // grafik için gün sayısı
export const KATEGORILER = ['PİYASA', 'ÜRETİM', 'ŞİRKETLER', 'EKONOMİ', 'PERAKENDE', 'ANALİZ'];

const pct = (a, b) => (a > 0 && b > 0 ? round((a / b - 1) * 100, 2) : null);
const mmdd = (day) => `d${day.slice(5, 7)}${day.slice(8, 10)}`;

// ---- Masa özeti -------------------------------------------------------------------------------

// Bir ürünün günlük satırlarından (gün → {q: [o,h,l,c,ortArz,satış,tutar]}) ana kaliteyi seçer: son 7 günde en çok
// tutar dönen kalite. Hiç işlem yoksa null.
export function mainQuality(dailyByDay, days7) {
  const sum = {};
  for (const day of days7) {
    for (const [q, row] of Object.entries(dailyByDay.get(day) || {})) sum[q] = (sum[q] || 0) + (Number(row?.[6]) || 0);
  }
  const best = Object.entries(sum).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  return best ? Number(best[0]) : null;
}

// Tek ürünün özeti. live = live belgesindeki ürün kaydı [t, {q: [fiyat, arz, satış, tutar, sonİşlem]}]
export function productDigest({ id, ad, live, dailyByDay, today }) {
  const yesterday = addDays(today, -1);
  const days = Array.from({ length: SERIES_DAYS }, (_, i) => addDays(yesterday, i - SERIES_DAYS + 1));
  const q = mainQuality(dailyByDay, days.slice(-7));
  if (q == null) return null;
  const close = (day) => Number(dailyByDay.get(day)?.[q]?.[3]) || null;
  const seri = days.map((d) => [d, close(d)]).filter(([, c]) => c);
  const dun = close(yesterday) ?? seri.at(-1)?.[1] ?? null;
  const once7 = close(addDays(yesterday, -7));
  const fiyat = Number(live?.[1]?.[q]?.[0]) || null;
  const tutar = (day) => Number(dailyByDay.get(day)?.[q]?.[6]) || 0;
  const adet = (day) => Number(dailyByDay.get(day)?.[q]?.[5]) || 0;
  const hacim7 = days.slice(-7).reduce((s, d) => s + tutar(d), 0) / 7;
  return {
    id, ad, q,
    fiyat, dun, d1: pct(fiyat, dun), d7: pct(dun, once7),
    hacimDun: Math.round(tutar(yesterday)), adetDun: Math.round(adet(yesterday)), hacim7: Math.round(hacim7),
    seri,
  };
}

const short = (p) => ({ id: p.id, ad: p.ad, q: p.q, fiyat: p.fiyat, dun: p.dun, d1: p.d1, d7: p.d7, hacimDun: p.hacimDun, hacim7: p.hacim7 });

// Modelin göreceği özet: listeler kısa tutulur (token ve dikkat için), öne çıkan ürünlerin serisi eklenir.
export function buildDigest({ realm, now, products, ranking, phase, previous }) {
  const liquid = products.filter((p) => p.hacim7 >= 1000);
  const by = (key, dir, n, list = liquid) => [...list].filter((p) => p[key] != null).sort((a, b) => dir * (a[key] - b[key])).slice(0, n);
  const yukselen1 = by('d1', -1, 8);
  const dusen1 = by('d1', 1, 8);
  const yukselen7 = by('d7', -1, 8);
  const dusen7 = by('d7', 1, 8);
  const hacim = by('hacimDun', -1, 12, products);
  const featured = new Map();
  for (const p of [...yukselen1, ...dusen1, ...yukselen7, ...dusen7, ...hacim]) featured.set(p.id, p);
  const rk = (r) => ({ id: r[0], ad: r[1], sira: r[2], siraFarki: r[3], eva: r[4], deger: r[5], degerFarki: r[6], degerYuzde: round(r[7] * 100, 2) });
  return {
    realm: realm === 0 ? 'Realm 1 (R1)' : 'Realm 2 (R2)',
    an: new Date(now).toISOString(),
    ekonomiEvresi: phase || 'bilinmiyor',
    piyasa: {
      urunSayisi: products.length,
      gunlukYukselenler: yukselen1.map(short),
      gunlukDusenler: dusen1.map(short),
      haftalikYukselenler: yukselen7.map(short),
      haftalikDusenler: dusen7.map(short),
      enCokIslemGorenler: hacim.map(short),
      seriler: Object.fromEntries([...featured.values()].map((p) => [p.id, p.seri.map(([d, c]) => [d.slice(5), c])])),
    },
    sirketler: ranking ? {
      tarih: ranking.date,
      degerIlk10: (ranking.deger || []).map(rk),
      evaIlk10: (ranking.eva || []).map(rk),
    } : null,
    oncekiBasliklar: previous,
  };
}

// ---- Claude ----------------------------------------------------------------------------------

const yazi = {
  type: 'object',
  additionalProperties: false,
  required: ['baslik', 'spot', 'govde'],
  properties: {
    baslik: { type: 'string', description: 'Başlık; en çok ~90 karakter.' },
    spot: { type: 'string', description: 'Başlığın altındaki 1-2 cümlelik özet.' },
    govde: { type: 'array', items: { type: 'string' }, description: 'Paragraflar (2-5 paragraf, her biri 1-4 cümle).' },
  },
};
const haber = {
  type: 'object',
  additionalProperties: false,
  required: ['kategori', 'urun_id', 'tr', 'en'],
  properties: {
    kategori: { type: 'string', enum: KATEGORILER },
    urun_id: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Grafiği çizilecek ürünün id\'si (özetteki seriler listesinden) ya da null.' },
    tr: yazi,
    en: yazi,
  },
};
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manset', 'haberler', 'kose'],
  properties: {
    manset: haber,
    haberler: { type: 'array', items: haber, description: '5-8 haber, önem sırasıyla.' },
    kose: {
      type: 'object',
      additionalProperties: false,
      required: ['tr', 'en'],
      properties: { tr: yazi, en: yazi },
    },
  },
};

export const SYSTEM = `Sen DentSimco News'in yazı işleri müdürü ve muhabirisin. DentSimco, Sim Companies adlı ekonomi oyununun oyuncuları için bir araç; haberlerin okuru bu oyunu oynayan, borsada alım satım yapan ve üretim planlayan oyunculardır.

Sana bir realm için hazırlanmış bir masa özeti (JSON) verilecek: oyundaki borsanın günlük ve haftalık hareketleri, işlem hacimleri, fiyat serileri, şirket değeri ve EVA sıralamalarının ilk 10'u, ekonomi evresi ve son yayınlanan başlıklar.

Görevin:
1. Özetten okura en çok yarayacak haberleri SEN seç. Ölçütün: büyük ve hacimli fiyat hareketleri, girdisi çok kullanılan ürünlerdeki (Enerji, Su, Taşıma, Tohum, Çelik vb.) değişimler, sıralamadaki dikkat çekici kıpırdanmalar, ekonomi evresinin anlamı. Hacmi düşük üründeki yüzde sıçramasını büyük haber yapma.
2. Bir manşet, 5-8 haber ve bir köşe yazısı yaz. Köşe yazısı yorumdur: haftanın piyasasına geniş bir bakış, oyunculara düşünce payı bırakan kısa bir deneme; "Masa" imzasıyla yazılır.
3. "oncekiBasliklar" içindeki konuları aynı açıdan tekrar yazma; gelişme varsa yeni açıdan yaz.

Kurallar:
- YALNIZ özetteki sayıları kullan. Sayı, şirket, ürün, olay uydurma. Bir nedeni veri göstermiyorsa neden uydurma; olasılık olarak ve ölçülü dille söyle ("arz daralmış olabilir" gibi), kesinmiş gibi yazma.
- Fiyatlar dolar ($) ve oyundaki birimlerdir. Yüzdeleri bir ondalıkla yaz (Türkçede virgülle: %3,2). Q kalite seviyesidir (Q0, Q1...).
- Üslup: Bloomberg ve BBC haber dili. Kısa, net, bilgi yoğun; ilk cümle haberin özü. Abartı, ünlem, yatırım tavsiyesi yok ("al", "sat" deme; "fiyat yükseldi" de).
- Türkçe metin asıl metindir; İngilizce metin aynı haberin doğal İngilizce karşılığıdır (birebir çeviri değil, aynı içerik).
- Ürün adlarını özette yazıldığı gibi kullan. İngilizce metinde ürünün oyundaki İngilizce adını biliyorsan onu kullan.
- urun_id: haber tek bir ürünün fiyatıyla ilgiliyse o ürünün id'si ("seriler" içinde olmalı), değilse null.`;

// Claude'u çağırır ve ayrıştırılmış JSON'u döner. client verilmezse Anthropic SDK'sı yüklenir (ANTHROPIC_API_KEY).
export async function askClaude(digest, { client } = {}) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // güvenlik sınıflandırıcısı reddederse Anthropic'in önerdiği modelle yeniden dener
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Masa özeti:\n${JSON.stringify(digest)}` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error(`Model yazmayı reddetti (${msg.stop_details?.category || '-'})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Yanıt yarıda kesildi (max_tokens)');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = JSON.parse(text);
  return { out, usage: msg.usage, model: msg.model };
}

// ---- Doğrulama ve yayın biçimi ---------------------------------------------------------------

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function cleanText(x) {
  const baslik = clip(x?.baslik, 160);
  const spot = clip(x?.spot, 400);
  const govde = (Array.isArray(x?.govde) ? x.govde : []).map((p) => clip(p, 1500)).filter(Boolean).slice(0, 8);
  return baslik && govde.length ? { baslik, spot, govde } : null;
}

// Modelin yanıtını yayın biçimine çevirir; bozuk haberleri atar. seriler: {id: {ad, q, seri}}
export function toArticles(out, { now, seriler }) {
  let n = 0;
  const id = () => `${now.toString(36)}-${(n++).toString(36)}`;
  const article = (h) => {
    const tr = cleanText(h?.tr);
    if (!tr) return null;
    const en = cleanText(h?.en) || tr;
    const kategori = KATEGORILER.includes(h?.kategori) ? h.kategori : 'PİYASA';
    const s = Number.isInteger(h?.urun_id) ? seriler[h.urun_id] : null;
    return { id: id(), t: now, kategori, tr, en, grafik: s ? { id: h.urun_id, ad: s.ad, q: s.q, seri: s.seri } : null };
  };
  const manset = article(out?.manset);
  if (!manset) throw new Error('Manşet boş ya da bozuk geldi');
  const haberler = (Array.isArray(out?.haberler) ? out.haberler : []).map(article).filter(Boolean);
  const ktr = cleanText(out?.kose?.tr);
  const kose = ktr ? { id: id(), t: now, yazar: 'Masa', tr: ktr, en: cleanText(out?.kose?.en) || ktr } : null;
  return { manset, haberler, kose };
}

// Yeni sayıyı öncekiyle birleştirir: önceki manşet ve haberler listenin sonuna geçer, en çok MAX_ITEMS kalır.
export function mergeIssue(prev, fresh) {
  const old = [prev?.manset, ...(prev?.haberler || [])].filter(Boolean);
  const haberler = [...fresh.haberler, ...old].slice(0, MAX_ITEMS);
  return { manset: fresh.manset, haberler, kose: fresh.kose || prev?.kose || null };
}

// ---- Ana akış ---------------------------------------------------------------------------------

async function realmIssue(db, r, now, shared) {
  const today = utcDay(now);
  const ids = (shared.tradable[r] || []).map(Number).filter(Number.isFinite);
  const years = [...new Set([today.slice(0, 4), addDays(today, -SERIES_DAYS - 1).slice(0, 4)])];
  const docs = await db.getMany([
    PATHS.live(r), PATHS.meta(`products_r${r}`), PATHS.meta(`ranking_top_r${r}`), PATHS.meta(`news_r${r}`),
    ...ids.flatMap((id) => years.map((y) => PATHS.daily(r, id, y))),
  ]);
  const live = parseJSON(docs.get(PATHS.live(r))?.data)?.items || {};
  const names = parseJSON(docs.get(PATHS.meta(`products_r${r}`))?.data) || {};
  const ranking = parseJSON(docs.get(PATHS.meta(`ranking_top_r${r}`))?.data);
  const prev = parseJSON(docs.get(PATHS.meta(`news_r${r}`))?.data);

  const products = [];
  for (const id of ids) {
    const dailyByDay = new Map();
    for (const y of years) {
      const f = docs.get(PATHS.daily(r, id, y)) || {};
      for (const [k, text] of Object.entries(f)) {
        const m = /^d(\d\d)(\d\d)$/.exec(k);
        const row = m && parseJSON(text);
        if (row) dailyByDay.set(`${y}-${m[1]}-${m[2]}`, row);
      }
    }
    const ad = names[id]?.name || `Ürün ${id}`;
    const p = productDigest({ id, ad, live: live[id], dailyByDay, today });
    if (p) products.push(p);
  }
  if (products.length < 10) throw new Error(`r${r}: yeterli piyasa verisi yok (${products.length} ürün)`);

  const phase = shared.phase?.[`r${r}`]?.phase;
  const previous = [prev?.manset, ...(prev?.haberler || [])].filter(Boolean).slice(0, 12).map((h) => h.tr?.baslik);
  const digest = buildDigest({ realm: r, now, products, ranking, phase, previous });
  const { out, usage, model } = await askClaude(digest);
  const seriler = Object.fromEntries(products.map((p) => [p.id, { ad: p.ad, q: p.q, seri: p.seri }]));
  const issue = mergeIssue(prev, toArticles(out, { now, seriler }));
  const fiyatlar = Object.fromEntries(products.map((p) => [p.id, [p.ad, p.dun, p.q]]));
  const doc = { v: VERSION, t: now, model, ...issue, fiyatlar };
  return { doc, usage };
}

export async function main() {
  const now = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret eksik (GitHub > Settings > Secrets).');
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const base = await db.getMany([PATHS.meta('tradable'), 'system/phase']);
  const shared = { tradable: parseJSON(base.get(PATHS.meta('tradable'))?.data) || {}, phase: base.get('system/phase') || {} };
  const writes = [];
  const lines = [];
  for (const r of CONFIG.realms) {
    try {
      const { doc, usage } = await realmIssue(db, r, now, shared);
      writes.push({ type: 'set', path: PATHS.meta(`news_r${r}`), data: { data: JSON.stringify(doc), u: now } });
      lines.push(`r${r}: manşet "${doc.manset.tr.baslik}", ${doc.haberler.length} haber, giriş=${usage?.input_tokens} çıkış=${usage?.output_tokens}`);
    } catch (e) {
      lines.push(`r${r}: HATA ${e?.message || e}`);
    }
  }
  if (writes.length) await db.commit(writes);
  console.log(`DentSimco haber | ${lines.join(' | ')} | ${((Date.now() - now) / 1000).toFixed(0)} sn`);
  if (!writes.length) throw new Error('Hiçbir realm için haber yazılamadı.');
}

runIfMain(import.meta.url, main);
