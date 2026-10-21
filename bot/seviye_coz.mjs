// DentSimco — Şirket binalarının gerçek seviyesini çözme (bina türü başına). Bu dosya DentSimco-Dashboard/public/seviye-coz.js ile BİREBİR aynıdır.
//
// Oyunun herkese açık profili her binanın seviyesini görsel kademenin alt sınırıyla verir (1, 2, 3, 6, 10, 15; akademide 1, 5, 10, 15, 20):
// kademe 3 olan bina 3-5, 15 olan 15 ya da daha yüksektir. Gerçek seviyeyi daraltan iki denklem vardır:
//   1) Toplam seviye L (yönetim gideri, ANLIK): L = round((ao − 1) × 170 + 1) = Σ seviye. Banka, dinlenme binaları ve oyunun ücretsiz
//      verdiği kilitli bina girmez; akademi ve satın alınmış mevsimlik pazarlar girer.
//   2) Bina değeri bv (profil geçmişi, GÜNLÜK kayıt): bv = 3450 × Σ costUnits × seviye. Banka, dinlenme ve akademi girer; ücretsiz bina girmez.
//      Günde bir kez alınır: şirket o andan sonra bina kurduysa ya da yükselttiyse anlık durumu tutmaz. Bu yüzden yalnız bot onu
//      "güvenilir" işaretlediyse (kayıtta bg = 1: iki tarama arasında şirket değişmemiş ve arada bir günlük kayıt alınmış) kullanılır.
// Aynı türdeki binalar denklemlerde ayırt edilemez: çözüm tür başına toplam seviyedir ([en az, en çok]; ikisi eşitse kesin). İki denklem en
// çok iki belirsiz türü kesinleştirebilir; daha çok belirsiz türde aralıklar daralır ama genelde kesinleşmez.
// Yöntem: tür toplamları üzerinde sınır yayılımı (denklemler ve bunların c − λ·a doğrusal birleşimleri). Tamsayı çözümün varlığını
// garanti etmez ama verilen aralıkların dışında çözüm olmadığını garanti eder.

export const ADMIN_BIRIM = 170;
export const BV_BIRIM = 3450; // 0,5 × 6900
export const toplamSeviye = (ao) => (Number.isFinite(ao) ? Math.round((ao - 1) * ADMIN_BIRIM + 1) : null);
// Oyunun bilinen seviye üst sınırları (akademi 20, banka 40, dinlenme binaları 3, fırlatma rampası 10)
export const MAX_SEVIYE = { y: 20, n: 40, 3: 3, 4: 3, 5: 3, l: 10 };
export const YONETIMDE_YOK = { harfler: new Set(['n']), kategoriler: new Set(['recreation']) };

// meta/buildings (oyunun bina sabitleri) → { harf: { esik: [kademe eşikleri], kat, c: costUnits } }
export function binaSabitleri(sabit) {
  const out = {};
  for (const b of Object.values(sabit || {})) {
    if (b?.dbLetter == null) continue;
    out[b.dbLetter] = {
      esik: (b.levelImages || []).map((x) => Number(x?.level)).filter(Number.isFinite).sort((a, c) => a - c),
      kat: b.category || null,
      c: Number.isFinite(Number(b.costUnits)) ? Number(b.costUnits) : null,
    };
  }
  return out;
}

// Ücretsiz (oyunun hediye ettiği kilitli) binaların sırası. Bayraksız eski kayıtta: şu an herkese verilen Halloween pazarı (t), ilk t.
export function ucretsizler(liste) {
  if (liste.length && liste.every((x) => x.length > 5)) return new Set(liste.map((x, i) => (x[5] ? i : -1)).filter((i) => i >= 0));
  const j = liste.findIndex((x) => x[0] === 't');
  return new Set(j >= 0 ? [j] : []);
}

// Bir binanın profildeki kademesinden olası seviye aralığı [alt, üst] (üst sonsuz olabilir)
export function binaAraligi(harf, sv, m) {
  if (m.kat === 'seasonal') return [1, Infinity]; // mevsimlik pazarın boyutu bilgi taşımaz
  if (!m.esik.length) return [sv, sv]; // kademesiz bina: profildeki değer gerçek seviyedir
  const sinir = MAX_SEVIYE[harf] ?? Infinity;
  const sonraki = m.esik.find((e) => e > sv);
  return [sv, Math.min(sonraki == null ? Infinity : sonraki - 1, sinir)];
}

// Σ d·x aralığı (x ∈ [alt, üst]); sonsuz katkılar ayrıca sayılır ki tek bir değişken çıkarılınca kalan aralık hesaplanabilsin
function toplamAraligi(d, vs) {
  let mn = 0; let mx = 0; let mnInf = 0; let mxInf = 0;
  vs.forEach((v, j) => {
    if (!d[j]) return;
    const a = d[j] > 0 ? d[j] * v.alt : d[j] * v.ust; // en küçük katkı
    const b = d[j] > 0 ? d[j] * v.ust : d[j] * v.alt; // en büyük katkı
    if (a === -Infinity) mnInf++; else mn += a;
    if (b === Infinity) mxInf++; else mx += b;
  });
  return { mn, mx, mnInf, mxInf };
}

// Sınır yayılımı: her denklemde her değişkenin aralığı, diğerlerinin aralığına göre daraltılır. Çelişki varsa false.
function yay(vs, denklemler) {
  for (let tur = 0; tur < 100; tur++) {
    let degisti = false;
    for (const [d, R] of denklemler) {
      const t = toplamAraligi(d, vs);
      if ((!t.mnInf && t.mn > R) || (!t.mxInf && t.mx < R)) return false;
      for (let i = 0; i < vs.length; i++) {
        if (!d[i]) continue;
        const v = vs[i];
        const kMin = d[i] > 0 ? d[i] * v.alt : d[i] * v.ust;
        const kMax = d[i] > 0 ? d[i] * v.ust : d[i] * v.alt;
        // diğerlerinin toplamı [oMin, oMax]
        const oMin = kMin === -Infinity ? (t.mnInf > 1 ? -Infinity : t.mn) : t.mnInf ? -Infinity : t.mn - kMin;
        const oMax = kMax === Infinity ? (t.mxInf > 1 ? Infinity : t.mx) : t.mxInf ? Infinity : t.mx - kMax;
        // d[i]·x = R − diğerleri
        let lo = d[i] > 0 ? (R - oMax) / d[i] : (R - oMin) / d[i];
        let hi = d[i] > 0 ? (R - oMin) / d[i] : (R - oMax) / d[i];
        lo = Number.isFinite(lo) ? Math.ceil(lo - 1e-9) : lo;
        hi = Number.isFinite(hi) ? Math.floor(hi + 1e-9) : hi;
        if (lo > v.alt) { v.alt = lo; degisti = true; }
        if (hi < v.ust) { v.ust = hi; degisti = true; }
        if (v.alt > v.ust) return false;
      }
    }
    if (!degisti) return true;
  }
  return true;
}

// Şirket kaydı → { L, bvKullanildi, bvCelisti, celiski, turler: { harf: { adet, alt, ust } }, binalar: [{ i, harf, alt, ust }] } ya da null.
// turler/binalar ücretsiz binaları içermez. ust = Infinity: üst sınır yok. celiski: kayıt modelle uyuşmuyor (aralıklar yalnız kademeden).
// Seçenek bvKullan: bina değerini kullan (varsayılan: bot güvenilir işaretlediyse).
export function seviyeCoz(k, sabit, { bvKullan = k?.bg === 1, ucretsizSay = true } = {}) {
  const L0 = toplamSeviye(k?.ao);
  if (L0 == null || !sabit) return null;
  const liste = k.b || [];
  const bayrakli = !liste.length || liste.every((x) => x.length > 5);
  const ucretsiz = ucretsizSay ? ucretsizler(liste) : new Set();
  const binalar = [];
  const turMap = new Map();
  for (let i = 0; i < liste.length; i++) {
    if (ucretsiz.has(i)) continue;
    const [harf, sv] = liste[i];
    const m = sabit[harf];
    if (!m) return null; // bilinmeyen bina türü: çözülemez
    const [alt, ust] = binaAraligi(harf, sv, m);
    const a = YONETIMDE_YOK.harfler.has(harf) || YONETIMDE_YOK.kategoriler.has(m.kat) ? 0 : 1;
    binalar.push({ i, harf, alt, ust, a0: alt, u0: ust });
    const t = turMap.get(harf) || { harf, a, c: m.c, alt: 0, ust: 0, adet: 0 };
    t.alt += alt; t.ust += ust; t.adet++;
    turMap.set(harf, t);
  }
  const turler = [...turMap.values()];
  // ao = 1: L 1 ya da 0 olabilir (formül alttan 1'e yaslanır); yönetime giren bina yoksa 0
  const L = L0 <= 1 && !turler.some((t) => t.a) ? 0 : L0;
  const temel = [[turler.map((t) => t.a), L]];
  const yedek = turler.map((t) => ({ alt: t.alt, ust: t.ust }));
  let bvKullanildi = false; let bvCelisti = false; let celiski = false;
  const V = k.bv != null && Number.isInteger(k.bv / BV_BIRIM) ? k.bv / BV_BIRIM : null;
  if (bvKullan && V != null && turler.every((t) => Number.isFinite(t.c))) {
    const denk = [...temel, [turler.map((t) => t.c), V]];
    for (const lam of [...new Set(turler.map((t) => t.c))]) denk.push([turler.map((t) => t.c - lam * t.a), V - lam * L]);
    if (yay(turler, denk)) bvKullanildi = true;
    else { bvCelisti = true; turler.forEach((t, j) => Object.assign(t, yedek[j])); }
  }
  if (!bvKullanildi && !yay(turler, temel)) {
    // Bayraksız eski kayıtta ücretsiz sanılan Halloween pazarı satın alınmış olabilir: öyle sayıp yeniden dene
    if (!bayrakli && ucretsiz.size) return seviyeCoz(k, sabit, { bvKullan, ucretsizSay: false });
    celiski = true; turler.forEach((t, j) => Object.assign(t, yedek[j]));
  }
  // Bina başına: tür toplamının aralığı, türdeki diğer binaların aralığıyla
  for (const b of binalar) {
    const t = turMap.get(b.harf);
    const digerAlt = t.adet === 1 ? 0 : binalar.filter((x) => x.harf === b.harf && x !== b).reduce((s, x) => s + x.a0, 0);
    const digerUst = t.adet === 1 ? 0 : binalar.filter((x) => x.harf === b.harf && x !== b).reduce((s, x) => s + x.u0, 0);
    b.alt = Math.max(b.a0, t.alt - digerUst);
    b.ust = Math.min(b.u0, t.ust - digerAlt);
  }
  return {
    L, bvKullanildi, bvCelisti, celiski,
    turler: Object.fromEntries(turler.map((t) => [t.harf, { adet: t.adet, alt: t.alt, ust: t.ust }])),
    binalar: binalar.map(({ i, harf, alt, ust }) => ({ i, harf, alt, ust })),
  };
}

// Bot: bina değeri (bv) bu taramada anlık durumu tutuyor mu? Önceki tarama (o) ile bu tarama (k) arasında toplam seviye ve binalar
// (tür + kademe) değişmemişse ve arada oyunun günlük kaydı alınmışsa (bv değişmiş ya da en az 24 saat geçmiş) bv, şu anki binaların değeridir.
export function bvGuvenilir(o, k) {
  if (!o || k?.bv == null || o.bv == null || toplamSeviye(o.ao) !== toplamSeviye(k.ao)) return false;
  const imza = (x) => (x.b || []).map((b) => `${b[0]}:${b[1]}:${b[5] ? 1 : 0}`).sort().join(',');
  if (imza(o) !== imza(k)) return false;
  return o.bv !== k.bv || k.t - o.t >= 24 * 3600_000;
}
