// DentSimco Bot v2 — Sabit veri toplayıcı
// Haftada bir (ve istenince elle) çalışır: .github/workflows/sabit-veri.yml
// Ürün listesi, tarifler, üretim hızı (producedAnHour), maaş, binalar, çekirdek sabitler.

import { CONFIG, PATHS, fetchJson, runPool, sleep, runIfMain } from './common.mjs';
import { Firestore } from './firestore.mjs';

const toIds = (list) => (Array.isArray(list)
  ? list.map((x) => Number(x && typeof x === 'object' ? x.db_letter ?? x.dbLetter ?? x.id : x)).filter(Number.isFinite)
  : []);

// Ansiklopedi (e) + constants/resources (c) → sade ürün kaydı
export function compactProduct(id, e, c = {}) {
  e = e || {};
  const inputs = Array.isArray(e.producedFrom)
    ? e.producedFrom
      .map((x) => [Number(x?.resource?.db_letter ?? x?.resource?.dbLetter), Number(x?.amount)])
      .filter(([rid, amount]) => Number.isFinite(rid) && Number.isFinite(amount))
    : Object.entries(c.producedFrom || {}).map(([rid, amount]) => [Number(rid), Number(amount)]);
  const improves = toIds(e.improvesQualityOf);
  return {
    id,
    name: e.name ?? null,
    image: e.image ?? c.image ?? null,
    building: e.producedAt ?? c.producedAt ?? null,
    inputs,
    perHour: e.producedAnHour ?? null,
    perHourRaw: c.producedPerHourRaw ?? null,
    baseSalary: e.baseSalary ?? null,
    transport: e.transportation ?? c.transportation ?? null,
    transportNeeded: e.transportNeeded ?? null,
    retailable: e.retailable ?? null,
    research: e.research ?? c.isResearch ?? false,
    exchangeTradable: e.exchangeTradable ?? c.isExchangeTradable ?? false,
    realmAvailable: e.realmAvailable ?? null,
    neededFor: toIds(e.neededFor),
    improves: improves.length ? improves : toIds(c.improvesQualityOf),
    soldAt: e.soldAt ?? null,
    soldAtRestaurant: e.soldAtRestaurant ?? null,
    storeBaseSalary: e.storeBaseSalary ?? null,
    avgRetailPrice: e.averageRetailPrice ?? null,
    marketSaturation: e.marketSaturation ?? null,
    retailData: Array.isArray(e.retailData) && e.retailData.length ? e.retailData : undefined,
    sincePhase: c.sincePhase ?? null,
    economyModel: c.hasEconomyModel ?? null,
    consumption: c.consumption ?? null,
    unitsSoldAnHour: c.unitsSoldAnHour ?? null,
    productionSeason: c.productionSeason ?? null,
    retailSeason: c.retailSeason ?? e.retailSeason ?? null,
    decay: c.decay ?? 0,
    mechanic: c.productionMechanic ?? undefined,
    ok: Boolean(e.name),
  };
}

function fitText(obj, limit = 950_000) {
  let text = JSON.stringify(obj);
  if (text.length > limit && obj && typeof obj === 'object') {
    for (const item of Object.values(obj)) if (item && typeof item === 'object') delete item.retailData;
    text = JSON.stringify(obj);
  }
  if (text.length > limit) throw new Error(`belge çok büyük (${text.length} karakter)`);
  return text;
}

export async function main() {
  const t0 = Date.now();
  const db = new Firestore(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const B = CONFIG.simcoBase;
  const { lang, phase } = CONFIG.encyclopedia;
  const errors = [];
  const writes = [];
  const setDoc = (name, text) => writes.push({ type: 'set', path: PATHS.meta(name), data: { data: text, u: t0 } });

  // 1) Ürün numaraları (tek istek)
  const resources = await fetchJson(`${B}/api/v2/constants/resources/`);
  const byId = {};
  for (const x of Object.values(resources || {})) {
    const id = Number(x?.dbLetter);
    if (Number.isFinite(id)) byId[id] = x;
  }
  const ids = Object.keys(byId).map(Number).sort((a, b) => a - b);
  if (!ids.length) throw new Error('Ürün listesi boş geldi.');

  // 2) Her realm için ansiklopedi
  const tradable = {};
  const counts = {};
  for (const r of CONFIG.realms) {
    const results = await runPool(
      ids,
      (id, control) => fetchJson(`${B}/api/v4/${lang}/${r}/encyclopedia/resources/${phase}/${id}/`, { onThrottle: control.slowDown }),
      CONFIG.constants,
    );
    const table = {};
    ids.forEach((id, i) => {
      const res = results[i];
      if (res?.ok) table[id] = compactProduct(id, res.value, byId[id]);
      else {
        table[id] = compactProduct(id, null, byId[id]);
        if (errors.length < 30) errors.push(`ansiklopedi r${r}/${id}: ${res?.error?.message || 'atlandı'}`);
      }
    });
    tradable[r] = ids.filter((id) => table[id].exchangeTradable && table[id].realmAvailable !== false);
    counts[r] = { products: ids.length, named: ids.filter((id) => table[id].ok).length, tradable: tradable[r].length };
    setDoc(`products_r${r}`, fitText(table));
  }
  setDoc('tradable', JSON.stringify(tradable));

  // 3) Diğer sabitler (olduğu gibi saklanır)
  const raw = [
    ['buildings', `${B}/api/v2/constants/buildings/`],
    ['core', `${B}/api/v2/constants/core/`],
    ...CONFIG.realms.flatMap((r) => [
      [`modifiers_r${r}`, `${B}/api/v2/production-modifiers/${r}/`],
      [`retail_r${r}`, `${B}/api/v4/${r}/resources-retail-info/`],
    ]),
  ];
  for (const [name, url] of raw) {
    try {
      setDoc(name, fitText(await fetchJson(url)));
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
    await sleep(300);
  }

  setDoc('constants_status', JSON.stringify({ t: t0, ms: Date.now() - t0, counts, errors }));
  await db.commit(writes);

  console.log(`DentSimco sabit veri | ${CONFIG.realms.map((r) => `r${r}: ${counts[r].named}/${counts[r].products} ürün, borsada ${counts[r].tradable}`).join(' | ')} | ${((Date.now() - t0) / 1000).toFixed(1)}sn`);
  if (errors.length) console.log(`Uyarılar (${errors.length}):`, errors.slice(0, 8).join(' ; '));
}

runIfMain(import.meta.url, main);
