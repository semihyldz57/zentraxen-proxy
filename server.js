'use strict';
/**
 * Zentraxen AI vekil sunucusu (Render) — v2
 *
 * Uygulama şunu çağırır:  POST /v1/chat/completions   (OpenAI biçimi)
 * Uyandırma için:          GET  /
 *
 * Bu sürüm şunları ekler:
 *  1) X-Zentraxen-Client gizli jeton kontrolü (eskisi gibi)
 *  2) Firebase App Check doğrulaması (istek gerçek Zentraxen uygulamasından mı)
 *  3) Firebase kimlik jetonu doğrulaması (kullanıcı kim)
 *  4) Kullanıcı başına GÜNLÜK limit (sunucuda, Firestore'da sayılır; telefondaki sayaç kandırılamaz)
 *  5) IP başına dakikalık hız sınırı, istek boyutu ve model sınırı
 *
 * REQUIRE_APPCHECK ve REQUIRE_AUTH varsayılan olarak KAPALI (yalnızca kaydeder, reddetmez).
 * Önce kapalı yayınla, loglarda "appcheck=ok auth=ok" gör, sonra "true" yap.
 */
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ---------- Ayarlar (hepsi Render > Environment'tan gelir) ----------
const PORT = parseInt(process.env.PORT || '10000', 10);
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const CLIENT_TOKEN =
  process.env.CLIENT_TOKEN || process.env.ZENTRAXEN_API_KEY || process.env.ZENTRAXEN_CLIENT_TOKEN || '';
const REQUIRE_APPCHECK = process.env.REQUIRE_APPCHECK === 'true';
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '200', 10);
const IP_PER_MINUTE = parseInt(process.env.IP_PER_MINUTE || '40', 10);
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || 'gpt-4o-mini').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_CAP || '400', 10);
const MAX_MESSAGES = 80;
const MAX_TOTAL_CHARS = 60000;

// ---------- Firebase Admin ----------
let firebaseReady = false;
let db = null;
try {
  let raw = '';
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    raw = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  }
  if (raw) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    db = admin.firestore();
    firebaseReady = true;
  }
} catch (e) {
  console.error('Firebase başlatılamadı:', e && e.message);
}

console.log(
  JSON.stringify({
    boot: true,
    openaiKey: !!OPENAI_KEY,
    clientToken: !!CLIENT_TOKEN,
    firebaseReady,
    REQUIRE_APPCHECK,
    REQUIRE_AUTH,
    DAILY_LIMIT,
  })
);

// ---------- Yardımcılar ----------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const ipHits = new Map(); // ip -> {n, reset}
function ipLimited(ip) {
  const now = Date.now();
  let h = ipHits.get(ip);
  if (!h || now > h.reset) {
    h = { n: 0, reset: now + 60000 };
    ipHits.set(ip, h);
  }
  h.n += 1;
  return h.n > IP_PER_MINUTE;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipHits) if (now > v.reset) ipHits.delete(k);
}, 60000).unref();

// Firestore ulaşılamazsa yedek: bellek içi sayaç (sunucu uyuyup uyanınca sıfırlanır)
const memDaily = new Map();
function memBump(key, day) {
  const k = day + '_' + key;
  const n = (memDaily.get(k) || 0) + 1;
  memDaily.set(k, n);
  if (memDaily.size > 5000) memDaily.clear();
  return n;
}

async function bumpDaily(key) {
  const day = new Date().toISOString().slice(0, 10); // UTC günü
  if (firebaseReady) {
    try {
      const ref = db.collection('aiUsage').doc(day + '_' + key);
      return await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const n = s.exists ? s.data().n || 0 : 0;
        if (n >= DAILY_LIMIT) return { ok: false, n };
        tx.set(
          ref,
          { n: n + 1, day, key, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        return { ok: true, n: n + 1 };
      });
    } catch (e) {
      console.error('Firestore sayaç hatası:', e && e.message);
    }
  }
  const n = memBump(key, day);
  return { ok: n <= DAILY_LIMIT, n };
}

function cleanBody(b) {
  if (!b || typeof b !== 'object') return { error: 'bad_body' };
  const model = ALLOWED_MODELS.includes(b.model) ? b.model : ALLOWED_MODELS[0];
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) {
    return { error: 'bad_messages' };
  }
  let total = 0;
  const messages = [];
  for (const m of b.messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return { error: 'bad_message' };
    }
    total += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (total > MAX_TOTAL_CHARS) return { error: 'too_long' };
  let temperature = Number(b.temperature);
  if (!isFinite(temperature)) temperature = 0.7;
  temperature = Math.min(1.2, Math.max(0, temperature));
  let maxTokens = parseInt(b.max_tokens, 10);
  if (!isFinite(maxTokens) || maxTokens <= 0) maxTokens = 300;
  maxTokens = Math.min(MAX_TOKENS_CAP, maxTokens);
  return { payload: { model, messages, temperature, max_tokens: maxTokens } };
}

// ---------- Uygulama ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Uyandırma / sağlık
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/v1/chat/completions', async (req, res) => {
  const t0 = Date.now();
  const ip = req.ip || 'unknown';
  const fail = (code, msg, tag) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), status: code, tag, ms: Date.now() - t0 }));
    return res.status(code).json({ error: { message: msg } });
  };

  if (!OPENAI_KEY) return fail(500, 'server_not_configured', 'nokey');
  if (ipLimited(ip)) return fail(429, 'too_many_requests', 'ip');

  // 1) Gizli istemci jetonu
  if (CLIENT_TOKEN) {
    const got = req.get('X-Zentraxen-Client') || '';
    if (!got || !safeEqual(got, CLIENT_TOKEN)) return fail(401, 'unauthorized', 'client');
  }

  // 2) App Check
  let appCheckOk = false;
  const acToken = req.get('X-Firebase-AppCheck');
  if (acToken && firebaseReady) {
    try {
      await admin.appCheck().verifyToken(acToken);
      appCheckOk = true;
    } catch (_) {
      appCheckOk = false;
    }
  }
  if (REQUIRE_APPCHECK && !appCheckOk) return fail(401, 'app_check_failed', 'appcheck');

  // 3) Kimlik jetonu
  let uid = null;
  const authH = req.get('Authorization') || '';
  if (authH.startsWith('Bearer ') && firebaseReady) {
    try {
      const dec = await admin.auth().verifyIdToken(authH.slice(7));
      uid = dec.uid;
    } catch (_) {
      uid = null;
    }
  }
  if (REQUIRE_AUTH && !uid) return fail(401, 'auth_required', 'auth');

  // 4) İstek temizliği
  const cleaned = cleanBody(req.body);
  if (cleaned.error) return fail(400, cleaned.error, 'body');

  // 5) Günlük limit (kullanıcı yoksa IP'ye göre)
  const key = uid ? 'u_' + uid : 'ip_' + crypto.createHash('sha1').update(ip).digest('hex').slice(0, 16);
  const d = await bumpDaily(key);
  if (!d.ok) return fail(429, 'daily_limit', 'daily');

  // 6) OpenAI'ye ilet
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 100000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify(cleaned.payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        status: r.status,
        appcheck: appCheckOk ? 'ok' : 'none',
        auth: uid ? 'ok' : 'none',
        n: d.n,
        ms: Date.now() - t0,
      })
    );
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), status: 502, tag: 'upstream', ms: Date.now() - t0 }));
    res.status(502).json({ error: { message: 'upstream_error' } });
  } finally {
    clearTimeout(timer);
  }
});

app.use((_req, res) => res.status(404).json({ error: { message: 'not_found' } }));

app.listen(PORT, () => console.log('Zentraxen proxy dinliyor:', PORT));
