// DentSimco Bot v2 — Firestore bağlantısı
// npm paketi kullanmaz; GitHub'da kurulum adımı olmadığı için her çalışma saniyeler kazanır.
// Güvenlik: yalnız Firestore yetkisi istenir (datastore). Servis hesabının Google Cloud'daki rolü de
// yalnız "Cloud Datastore User" olmalı; site yayını için AYRI bir hesap kullanılır.

import crypto from 'node:crypto';
import { sleep } from './common.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/datastore';
const MAX_WRITES_PER_COMMIT = 400;
const MAX_BYTES_PER_COMMIT = 4_000_000;

export class Firestore {
  constructor(serviceAccountJson) {
    let sa = serviceAccountJson;
    if (typeof sa === 'string') {
      try { sa = JSON.parse(sa); } catch { sa = null; }
    }
    if (!sa?.client_email || !sa?.private_key || !sa?.project_id) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON secret eksik veya bozuk (GitHub > Settings > Secrets).');
    }
    this.sa = { ...sa, private_key: sa.private_key.replace(/\\n/g, '\n') };
    this.root = `projects/${sa.project_id}/databases/(default)/documents`;
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const tokenUrl = this.sa.token_uri || TOKEN_URL;
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: this.sa.client_email, scope: SCOPES, aud: tokenUrl, iat: now, exp: now + 3600,
    })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key).toString('base64url');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Google girişi başarısız (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
    return this.token;
  }

  async call(action, body, attempt = 0) {
    const token = await this.getToken();
    let res;
    try {
      res = await fetch(`https://firestore.googleapis.com/v1/${this.root}:${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < 2) { await sleep(800 * (attempt + 1)); return this.call(action, body, attempt + 1); }
      throw error;
    }
    const text = await res.text();
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(800 * (attempt + 1));
        return this.call(action, body, attempt + 1);
      }
      if (res.status === 403) {
        throw new Error('Firestore izin vermedi (403). Bu depodaki FIREBASE_SERVICE_ACCOUNT_JSON hesabına Google Cloud > IAM\'de '
          + '"Cloud Datastore User" rolü verilmiş olmalı.');
      }
      throw new Error(`Firestore ${action} ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  // Birden çok belgeyi tek istekte okur. Sonuç: Map(yol -> alanlar | null)
  async getMany(paths) {
    const out = new Map();
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const response = await this.call('batchGet', { documents: chunk.map((p) => `${this.root}/${p}`) });
      for (const item of Array.isArray(response) ? response : []) {
        if (item.found) out.set(this.pathOf(item.found.name), decodeFields(item.found.fields || {}));
        else if (item.missing) out.set(this.pathOf(item.missing), null);
      }
    }
    return out;
  }

  pathOf(name) {
    return name.slice(this.root.length + 1);
  }

  // writes: {type:'set'|'merge'|'delete', path, data}
  //   set   = belgeyi baştan yazar
  //   merge = sadece verilen alanları ekler/değiştirir (belgeyi okumadan)
  async commit(writes) {
    let chunk = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      await this.call('commit', { writes: chunk });
      chunk = [];
      bytes = 0;
    };
    for (const w of writes) {
      const rest = this.toRest(w);
      const size = JSON.stringify(rest).length;
      if (chunk.length && (chunk.length >= MAX_WRITES_PER_COMMIT || bytes + size > MAX_BYTES_PER_COMMIT)) await flush();
      chunk.push(rest);
      bytes += size;
    }
    await flush();
  }

  toRest(w) {
    const name = `${this.root}/${w.path}`;
    if (w.type === 'delete') return { delete: name };
    const write = { update: { name, fields: encodeFields(w.data) } };
    if (w.type === 'merge') write.updateMask = { fieldPaths: Object.keys(w.data).map(fieldPath) };
    return write;
  }
}

function fieldPath(key) {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(key) ? key : `\`${key.replace(/[`\\]/g, (m) => `\\${m}`)}\``;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return Number.isFinite(v) ? { doubleValue: v } : { nullValue: null };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { nullValue: null };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = encodeValue(v);
  return fields;
}

function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}
