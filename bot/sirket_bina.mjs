// DentSimco Bot — Şirketlerin binaları (Sim Companies herkese açık şirket profili)
// GitHub Actions 2 saatte bir başlatır (.github/workflows/sirket-bina.yml); her çalışma kaldığı yerden sürer. Günde bir tam tarama
// yapılır: tarama bitince o günün sonraki çalışmaları hemen çıkar, ertesi gün yeni tarama başlar (bitmemiş tarama gün değişse de sürer). İki realm (0 ve 1), sıralamadaki (meta/ranking_r{realm}) tüm şirketler, büyükten küçüğe.
//
// Kaynak (GET): /api/v3/companies/{şirketNo}/ → şirketin herkese açık profili: binaları (tür, seviye, meşguliyet), seviye, rating,
// işçi, yönetim gideri, üretim/satış değiştiricisi, GO seviyesi. Şirket başına tek istek.
// Hız: diger.mjs'teki tek kapı; istekler arası 1 sn. Sim Companies bu uç noktada dakikada ~60 isteğin üstünde 429 veriyor
// (ölçüm, 21 Ekim 2026: 550 ms'de 446 istekte 46, 800 ms'de 211'de 11, 1000 ms'de 150'de 0). 429 gelirse 2 sn beklenip yeniden denenir.
// ~35 bin şirket: bir tarama yaklaşık 10 saat sürer (2 saatte bir başlayan 110 dakikalık çalışmalar).
//
// Firestore'a yazılan (dashboard public/sirket-bina.js ve public/diger.js okur; data = JSON):
//   meta/sb_r{realm}_{NNN}   {v, t, c: {şirketNo: kayıt}}       NNN = şirketNo % PARCA (3 hane)
//     kayıt = {n: ad, t: tarama anı, lv: şirket seviyesi, rt: rating, w: işçi, ao: yönetim gideri %, rb: dinlenme bonusu,
//              pm: üretim değiştiricisi, sm: satış değiştiricisi, go: GO seviyesi, ls: son görülme, cc: ülke,
//              b: [[harf, seviye, meşguliyet|null, meşguliyetBitişi|null, lüks(0|1)], ...]}
//     meşguliyet: oyunun kodu (b inşa/genişletme, r üretim, s satış, u bakım, a robot, e restoran yenileme, o restoran açık,
//                 c açık artırmada, n besleme, g yumurta)
//   meta/sb_ozet_r{realm}    {v, t, taranan (son taranan sıra), toplam (sıralamadaki şirket), gunu, sirket, gun (son 36 saatte taranan), kinds: {harf: [şirket, bina, toplamSeviye, enYüksekSeviye, {seviye: adet}]},
//                             top: {harf: [[şirketNo, ad, toplamSeviye, binaSayısı], ... en çok 15]}, go: {seviye: şirket}}
//   botstate/sbina           {gun: taramanın başladığı gün, r0/r1: son taranan sıra, n0/n1: sıralamadaki şirket, bitti}   (yalnız bot okur)

import { CONFIG, PATHS, parseJSON, runIfMain, utcDay } from './common.mjs';
import { Firestore } from './firestore.mjs';
import { createGate } from './diger.mjs';

const VERSION = 1;
export const PARCA = 128;
export const GAP_MS = 1000;          // bu uç noktada 1 sn aralıkta 429 gelmiyor
const BUDGET_MS = 110 * 60_000;      // bir çalışma en çok (iş 2 saatte bir başlar)
const FLUSH_MS = 55 * 60_000;        // toplanan kayıtlar bu aralıkla yazılır (çalışma başına ~2 yazım: Firestore yazma kotası)
const TOP_N = 15;
const MAX_ARDISIK_HATA = 25;         // art arda bu kadar hata: kaynak sorunlu, çalışma durur
const ESKI_MS = 7 * 86400_000;       // bu kadar süredir taranmayan (sıralamadan çıkmış) şirket silinir

export const parcaYolu = (r, id) => PATHS.meta(`sb_r${r}_${String(Number(id) % PARCA).padStart(3, '0')}`);
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// Profil yanıtı → kısa kayıt
export function kayit(json, now) {
  const p = json?.companyPublicInfo;
  if (!p || p.deleted) return null;
  const inf = json.infrastructure || {};
  const b = (inf.buildings || []).map((x) => {
    const bas = Date.parse(x?.busy?.started);
    const sure = num(x?.busy?.duration);
    return [String(x?.kind ?? ''), num(x?.size) ?? 1, x?.busy?.category ?? null, Number.isFinite(bas) && sure != null ? bas + sure : null, x?.restaurantProperties?.isLuxury ? 1 : 0];
  }).filter((x) => x[0]);
  return {
    n: String(p.company ?? ''), t: now, lv: num(p.level), rt: p.ratingCode ?? null, w: num(inf.workers), ao: num(inf.administrationOverhead),
    rb: num(inf.recreationBonus), pm: num(p.productionModifier), sm: num(p.salesModifier), go: num(json.governmentOrderTierIndex),
    ls: p.lastSeen ?? null, cc: p.countryCodeIsoUserSet || null, b,
  };
}

// Sıralama satırlarından (sıraya göre) taranacak şirketler: sondan taranan sıradan sonrakiler
export function siradakiler(rows, sonSira) {
  return rows.filter((r) => r[2] > (sonSira || 0)).sort((a, b) => a[2] - b[2]);
}

// Tüm parçalardan özet
export function ozet(parcalar, now) {
  const kinds = {};
  const top = {};
  const go = {};
  let sirket = 0;
  let gun = 0;
  for (const p of parcalar) {
    for (const [id, k] of Object.entries(p?.c || {})) {
      sirket++;
      if (k.t > now - 36 * 3600_000) gun++;
      if (k.go != null) go[k.go] = (go[k.go] || 0) + 1;
      const sirketTur = {};
      for (const [harf, sv] of k.b || []) {
        const s = (sirketTur[harf] ||= [0, 0]);
        s[0] += sv; s[1]++;
        const x = (kinds[harf] ||= [0, 0, 0, 0, {}]);
        x[1]++; x[2] += sv; x[3] = Math.max(x[3], sv); x[4][sv] = (x[4][sv] || 0) + 1;
      }
      for (const [harf, [toplam, adet]] of Object.entries(sirketTur)) {
        kinds[harf][0]++;
        (top[harf] ||= []).push([Number(id), k.n, toplam, adet]);
      }
    }
  }
  for (const harf of Object.keys(top)) top[harf] = top[harf].sort((a, b) => b[2] - a[2] || b[3] - a[3] || a[0] - b[0]).slice(0, TOP_N);
  return { v: VERSION, t: now, sirket, gun, kinds, top, go };
}

// Tarama durumu: bitmemiş tarama (gün değişse de) kaldığı yerden sürer; biten taramadan sonra yenisi ertesi gün başlar.
export function sonrakiDurum(state, bugun, zorla = false) {
  if (!state?.gun || (state.bitti && (state.gun !== bugun || zorla))) return { gun: bugun, r0: 0, r1: 0, bitti: false };
  return { ...state };
}

// ESKI_MS'ten uzun süredir taranmayan kayıtları siler; değişen parçaların sırası döner
export function budayEski(parcalar, now) {
  const degisen = [];
  parcalar.forEach((p, i) => {
    for (const [id, k] of Object.entries(p.c || {})) if (!(k?.t > now - ESKI_MS)) { delete p.c[id]; if (!degisen.includes(i)) degisen.push(i); }
  });
  return degisen;
}

async function rankingRows(db, r) {
  const idx = parseJSON((await db.getMany([PATHS.meta(`ranking_r${r}`)])).get(PATHS.meta(`ranking_r${r}`))?.data);
  if (!idx?.chunks) return [];
  const paths = Array.from({ length: idx.chunks }, (_, i) => PATHS.meta(`ranking_r${r}_c${String(i).padStart(2, '0')}`));
  const docs = await db.getMany(paths);
  return paths.flatMap((p) => parseJSON(docs.get(p)?.data) || []);
}

export async function main() {
  const t0 = Date.now();
  const bugun = utcDay(t0);
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const statePath = PATHS.botState('sbina');
  let state = parseJSON((await db.getMany([statePath])).get(statePath)?.data) || {};
  state = sonrakiDurum(state, bugun, process.env.SBINA_ZORLA === '1');
  if (state.bitti) { console.log(`DentSimco şirket binaları | ${bugun} taraması zaten bitti`); return; }

  const gate = createGate({ deadline: t0 + BUDGET_MS, gapMs: GAP_MS });
  const sira = {};
  for (const r of CONFIG.realms) {
    const rows = await rankingRows(db, r);
    state[`n${r}`] = rows.length;
    sira[r] = siradakiler(rows, state[`r${r}`]);
  }
  const bekleyen = new Map(CONFIG.realms.map((r) => [r, new Map()])); // realm → (şirketNo → kayıt | null = silinmiş)
  let sonYazma = Date.now();
  let taranan = 0;
  let hata = 0;
  let ardisik = 0;

  async function yaz(sonMu) {
    const writes = [];
    for (const r of CONFIG.realms) {
      const m = bekleyen.get(r);
      const tumYollar = Array.from({ length: PARCA }, (_, i) => parcaYolu(r, i));
      const docs = await db.getMany(tumYollar);
      const parcalar = tumYollar.map((p) => parseJSON(docs.get(p)?.data) || { v: VERSION, c: {} });
      const degisen = new Set();
      for (const [id, k] of m) {
        const i = Number(id) % PARCA;
        if (k) parcalar[i].c[id] = k; else delete parcalar[i].c[id];
        degisen.add(i);
      }
      if (sonMu) budayEski(parcalar, Date.now()).forEach((i) => degisen.add(i));
      for (const i of degisen) writes.push({ type: 'set', path: tumYollar[i], data: { data: JSON.stringify({ ...parcalar[i], v: VERSION, t: Date.now() }), u: t0 } });
      if (degisen.size || sonMu) writes.push({ type: 'set', path: PATHS.meta(`sb_ozet_r${r}`), data: { data: JSON.stringify({ ...ozet(parcalar, Date.now()), taranan: state[`r${r}`], toplam: state[`n${r}`] ?? null, gunu: state.gun }), u: t0 } });
      m.clear();
    }
    writes.push({ type: 'set', path: statePath, data: { data: JSON.stringify(state), u: t0 } });
    await db.commit(writes);
    sonYazma = Date.now();
  }

  // Realmlar dönüşümlü taranır (ikisi birlikte ilerler); her realmda büyük şirketler önce
  const kuyruk = [];
  for (let i = 0; i < Math.max(...CONFIG.realms.map((r) => sira[r].length)); i++) for (const r of CONFIG.realms) if (sira[r][i]) kuyruk.push([r, sira[r][i]]);
  let durdu = null;
  for (const [r, row] of kuyruk) {
    try {
      const json = await gate.get(`${CONFIG.simcoBase}/api/v3/companies/${row[0]}/`);
      bekleyen.get(r).set(row[0], kayit(json, Date.now()));
      ardisik = 0;
    } catch (e) {
      if (e?.deadline) { durdu = 'süre'; break; }
      if (/HTTP 404/.test(e.message)) bekleyen.get(r).set(row[0], null);
      else { hata++; if (++ardisik >= MAX_ARDISIK_HATA) { durdu = `art arda ${ardisik} hata: ${e.message}`; break; } }
    }
    taranan++;
    state[`r${r}`] = Math.max(state[`r${r}`] || 0, row[2]);
    if (Date.now() - sonYazma >= FLUSH_MS) await yaz(false);
  }
  if (!durdu) state.bitti = true;
  await yaz(true);
  console.log(`DentSimco şirket binaları | ${bugun} | ${taranan} şirket tarandı, ${hata} hata | istek=${gate.stat.req} 429=${gate.stat.n429} | ${state.bitti ? 'günün taraması bitti' : `devam edecek (${durdu})`} | ${((Date.now() - t0) / 60000).toFixed(1)} dk`);
  if (durdu && durdu !== 'süre') throw new Error(durdu);
}

runIfMain(import.meta.url, main);
