// DentSimco Bot — Anlık borsa (Sim Companies oyun API'si)
// GET /api/v3/market/all/{realm}/{ürünId}/ → ürünün TÜM açık satış ilanları (fiyata göre artan).
// İlan: { id, kind, quantity, quality, price (adet başına), posted, datetimeDecayUpdated, seller, fees }
//
// Buradan iki değer çıkar (SimcoTools'un vermediği ikisi):
//   ask    = kalitesi ≥ q olan ilanların en ucuzu. Oyunun borsa ekranındaki "borsa fiyatı" budur (Q0 = tüm ilanlar).
//   supply = tam q kalitesindeki ilanların toplam adedi (satış arzı).
// Son işlem fiyatı, mumlar ve VWAP SimcoTools'tan gelmeye devam eder; kapanış her zaman son işlem fiyatıdır.

export const MAX_QUALITY = 12;

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

/** Yanıttan ilan listesi: dizi olabilir ya da bir alanda dizi olarak gelebilir. İlan başına { q, price, qty } döner. */
export function parseOrders(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.orders) ? json.orders : Array.isArray(json?.marketOrders) ? json.marketOrders : null;
  if (!list) throw new Error('beklenmeyen ilan yanıtı');
  const out = [];
  for (const o of list) {
    const q = num(o?.quality);
    const price = num(o?.price);
    const qty = num(o?.quantity);
    if (!Number.isInteger(q) || q < 0 || q > MAX_QUALITY || !(price > 0) || !(qty > 0)) continue;
    out.push({ q, price, qty });
  }
  return out;
}

/**
 * İlanlardan kalite başına { ask, supply }. İlan olmayan ve altında da ilan bulunmayan kalite yer almaz
 * (arz 0, anlık fiyat yok demektir).
 */
export function summarizeOrders(orders) {
  const supply = new Array(MAX_QUALITY + 1).fill(0);
  const cheapest = new Array(MAX_QUALITY + 1).fill(null); // tam bu kalitedeki en ucuz ilan
  for (const o of orders) {
    supply[o.q] += o.qty;
    if (cheapest[o.q] === null || o.price < cheapest[o.q]) cheapest[o.q] = o.price;
  }
  const out = {};
  let ask = null; // kalitesi ≥ q olanların en ucuzu: yüksek kaliteden aşağı doğru birikir
  for (let q = MAX_QUALITY; q >= 0; q--) {
    if (cheapest[q] !== null && (ask === null || cheapest[q] < ask)) ask = cheapest[q];
    if (ask !== null || supply[q] > 0) out[q] = { ask, supply: Math.round(supply[q]) };
  }
  return out;
}

// ---- Firestore kayıtlarına işleme ------------------------------------------------------------------------------

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Canlı kalite satırlarına anlık borsa verisini işler: {q: [son işlem fiyatı, arz, satış, tutar, son işlem zamanı, ask]}
 *  liveQ = SimcoTools'tan hesaplanan satırlar ({q: [fiyat, null, satış, tutar, sonİşlem]}); SimcoTools çekilemediyse önceki satırlar
 *  prevQ = önceki canlı kayıttaki satırlar
 *  ex    = summarizeOrders çıktısı; null ise bu turda ilanlar çekilemedi: önceki arz ve ask korunur (askT eskir)
 */
export function mergeLive(liveQ, prevQ, ex) {
  const out = {};
  const qs = new Set(Object.keys(liveQ || {}));
  if (ex) for (const q of Object.keys(ex)) qs.add(q);
  else for (const [q, v] of Object.entries(prevQ || {})) if (v?.[5] != null || v?.[1] != null) qs.add(q);
  for (const q of qs) {
    const row = liveQ?.[q] ? [...liveQ[q]] : [null, null, 0, 0, null];
    while (row.length < 5) row.push(null);
    if (ex) {
      row[1] = ex[q] ? ex[q].supply : 0;
      row[5] = ex[q]?.ask ?? null;
    } else {
      row[1] = prevQ?.[q]?.[1] ?? row[1] ?? null;
      row[5] = prevQ?.[q]?.[5] ?? null;
    }
    out[q] = row;
  }
  return out;
}

/** Gün içi nokta: [son işlem fiyatı, arz, biriken satış, biriken tutar, ask]. Anlık veri yoksa arz ve ask boş (null) yazılır. */
export function mergeIntraday(intraday, mergedLive, hasExchange) {
  const out = {};
  for (const [q, row] of Object.entries(mergedLive)) {
    const i = intraday?.[q] || [row[0], null, 0, 0];
    out[q] = [i[0] ?? null, hasExchange ? row[1] : null, i[2] ?? 0, i[3] ?? 0, hasExchange ? row[5] : null];
  }
  return out;
}

// Günlük ortalama arz için kalite durumuna eklenen alanlar (botstate: [mumDk, mumTahmini, accS, accV, ...]):
//   [4] örneklerin günü, [5] arz toplamı, [6] örnek sayısı, [7] önceki günün tarihi, [8] önceki günün ortalama arzı

/** Bir kalite durumuna bugünkü arz örneğini ekler; gün değişmişse dünün ortalamasını [7],[8]'e taşır. */
export function addSupplySample(stateQ, day, supply) {
  const s = [...(stateQ || [null, 0, 0, 0])];
  while (s.length < 9) s.push(null);
  if (s[4] && s[4] !== day) {
    if (s[6] > 0) { s[7] = s[4]; s[8] = round(s[5] / s[6]); }
    s[4] = null;
  }
  if (s[4] !== day) { s[4] = day; s[5] = 0; s[6] = 0; }
  s[5] += supply;
  s[6] += 1;
  return s;
}

/** Bu turun arz örneğini ürünün tüm kalitelerine işler. Daha önce arz izlenen ama bu turda ilanı olmayan kalite 0 sayılır. */
export function addSupplySamples(stateById, ex, day) {
  const out = { ...stateById };
  const qs = new Set(Object.keys(ex));
  for (const [q, v] of Object.entries(stateById || {})) if (v?.[4] || v?.[7]) qs.add(q);
  for (const q of qs) out[q] = addSupplySample(stateById?.[q], day, ex[q]?.supply ?? 0);
  return out;
}

/** Belirli bir günün ortalama arzı (yoksa null) */
export function averageSupply(stateQ, day) {
  if (stateQ?.[7] === day && stateQ[8] != null) return stateQ[8];
  if (stateQ?.[4] === day && stateQ[6] > 0) return round(stateQ[5] / stateQ[6]);
  return null;
}
