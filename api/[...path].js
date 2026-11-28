'use strict';
/*
 * XENORIZE MD - central API for Vercel (pairing website + admin panel + fleet control of all bot servers).
 * ENV: ADMIN_KEY (same as every bot's config.js), MONGODB_URI (same cluster db idea; this app uses its own database "xenorize_central").
 * Bots call:  POST /api/paired, GET /api/premium/*, /api/referrals/mine, /api/security/*   (x-api-key = ADMIN_KEY)
 * Website:    GET /api/code?number=..&ref=..   -> picks a bot server with a free slot and returns the pairing code
 */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// Built-in settings, so Vercel needs no Environment Variables (a variable set on Vercel still wins).
// SECRET: keep this repo PRIVATE. If you change ADMIN_KEY in the bots' config.js, change it here too.
const ADMIN_KEY_BUILTIN = "XENORMD";
const MONGODB_URI_BUILTIN = "mongodb+srv://em2487005_db_user:PL0v1y1yS1qDgIA0@cluster0.vwqxsb5.mongodb.net/";
const MONGO_URI = () => process.env.MONGODB_URI || (process.env.TEST_MEMORY === '1' ? '' : MONGODB_URI_BUILTIN);
const KEY = () => process.env.ADMIN_KEY || ADMIN_KEY_BUILTIN;
const digits = (v) => String(v || '').replace(/\D/g, '');
const err = (status, message) => Object.assign(new Error(message), { status });
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

// ---------- storage: MongoDB (or memory only for local tests with TEST_MEMORY=1) ----------
let _client; const _mem = {};
async function col(name) {
  if (!MONGO_URI()) {
    if (process.env.TEST_MEMORY !== '1') throw err(500, 'MONGODB_URI is not set on Vercel');
    const m = (_mem[name] ||= new Map());
    return { all: async () => [...m.values()], get: async (id) => m.get(id) || null, put: async (id, d) => { m.set(id, { ...d, _id: id }); }, del: async (id) => m.delete(id) };
  }
  if (!_client) { const { MongoClient } = require('mongodb'); _client = new MongoClient(MONGO_URI(), { maxPoolSize: 5 }); await _client.connect(); }
  const c = _client.db(process.env.MONGODB_DB || 'xenorize_central').collection(name);
  return { all: () => c.find({}).toArray(), get: (id) => c.findOne({ _id: id }), put: (id, d) => c.replaceOne({ _id: id }, { ...d, _id: id }, { upsert: true }), del: (id) => c.deleteOne({ _id: id }) };
}

// ---------- bot servers ----------
const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
async function callServer(s, method, path, { params, data, headers, timeout = 15000 } = {}) {
  const url = new URL(clean(s.url) + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, { method, headers: { 'x-api-key': KEY(), 'content-type': 'application/json', ...headers }, body: data !== undefined && method !== 'GET' ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(timeout) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status, body });
  return body;
}
const DEFAULT_SERVERS = [
  { id: 'server1', url: 'http://51.83.6.5:20139' },
  { id: 'server2', url: 'http://51.75.118.149:20104' },
  { id: 'server3', url: 'http://51.68.234.157:20083' },
  { id: 'server4', url: 'http://147.135.128.19:20029' },
  { id: 'server5', url: 'http://145.239.65.118:20129' },
];
let _seeded = false;
async function seedServers() { // auto-add the 5 built-in servers (only the missing ones) so the panel shows them without manual adding
  if (_seeded) return; const c = await col('servers');
  for (const d of DEFAULT_SERVERS) if (!(await c.get(d.id))) await c.put(d.id, { name: d.id, url: d.url, active: true, createdAt: new Date() });
  _seeded = true;
}
async function servers() { await seedServers(); return (await (await col('servers')).all()).filter((s) => s.active !== false); }
async function live() { // ping every server's /active
  const c = await col('servers'); const list = await servers();
  return Promise.all(list.map(async (s) => {
    try { const r = await callServer(s, 'GET', '/active', { timeout: 5000 }); const o = { ...s, healthy: true, count: r.count, limit: r.limit, lastKnownCount: r.count, lastKnownLimit: r.limit, lastSeenAt: new Date() }; c.put(s._id, { ...s, lastKnownCount: r.count, lastKnownLimit: r.limit, lastSeenAt: o.lastSeenAt }).catch(() => {}); return o; }
    catch { return { ...s, healthy: false, count: s.lastKnownCount || 0, limit: s.lastKnownLimit || 0 }; }
  }));
}
const pub = (s) => ({ id: s._id, name: s.name, url: s.url, active: s.active !== false, healthy: s.healthy, count: s.count, limit: s.limit, lastKnownCount: s.lastKnownCount, lastKnownLimit: s.lastKnownLimit, lastSeenAt: s.lastSeenAt });
async function fanout(method, path, opts) { // same call on every server
  const list = await servers();
  const results = await Promise.all(list.map(async (s) => { try { return { server: s._id, name: s.name, ok: true, response: await callServer(s, method, path, opts) }; } catch (e) { return { server: s._id, name: s.name, ok: false, error: e.message }; } }));
  return { results, succeeded: results.filter((r) => r.ok).length, total: results.length };
}

// ---------- referrals (rules copied from the bot's referral-local.js) ----------
const CONFIRM_DAYS = Number(process.env.REFERRAL_CONFIRM_DAYS ?? 3), REWARD_AT = Number(process.env.REFERRAL_REWARD_AT ?? 5);
const meta = { confirmDays: CONFIRM_DAYS, rewardAt: REWARD_AT };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => ALPHA[b % ALPHA.length]).join('');
async function connectedSet() { return new Set((await (await col('paired')).all()).filter((p) => p.status === 'connected').map((p) => p._id)); }
async function refState() { return { codes: await (await col('refcodes')).all(), refs: await (await col('refs')).all(), on: await connectedSet() }; }
function classify(r, on) { const state = r.blocked ? 'blocked' : !r.firstPairedAt ? 'waiting' : (Date.now() - new Date(r.firstPairedAt) >= CONFIRM_DAYS * 86400000 ? 'confirmed' : 'pending'); return { state, connectedNow: on.has(r.referred) }; }
function summarize(codeDoc, refs, on) {
  const o = { total: 0, pending: 0, confirmed: 0, connected: 0, eligible: 0 }; const referred = [];
  for (const r of refs) { const { state, connectedNow } = classify(r, on); if (state !== 'blocked') { o.total++; state === 'confirmed' ? o.confirmed++ : o.pending++; if (connectedNow) o.connected++; if (state === 'confirmed' && connectedNow) o.eligible++; } referred.push({ number: r.referred, state, connectedNow, server: r.server, firstPairedAt: r.firstPairedAt, createdAt: r.createdAt, ...(r.blocked ? { blockedReason: r.blockedReason || '' } : {}) }); }
  const rewardedUpTo = codeDoc?.rewardedUpTo || 0, dueNow = Math.max(0, o.eligible - rewardedUpTo);
  return { ...o, rewardedUpTo, dueNow, rewardDue: dueNow >= REWARD_AT, referred };
}
async function summaryFor(number) { const { codes, refs, on } = await refState(); const codeDoc = codes.find((c) => c._id === number) || null; return { codeDoc, ...summarize(codeDoc, refs.filter((r) => r.referrer === number), on) }; }
async function attachRef(number, refCode) {
  try {
    const code = String(refCode || '').trim().toUpperCase(); if (!/^[A-Z0-9]{4,12}$/.test(code)) return;
    const { codes, on } = await refState(); const owner = codes.find((c) => c.code === code);
    const refs = await col('refs');
    if (!owner || owner._id === number || await refs.get(number) || codes.some((c) => c._id === number) || on.has(number)) return;
    await refs.put(number, { referred: number, referrer: owner._id, code, firstPairedAt: null, blocked: false, blockedReason: '', createdAt: new Date().toISOString() });
  } catch (e) { console.error('[ref]', e.message); }
}

// ---------- per-user bot settings chosen on the pairing website ----------
// Only these on/off switches are accepted (names = the bot's own setting keys).
const SETTING_KEYS = ['antidelete', 'typing', 'recording', 'autoreact', 'autoviewonce', 'autoViewStatus', 'statuslike', 'autoWelcome', 'autoGoodbye'];
function cleanSettings(raw) {
  let o = raw; if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out = {}; for (const k of SETTING_KEYS) if (k in o) out[k] = o[k] === true || o[k] === 'true' || o[k] === 1 || o[k] === 'on';
  const pfx = (v) => { const x = String(v ?? '').trim(); return x && !/\s/.test(x) && [...x].length <= 3 ? x : null; };
  if (pfx(o.prefix)) out.prefix = pfx(o.prefix);
  if (Array.isArray(o.prefixes)) out.prefixes = [...new Set(o.prefixes.map(pfx).filter(Boolean))].slice(0, 9);
  for (const k of ['statusLikeEmojis', 'reactEmojis']) if (Array.isArray(o[k])) out[k] = [...new Set(o[k].map((x) => String(x).trim().slice(0, 16)).filter(Boolean))].slice(0, 20);
  if (out.typing && out.recording) out.typing = false; // the bot can only show one of the two
  return out;
}

// ---------- routes ----------
const routes = [];
const R = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler, auth });

R('GET', '/api/health', async () => ({ success: true, status: 'ok', time: new Date().toISOString() }), { auth: false });

// servers
R('GET', '/api/servers', async (q) => { const list = q.query.live === 'true' ? await live() : await servers(); return { success: true, total: list.length, servers: list.map(pub) }; }, { auth: false });
R('POST', '/api/servers', async (q) => {
  const id = String(q.body?.id || '').trim(), url = clean(q.body?.url); if (!/^[\w.-]{2,40}$/.test(id) || !/^https?:\/\//i.test(url)) throw err(400, 'id (e.g. server1) and a full url (http://IP:PORT) are required');
  const c = await col('servers'); if (await c.get(id)) throw err(409, 'A server with this id already exists');
  const doc = { name: q.body?.name || id, url, active: true, createdAt: new Date() }; await c.put(id, doc); return { success: true, server: pub({ ...doc, _id: id }) };
});
R('PATCH', '/api/servers/:id', async (q) => { const c = await col('servers'); const s = await c.get(q.params.id); if (!s) throw err(404, 'Server not found'); const d = { ...s }; if (q.body?.name) d.name = q.body.name; if (q.body?.url) d.url = clean(q.body.url); if (typeof q.body?.active === 'boolean') d.active = q.body.active; await c.put(s._id, d); return { success: true, server: pub(d) }; });
R('DELETE', '/api/servers/:id', async (q) => { const c = await col('servers'); if (!(await c.get(q.params.id))) throw err(404, 'Server not found'); await c.del(q.params.id); return { success: true, id: q.params.id }; });

// status
const statusObj = async () => { const list = await live(); const paired = (await (await col('paired')).all()).filter((p) => p.status === 'connected').length; const ok = list.filter((s) => s.healthy);
  return { success: true, totalServers: list.length, healthyServers: ok.length, totalActiveUsers: ok.reduce((a, s) => a + s.count, 0), totalCapacity: ok.reduce((a, s) => a + s.limit, 0), totalPairedUsers: paired, servers: list.map(pub) }; };
R('GET', '/api/status', statusObj, { auth: false });
R('GET', '/api/status/:serverId', async (q) => { const s = (await live()).find((x) => x._id === q.params.serverId); if (!s) throw err(404, 'Server not found'); return { success: true, ...pub(s) }; }, { auth: false });

// pairing
R('GET', '/api/code', async (q) => {
  const number = digits(q.query.number); if (number.length < 8 || number.length > 15) throw err(400, 'Enter a valid number with country code');
  const list = await live(); const paired = await col('paired'); const prev = await paired.get(number);
  let s = prev && list.find((x) => x._id === prev.server && x.healthy); // already known number -> its own server
  if (!s) s = list.filter((x) => x.healthy && x.count < x.limit).sort((a, b) => a.count / (a.limit || 1) - b.count / (b.limit || 1))[0];
  if (!s) throw err(503, list.some((x) => x.healthy) ? 'All servers are full right now' : 'No server is online right now');
  const chosen = cleanSettings(q.query.settings);
  const r = await callServer(s, 'GET', '/code', { params: { number, settings: Object.keys(chosen).length ? JSON.stringify(chosen) : undefined }, timeout: 45000 });
  if (Object.keys(chosen).length) await (await col('usersettings')).put(number, { number, settings: chosen, applied: false, server: s._id, updatedAt: new Date() }).catch(() => {}); // kept so it can be re-sent on first connect
  await paired.put(number, { ...(prev || {}), number, server: s._id, status: prev?.status === 'connected' ? 'connected' : 'pending', pairedAt: prev?.pairedAt || new Date() });
  if (q.query.ref) await attachRef(number, q.query.ref);
  return { success: true, code: r.code, server: s._id, serverName: s.name };
}, { auth: false });
R('POST', '/api/paired', async (q) => { // bots report connect / disconnect
  const number = digits(q.body?.number); if (!number) throw err(400, 'number required');
  const c = await col('paired'); const prev = await c.get(number) || {}; const connected = q.body?.status === 'connected';
  await c.put(number, { ...prev, number, jid: q.body?.jid || prev.jid, server: q.body?.serverId || prev.server, status: connected ? 'connected' : 'disconnected', pairedAt: prev.pairedAt || new Date(), lastActiveAt: new Date() });
  if (connected) { // settings chosen on the website: send them once, on the first connect (the bot also saved them when the code was made)
    try { const us = await col('usersettings'); const d = await us.get(number); const sid = q.body?.serverId || prev.server;
      if (d && !d.applied && sid) { const srv = await (await col('servers')).get(sid);
        if (srv) { await callServer(srv, 'POST', `/session/${number}/settings`, { data: d.settings, timeout: 8000 }); await us.put(number, { ...d, applied: true, appliedAt: new Date() }); } } }
    catch (e) { console.error('[usersettings]', e.message); }
  }
  if (connected) { const refs = await col('refs'); const r = await refs.get(number); if (r && !r.firstPairedAt) await refs.put(number, { ...r, firstPairedAt: new Date().toISOString(), server: q.body?.serverId }); }
  return { success: true };
});
R('GET', '/api/usersettings', async (q) => { const n = digits(q.query.number); const all = await (await col('usersettings')).all();
  return { success: true, users: all.filter((d) => !n || d._id.includes(n)).map((d) => ({ number: d._id, settings: d.settings, applied: !!d.applied, server: d.server, updatedAt: d.updatedAt })) }; });
R('GET', '/api/paired', async (q) => { const n = digits(q.query.number), st = q.query.status;
  const users = (await (await col('paired')).all()).filter((p) => (!n || p._id.includes(n)) && (!st || (st === 'connected' ? p.status === 'connected' : p.status !== 'connected'))).map((p) => ({ number: p._id, server: p.server, status: p.status === 'connected' ? 'connected' : 'pending', pairedAt: p.pairedAt, lastActiveAt: p.lastActiveAt }));
  return { success: true, total: users.length, users }; });
R('GET', '/api/unlink', async (q) => {
  const number = digits(q.query.number); const c = await col('paired'); const p = await c.get(number); const list = await servers();
  const targets = p?.server ? list.filter((s) => s._id === p.server) : list; let last = { removed: false };
  for (const s of targets) { try { last = await callServer(s, 'GET', '/unlink', { params: { number } }); } catch (e) { last = { error: e.message }; } }
  await c.del(number); return { success: true, ...last };
});
R('GET', '/api/updatex', async () => { const f = await fanout('GET', '/updateplugins');
  return { success: true, total: f.total, succeeded: f.succeeded, failed: f.total - f.succeeded, results: f.results.map((r) => ({ server: r.server, name: r.name, status: r.ok ? 'success' : 'failed', response: r.response, error: r.error })) }; });

// per-session panel proxy: /api/sessions/:server[/rest]  ->  that bot server
routes.push({ method: '*', auth: true, re: /^\/api\/sessions\/(?<server>[^/]+)(?<rest>\/.*)?$/, handler: async (q) => {
  await seedServers(); const s = await (await col('servers')).get(decodeURIComponent(q.params.server)); if (!s) throw err(404, 'Server not found');
  const rest = q.params.rest || ''; const path = rest === '' || rest === '/' ? '/sessions' : rest.startsWith('/chatdb') ? rest : `/session${rest}`;
  const { key, ...params } = q.query; return callServer(s, q.method, path, { params, data: q.body, timeout: 40000 }); } });

// owner server panel: /api/panel/:server/:action -> that server's /panel/:action (the server checks x-panel-key)
routes.push({ method: '*', auth: true, re: /^\/api\/panel\/(?<server>[^/]+)\/(?<action>[a-z]+)$/, handler: async (q) => {
  if (!['GET', 'POST'].includes(q.method)) throw err(405, 'Method not allowed');
  await seedServers(); const s = await (await col('servers')).get(decodeURIComponent(q.params.server)); if (!s) throw err(404, 'Server not found');
  const { key, '...path': _p, ...params } = q.query;
  return callServer(s, q.method, `/panel/${q.params.action}`, { params, data: q.body, headers: { 'x-panel-key': q.panelKey || '' }, timeout: 40000 }); } });

// fleet passcode
const sec = async () => (await (await col('settings')).get('security')) || {};
R('GET', '/api/security/fleet-passcode', async () => { const r = await sec(); return { success: true, configured: !!r.hash, passcodeRequired: r.passcodeRequired !== false, updatedAt: r.updatedAt || null }; });
R('PUT', '/api/security/fleet-passcode', async (q) => { const p = String(q.body?.passcode || ''); if (p.length < 12 || p.length > 128 || /\s/.test(p)) throw err(400, 'Passcode must be 12–128 characters with no spaces');
  const salt = crypto.randomBytes(16).toString('hex'); const hash = (await scrypt(p, salt, 64)).toString('hex'); await (await col('settings')).put('security', { ...(await sec()), salt, hash, updatedAt: new Date() }); return { success: true, configured: true }; });
R('PUT', '/api/security/fleet-passcode/requirement', async (q) => { if (typeof q.body?.required !== 'boolean') throw err(400, 'required must be true or false'); const r = { ...(await sec()), passcodeRequired: q.body.required, updatedAt: new Date() }; await (await col('settings')).put('security', r); return { success: true, passcodeRequired: r.passcodeRequired, configured: !!r.hash }; });
R('POST', '/api/security/verify-passcode', async (q) => { const r = await sec();
  if (r.passcodeRequired === false) return { success: true, valid: false, configured: !!r.hash, required: false };
  if (!r.hash) return { success: true, valid: false, configured: false, required: true };
  const actual = await scrypt(String(q.body?.passcode || ''), r.salt, 64), exp = Buffer.from(r.hash, 'hex'); return { success: true, valid: actual.length === exp.length && crypto.timingSafeEqual(actual, exp), configured: true, required: true }; });

// premium
const premAll = async () => (await (await col('premium')).all());
R('GET', '/api/premium', async () => ({ success: true, users: (await premAll()).map((v) => ({ number: v._id, expiresAt: v.expiresAt, active: new Date(v.expiresAt) > Date.now(), grantedBy: v.grantedBy || '' })) }));
R('GET', '/api/premium/check', async (q) => { const n = digits(q.query.number); const v = await (await col('premium')).get(n); return { success: true, number: n, active: !!v && new Date(v.expiresAt) > Date.now(), expiresAt: v?.expiresAt || null }; });
R('GET', '/api/premium/active', async (q) => { const want = new Set(String(q.query.numbers || '').split(',').map(digits).filter(Boolean)); const m = (await premAll()).filter((v) => want.has(v._id) && new Date(v.expiresAt) > Date.now()).map((v) => v._id); return { success: true, active: m.length > 0, numbers: m }; });
R('POST', '/api/premium/grant', async (q) => { const number = digits(q.body?.number), days = Number(q.body?.days);
  if (number.length < 8 || number.length > 20) throw err(400, 'A valid number is required'); if (!Number.isInteger(days) || days < 1 || days > 3650) throw err(400, 'days must be a whole number between 1 and 3650');
  const expiresAt = new Date(Date.now() + days * 86400000); await (await col('premium')).put(number, { expiresAt, grantedBy: String(q.body?.serverId || '') }); return { success: true, number, expiresAt }; });
R('POST', '/api/premium/remove', async (q) => { const n = digits(q.body?.number); const c = await col('premium'); const had = !!(await c.get(n)); await c.del(n); return { success: true, number: n, removed: had }; });

// referrals
R('GET', '/api/referrals/mine', async (q) => { const number = digits(q.query.number); if (number.length < 8) throw err(400, 'number is required');
  if (!(await connectedSet()).has(number)) throw err(403, 'not_paired');
  const cc = await col('refcodes'); let c = await cc.get(number);
  if (!c) { const used = new Set((await cc.all()).map((x) => x.code)); let code; do { code = newCode(); } while (used.has(code)); c = { code, rewardedUpTo: 0, rewards: [], createdAt: new Date().toISOString() }; await cc.put(number, c); }
  const { referred, codeDoc, ...counts } = await summaryFor(number); const base = process.env.PUBLIC_URL || `https://${q.host}`;
  return { success: true, code: c.code, link: `${clean(base)}/?ref=${c.code}`, ...counts, ...meta }; });
R('GET', '/api/referrals', async (q) => { const { codes, refs, on } = await refState(); const by = new Map(); for (const r of refs) (by.get(r.referrer) || by.set(r.referrer, []).get(r.referrer)).push(r);
  const f = digits(q.query.q);
  const rows = [...by.keys()].filter((n) => !f || n.includes(f)).map((number) => { const rs = by.get(number), cd = codes.find((c) => c._id === number); const { referred, ...s } = summarize(cd, rs, on);
    return { number, code: cd?.code || null, ...s, lastReferralAt: rs.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), rs[0].createdAt), lastRewardAt: cd?.rewards?.length ? cd.rewards[cd.rewards.length - 1].at : null }; });
  const sort = ['eligible', 'confirmed', 'total', 'connected', 'recent'].includes(q.query.sort) ? q.query.sort : 'eligible';
  rows.sort((a, b) => (sort === 'recent' ? new Date(b.lastReferralAt) - new Date(a.lastReferralAt) : (b[sort] - a[sort]) || (b.total - a.total)));
  return { success: true, ...meta, referrers: rows.length, referrals: refs.length, rows: rows.slice(0, 300) }; });
R('POST', '/api/referrals/reward', async (q) => { const number = digits(q.body?.number); const s = await summaryFor(number); if (!s.codeDoc) throw err(404, 'No referral record for that number');
  const cd = { ...s.codeDoc, rewardedUpTo: s.eligible, rewards: [...(s.codeDoc.rewards || []), { at: new Date().toISOString(), upTo: s.eligible, days: Number(q.body?.days) || null, note: String(q.body?.note || '').slice(0, 200) }].slice(-50) };
  await (await col('refcodes')).put(number, cd); const { referred, codeDoc, ...fresh } = await summaryFor(number); return { success: true, number, ...fresh }; });
R('POST', '/api/referrals/block', async (q) => { const referred = digits(q.body?.referred), blocked = q.body?.blocked !== false; const c = await col('refs'); const r = await c.get(referred); if (!r) throw err(404, 'Referral not found');
  await c.put(referred, { ...r, blocked, blockedReason: blocked ? String(q.body?.reason || '').slice(0, 200) : '' }); return { success: true, referred, blocked }; });
R('GET', '/api/referrals/:number', async (q) => { const number = digits(q.params.number); const { codeDoc, ...s } = await summaryFor(number); if (!codeDoc && !s.total) throw err(404, 'No referral record for that number'); return { success: true, number, code: codeDoc?.code || null, ...s, rewards: codeDoc?.rewards || [], ...meta }; });

// fleet-wide settings / channel tools (the same call goes to every server)
R('GET', '/api/settings/runtime', async () => { const rt = (await (await col('settings')).get('runtime')) || { autoJoinGroups: [], autoFollowChannels: [] }; return { success: true, runtimeSettings: { autoJoinGroups: rt.autoJoinGroups || [], autoFollowChannels: rt.autoFollowChannels || [] }, succeeded: 0, total: 0, results: [] }; });
R('POST', '/api/settings/runtime', async (q) => { const { kind, action, value } = q.body || {}; const key = kind === 'autojoin' ? 'autoJoinGroups' : ['autofollow', 'autoarc'].includes(kind) ? 'autoFollowChannels' : null;
  if (!key || !['add', 'remove'].includes(action) || !value) throw err(400, 'kind, action, and value are required');
  const c = await col('settings'); const rt = (await c.get('runtime')) || { autoJoinGroups: [], autoFollowChannels: [] }; const set = new Set(rt[key] || []); action === 'add' ? set.add(String(value).trim()) : set.delete(String(value).trim()); rt[key] = [...set]; await c.put('runtime', rt);
  const f = await fanout('POST', '/settings/runtime', { data: { kind, action, value } }); return { success: true, kind, action, succeeded: f.succeeded, total: f.total, results: f.results, runtimeSettings: { autoJoinGroups: rt.autoJoinGroups || [], autoFollowChannels: rt.autoFollowChannels || [] } }; });
R('GET', '/api/follow/all', async (q) => { const f = await fanout('GET', '/follow', { params: { channel: q.query.channel, action: q.query.action, maxSessions: q.query.count }, timeout: 55000 }); const ok = f.results.filter((r) => r.ok).map((r) => r.response);
  return { success: true, requestedSessions: q.query.count ? Number(q.query.count) : null, totalSessions: ok.reduce((a, r) => a + (r.totalSessions || 0), 0), succeededSessions: ok.reduce((a, r) => a + (r.succeeded || 0), 0), failedSessions: ok.reduce((a, r) => a + (r.failed || 0), 0), ...(ok.find((r) => r.subscriberCount != null) ? { subscriberCount: ok.find((r) => r.subscriberCount != null).subscriberCount } : {}), servers: f.results }; });
R('GET', '/api/chreact', async (q) => ({ success: true, ...(await fanout('GET', '/chreact', { params: q.query, timeout: 55000 })) }));
R('GET', '/api/arc/mappings', async () => { const f = await fanout('GET', '/arc/mappings'); const channels = {}; let sessions = 0;
  for (const r of f.results.filter((x) => x.ok)) { sessions += r.response.sessionCount || 0; for (const [jid, v] of Object.entries(r.response.mappings || {})) (channels[jid] ||= { emojis: v.emojis, servers: [] }).servers.push({ serverId: r.server, name: r.name, enabled: v.enabled !== false, emojis: v.emojis }); }
  return { success: true, totalServers: f.total, healthyServers: f.succeeded, totalSessions: sessions, servers: f.results.map((r) => ({ id: r.server, name: r.name, ok: r.ok })), channels }; });
for (const p of ['/arc/mappings/add', '/arc/mappings/remove', '/arc/stop', '/arc/react', '/pollvote/stop'])
  R('POST', '/api' + p, async (q) => ({ success: true, ...(await fanout('POST', p, { data: q.body, timeout: 55000 })) }));
R('POST', '/api/pollvote', async (q) => { const { url, optionNumber, count } = q.body || {}; if (!url || optionNumber == null || optionNumber === '') throw err(400, 'url and optionNumber are required');
  const list = await live(); const ok = list.filter((s) => s.healthy); if (!ok.length) throw err(503, 'No server is online');
  const total = count ? Number(count) : null; const per = total ? Math.floor(total / ok.length) : null, extra = total ? total % ok.length : 0;
  const results = await Promise.all(ok.map(async (s, i) => { const n = total ? per + (i < extra ? 1 : 0) : undefined; if (total && !n) return { server: s._id, ok: true, queued: 0 };
    try { const r = await callServer(s, 'POST', '/pollvote', { data: { ...q.body, count: n }, timeout: 55000 }); return { server: s._id, name: s.name, ok: true, ...r }; } catch (e) { return { server: s._id, name: s.name, ok: false, error: e.message }; } }));
  return { success: true, requested: total, queued: results.reduce((a, r) => a + (r.queued || r.totalSessions || 0), 0), etaMs: Math.max(0, ...results.map((r) => r.etaMs || 0)), servers: results }; });
R('POST', '/api/pollvote/unvote', async () => { throw err(501, 'Withdrawing channel poll votes is not supported'); });

// ---------- entry ----------
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const u = new URL(req.url, 'http://x'); const path = u.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(u.searchParams);
  try {
    for (const r of routes) {
      if (r.method !== '*' && r.method !== req.method) continue; const m = r.re.exec(path); if (!m) continue;
      if (r.auth && !safeEq(req.headers['x-api-key'] || query.key, KEY())) throw err(401, 'Invalid or missing authentication key');
      const out = await r.handler({ method: req.method, params: m.groups || {}, query, body: req.body, panelKey: req.headers['x-panel-key'], host: req.headers['x-forwarded-host'] || req.headers.host });
      return res.status(200).json(out);
    }
    res.status(404).json({ success: false, error: 'Not found' });
  } catch (e) { res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ success: false, error: e.message, ...(e.body && typeof e.body === 'object' ? { upstream: e.body } : {}) }); }
};
