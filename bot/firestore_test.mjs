// DentSimco — Firestore bağlantısı güvenlik sınaması. Çalıştırma: node bot/firestore_test.mjs
// Servis hesabı JSON'undaki token_uri ne olursa olsun, imzalı JWT yalnız Google'ın adresine gitmeli.
// Ağa çıkılmaz: fetch yerine sahte bir işlev konur; imza için sınamada üretilen geçici bir RSA anahtarı kullanılır.

import crypto from 'node:crypto';
import { Firestore } from './firestore.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
}
const ok = (v, label = 'koşul sağlanmadı') => { if (!v) throw new Error(label); };

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const hesap = (extra = {}) => ({ client_email: 'bot@ornek.iam.gserviceaccount.com', private_key: pem, project_id: 'ornek', ...extra });

async function istekler(sa) {
  const gercek = globalThis.fetch;
  const adresler = [];
  globalThis.fetch = async (url) => {
    adresler.push(String(url));
    return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }), { status: 200 });
  };
  try { await new Firestore(sa).getToken(); } finally { globalThis.fetch = gercek; }
  return adresler;
}

await test('token_uri yoksa JWT Google adresine gider', async () => {
  const a = await istekler(hesap());
  ok(a.length === 1 && a[0] === 'https://oauth2.googleapis.com/token', `beklenmeyen adres: ${a}`);
});

await test('secret içindeki token_uri yok sayılır (JWT başka sunucuya gitmez)', async () => {
  const a = await istekler(hesap({ token_uri: 'https://kotu.example/token' }));
  ok(a.length === 1 && a[0] === 'https://oauth2.googleapis.com/token', `JWT şuraya gitti: ${a}`);
});

await test('eksik ya da bozuk secret anlaşılır hata verir', async () => {
  let msg = '';
  try { new Firestore('{bozuk'); } catch (e) { msg = e.message; }
  ok(/secret eksik veya bozuk/.test(msg), `hata metni: ${msg}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
console.log(`${results.length - failed.length}/${results.length} test geçti.`);
process.exit(failed.length ? 1 : 0);
