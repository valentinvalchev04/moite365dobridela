// „Моите 365 добри дела“ – сървърна част на Vercel.
// Пази поръчките, отзивите и промените от админ панела в базата Upstash Redis (Vercel → Storage),
// а качените снимки – във Vercel Blob. Сайтът и admin.html говорят с адреса /api/data.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { put } from '@vercel/blob';

const env = process.env;
const pick = re => { const k = Object.keys(env).find(k => re.test(k) && env[k]); return k ? env[k] : ''; };
const R_URL = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || pick(/_REST_API_URL$|REDIS_REST_URL$/);
const R_TOKEN = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || pick(/_REST_API_TOKEN$|REDIS_REST_TOKEN$/);
const BLOB = env.BLOB_READ_WRITE_TOKEN || pick(/BLOB_READ_WRITE_TOKEN$/);

// Потребители на админ панела (паролите – само като отпечатък SHA-256 от „365dd:потребител:парола“).
// Нова парола, сменена от панела, се пази в базата и е с предимство.
const USERS = {
  arman: { name: 'Арман', hash: 'd7af2a4dd35077a1b86a432a2b6cca83216b27956d8426143822e1a5e4a12746' },
  admin: { name: 'Администратор', hash: '6a299e316bf487e54d7c002d8b359a1cdf7153e27b40ff34442628f328b91871' }
};
const STATUSES = ['Нова', 'Потвърдена', 'Изпратена', 'Платена', 'Отказана'];
const TOKEN_HOURS = 24 * 7;

// ---------- база данни ----------
async function redis(...cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function hashAll(key) {
  const flat = (await redis('HGETALL', key)) || [], out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push([flat[i], JSON.parse(flat[i + 1])]); } catch { } }
  return out;
}
const hget = async (key, f) => { const v = await redis('HGET', key, String(f)); return v ? JSON.parse(v) : null; };
const hset = (key, f, obj) => redis('HSET', key, String(f), JSON.stringify(obj));

// ---------- помощни ----------
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const str = (v, max = 1000) => String(v == null ? '' : v).slice(0, max);
let secretCache = env.CMS_SECRET || '';
async function secret() {
  if (secretCache) return secretCache;
  await redis('SET', 'secret', randomBytes(32).toString('hex'), 'NX');
  return (secretCache = await redis('GET', 'secret'));
}
const sign = async s => createHmac('sha256', await secret()).update(s).digest('base64url');
async function makeToken(user) { const body = user + '.' + (Date.now() + TOKEN_HOURS * 3600e3); return body + '.' + await sign(body); }
async function checkToken(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || !USERS[p[0]] || Number(p[1]) < Date.now()) return null;
  const a = Buffer.from(await sign(p[0] + '.' + p[1])), b = Buffer.from(p[2]);
  return a.length === b.length && timingSafeEqual(a, b) ? p[0] : null;
}
const userHash = async u => (await redis('GET', 'pass:' + u)) || USERS[u].hash;
const sumOf = o => Number(String(o['Обща сума'] || '').replace(/[^\d,.]/g, ' ').trim().split(' ')[0].replace(',', '.')) || 0;

function send(res, code, obj, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(obj));
}
async function body(req) {
  let d = req.body;
  if (d === undefined) { const chunks = []; for await (const c of req) chunks.push(c); d = Buffer.concat(chunks).toString('utf8'); }
  if (Buffer.isBuffer(d)) d = d.toString('utf8');
  if (typeof d === 'string') d = d ? JSON.parse(d) : {};
  return d || {};
}

// ---------- четене (сайтът) ----------
async function get(req, res) {
  const action = req.query && req.query.action;
  if (action === 'content') {
    const content = {};
    (await hashAll('content')).forEach(([k, c]) => { content[k] = { v: c.v, o: c.o }; });
    return send(res, 200, { content }, 'public, s-maxage=10, stale-while-revalidate=60');
  }
  // брояч + одобрени отзиви
  let books = 0;
  (await hashAll('orders')).forEach(([, o]) => { if (o.status !== 'Отказана' && !o.test) books += Number(o['Брой']) || 0; });
  const reviews = (await hashAll('reviews')).map(([, r]) => r).filter(r => r.approved)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(r => ({ date: r.date, name: r.name, stars: r.stars, text: r.text, photo: r.photo || '' }));
  return send(res, 200, { books, reviews }, 'public, s-maxage=20, stale-while-revalidate=60');
}

// ---------- запис ----------
async function post(req, res) {
  const d = await body(req);

  if (d.type === 'order') {
    if (d._gotcha) return send(res, 200, { ok: true });
    const o = {};
    Object.keys(d).slice(0, 40).forEach(k => { if (k !== 'type' && k[0] !== '_') o[str(k, 60)] = str(d[k]); });
    if (!o['Име'] || !o['Телефон']) return send(res, 400, { ok: false, error: 'Липсват данни.' });
    o.id = await redis('INCR', 'orders:seq');
    o.date = new Date().toISOString();
    o.status = 'Нова'; o.tracking = ''; o.note = '';
    o.sum = sumOf(o);
    await hset('orders', o.id, o);
    return send(res, 200, { ok: true, id: o.id });
  }

  if (d.type === 'review') {
    const photo = str(d.photo, 70000);
    const r = {
      id: await redis('INCR', 'reviews:seq'), date: new Date().toISOString(), name: str(d.name, 40),
      stars: Math.min(5, Math.max(1, Number(d.stars) || 5)), text: str(d.text, 600), email: str(d.email, 120),
      photo: photo.startsWith('data:image/') ? photo : '', approved: false
    };
    if (!r.name || r.text.length < 5) return send(res, 400, { ok: false });
    await hset('reviews', r.id, r);
    return send(res, 200, { ok: true });
  }

  if (d.type === 'login') {
    const user = str(d.user, 30).toLowerCase().trim();
    const ok = USERS[user] && (await userHash(user)) === sha('365dd:' + user + ':' + str(d.pass, 200));
    if (!ok) { await new Promise(r => setTimeout(r, 800)); return send(res, 200, { ok: false, error: 'Грешно име или парола.' }); }
    return send(res, 200, { ok: true, token: await makeToken(user), name: USERS[user].name });
  }

  // всичко отдолу е само за влезли потребители
  const user = await checkToken(d.token);
  if (!user) return send(res, 200, { ok: false, error: 'auth' });
  const by = USERS[user].name;

  switch (d.type) {
    case 'save': {
      for (const [k, c] of Object.entries(d.changes || {})) {
        if (c === null) await redis('HDEL', 'content', str(k, 80));
        else await hset('content', str(k, 80), { v: str(c.v, 20000), o: str(c.o, 20000), t: new Date().toISOString(), by });
      }
      return send(res, 200, { ok: true });
    }
    case 'upload': {
      if (!BLOB) return send(res, 200, { ok: false, error: 'Хранилището за снимки не е свързано (Vercel → Storage → Blob).' });
      const name = str(d.name, 60).replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'snimka';
      const blob = await put('site/' + name + '.jpg', Buffer.from(String(d.data || ''), 'base64'),
        { access: 'public', contentType: 'image/jpeg', addRandomSuffix: true, token: BLOB });
      return send(res, 200, { ok: true, url: blob.url });
    }
    case 'orders': {
      const orders = (await hashAll('orders')).map(([, o]) => o).sort((a, b) => b.id - a.id);
      return send(res, 200, { ok: true, orders, statuses: STATUSES });
    }
    case 'orderUpdate': {
      const o = await hget('orders', d.id); if (!o) return send(res, 200, { ok: false, error: 'Няма такава поръчка.' });
      if (d.status !== undefined && STATUSES.includes(d.status)) o.status = d.status;
      if (d.tracking !== undefined) o.tracking = str(d.tracking, 80);
      if (d.note !== undefined) o.note = str(d.note, 2000);
      o.changed = new Date().toISOString(); o.changedBy = by;
      await hset('orders', o.id, o);
      return send(res, 200, { ok: true, order: o });
    }
    case 'orderDelete': {
      await redis('HDEL', 'orders', String(d.id));
      return send(res, 200, { ok: true });
    }
    case 'reviews': {
      const reviews = (await hashAll('reviews')).map(([, r]) => r).sort((a, b) => b.id - a.id);
      return send(res, 200, { ok: true, reviews });
    }
    case 'reviewUpdate': {
      const r = await hget('reviews', d.id); if (!r) return send(res, 200, { ok: false, error: 'Няма такъв отзив.' });
      r.approved = !!d.approved;
      await hset('reviews', r.id, r);
      return send(res, 200, { ok: true });
    }
    case 'reviewDelete': {
      await redis('HDEL', 'reviews', String(d.id));
      return send(res, 200, { ok: true });
    }
    case 'password': {
      if ((await userHash(user)) !== sha('365dd:' + user + ':' + str(d.old, 200))) return send(res, 200, { ok: false, error: 'Старата парола не е вярна.' });
      if (str(d.new, 200).length < 6) return send(res, 200, { ok: false, error: 'Новата парола трябва да е поне 6 знака.' });
      await redis('SET', 'pass:' + user, sha('365dd:' + user + ':' + str(d.new, 200)));
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 400, { ok: false, error: 'Непозната заявка.' });
}

export default async function handler(req, res) {
  try {
    if (!R_URL || !R_TOKEN) return send(res, 500, { ok: false, error: 'Базата данни не е свързана (Vercel → Storage → Upstash).' });
    if (req.method === 'GET') return await get(req, res);
    if (req.method === 'POST') return await post(req, res);
    return send(res, 405, { ok: false });
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}
