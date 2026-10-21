// DentSimco — şirket binaları botu sınaması. Çalıştırma: node bot/sirket_bina_test.mjs (ağa çıkılmaz)
import { kayit, siradakiler, ozet, toplamSeviye, budayEski, sonrakiDurum, etkinRealmlar, parcaYolu, PARCA, GAP_MS } from './sirket_bina.mjs';
import { binaSabitleri, bvGuvenilir } from './seviye_coz.mjs';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label || 'eşit değil'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const YANIT = {
  companyPublicInfo: { id: 4479420, company: 'Dentium Citrosuco', deleted: false, level: 25, ratingCode: 'AAA', productionModifier: 9, salesModifier: -3, lastSeen: 'Today', countryCodeIsoUserSet: '' },
  infrastructure: { recreationBonus: 3, workers: 34500, administrationOverhead: 3.02, buildings: [
    { id: 1, kind: '6', size: 15, busy: { category: 'b', started: '2026-10-20T10:52:06.520Z', duration: 345600000 } },
    { id: 2, kind: 'r', size: 15, restaurantProperties: { isLuxury: true } },
    { id: 3, kind: 'y', freeAndLocked: true },
    { id: 4 },
  ] },
  governmentOrderTierIndex: 4,
  history: { value: 232628622, buildingValue: 6058200 },
};

test('hız: istekler arası en az 1 sn (saniyede 1 istek)', () => ok(GAP_MS >= 1000));

test('profil yanıtı kısa kayda çevrilir', () => {
  const k = kayit(YANIT, 5);
  eq([k.n, k.t, k.lv, k.rt, k.w, k.ao, k.rb, k.pm, k.sm, k.go, k.ls, k.cc, k.bv], ['Dentium Citrosuco', 5, 25, 'AAA', 34500, 3.02, 3, 9, -3, 4, 'Today', null, 6058200]);
  eq(k.b, [['6', 15, 'b', Date.parse('2026-10-20T10:52:06.520Z') + 345600000, 0, 0], ['r', 15, null, null, 1, 0], ['y', 1, null, null, 0, 1]]);
  eq(kayit({ companyPublicInfo: { deleted: true } }, 1), null, 'silinmiş şirket');
  eq(kayit({}, 1), null, 'bozuk yanıt');
});

test('sıradakiler: son taranan sıradan sonrası, sıraya göre', () => {
  const rows = [[10, 'a', 3], [11, 'b', 1], [12, 'c', 2], [13, 'd', 5]];
  eq(siradakiler(rows, 2).map((r) => r[0]), [10, 13]);
  eq(siradakiler(rows, 0).map((r) => r[0]), [11, 12, 10, 13]);
});

test('tarama durumu: bitmemiş tarama gün değişse de sürer, biten tarama ertesi gün yenilenir', () => {
  eq(sonrakiDurum(null, '2026-10-21'), { gun: '2026-10-21', r0: 0, r1: 0, b0: false, b1: false, bitti: false });
  eq(sonrakiDurum({ gun: '2026-10-20', r0: 900, r1: 5, bitti: false }, '2026-10-21').r0, 900, 'yarım tarama sürer');
  eq(sonrakiDurum({ gun: '2026-10-21', r0: 900, bitti: true }, '2026-10-21').bitti, true, 'bugünkü bitti');
  eq(sonrakiDurum({ gun: '2026-10-20', r0: 900, bitti: true }, '2026-10-21').r0, 0, 'ertesi gün yeni tarama');
  eq(sonrakiDurum({ gun: '2026-10-21', r0: 900, bitti: true }, '2026-10-21', true).r0, 0, 'zorla');
});

test('realm seçimi: SBINA_REALMLER yalnız o realmları tarar, geçersiz ya da boşsa hepsi', () => {
  eq(etkinRealmlar('0', [0, 1]), [0]);
  eq(etkinRealmlar('1,0,0', [0, 1]), [1, 0]);
  eq(etkinRealmlar('', [0, 1]), [0, 1]);
  eq(etkinRealmlar('7', [0, 1]), [0, 1]);
  eq(etkinRealmlar(undefined, [0, 1]), [0, 1]);
});

test('kesin toplam seviye yönetim giderinden: 1 + (L − 1) ÷ 170', () => {
  eq(toplamSeviye(3.0235294117647058), 345);
  eq(toplamSeviye(1), 1);
  eq(toplamSeviye(1 + 12 / 170), 13);
  eq(toplamSeviye(null), null);
});

test('özet: bina türü başına şirket, bina, toplam ve en yüksek seviye, en büyükler, GO seviyeleri', () => {
  const H = 3600_000;
  const p = [{ c: { 1: { n: 'A', t: 100 * H, go: 4, b: [['6', 15], ['6', 10], ['r', 5]] }, 2: { n: 'B', t: 99 * H, go: 4, b: [['6', 30]] } } }, { c: { 3: { n: 'C', t: 10 * H, go: 2, b: [] } } }];
  const o = ozet(p, 100 * H);
  eq(o.kinds['6'], [2, 3, 55, 30, { 10: 1, 15: 1, 30: 1 }]);
  eq(o.kinds.r, [1, 1, 5, 5, { 5: 1 }]);
  eq(o.top['6'], [[2, 'B', 30, 1, null, null], [1, 'A', 25, 2, null, null]]);
  eq(o.go, { 2: 1, 4: 2 });
  eq([o.sirket, o.gun], [3, 2]);
});

test('özet: tür toplamı yönetim giderinden çözülür; bv yalnız güvenilirse kullanılır', () => {
  const lv = (...l) => l.map((level) => ({ level }));
  const sabit = binaSabitleri({ a: { dbLetter: '6', category: 'production', costUnits: 10, levelImages: lv(1, 2, 3, 6, 10, 15) }, b: { dbLetter: 'r', category: 'sales', costUnits: 3, levelImages: lv(1, 2, 3, 6, 10, 15) } });
  const ao = (L) => 1 + (L - 1) / 170;
  // A: iki fabrika 15+ ve tek mağaza 2 (kesin): L = 50 → fabrikalar toplam 48
  const p = [{ c: { 1: { n: 'A', t: 0, ao: ao(50), b: [['6', 15, null, null, 0, 0], ['6', 15, null, null, 0, 0], ['r', 2, null, null, 0, 0]] } } }];
  const o = ozet(p, 0, sabit);
  eq(o.top['6'], [[1, 'A', 48, 2, 50, 48]]);
  eq(o.kinds['6'][2], 48);
  // Güvenilirlik: iki tarama arasında değişmeyen şirket, arada günlük kayıt alınmış
  const k = p[0].c[1];
  ok(bvGuvenilir({ ...k, bv: 1 }, { ...k, t: 3600_000, bv: 2 }) && !bvGuvenilir({ ...k, bv: 1 }, { ...k, t: 3600_000, bv: 1 }), 'bv güvenilirliği');
});

test('eski kayıtlar budanır; parça yolu', () => {
  const p = [{ c: { 1: { t: 0 }, 2: { t: 9e12 } } }, { c: { 3: { t: 9e12 } } }];
  eq(budayEski(p, 8 * 86400_000), [0]);
  eq(Object.keys(p[0].c), ['2']);
  eq(parcaYolu(1, 4479420), `meta/sb_r1_${String(4479420 % PARCA).padStart(3, '0')}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
console.log(`${results.length - failed.length}/${results.length} test geçti.`);
process.exit(failed.length ? 1 : 0);
