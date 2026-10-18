'use strict';

const DEFAULT_TIMEOUT = 12000;
const DEFAULT_WORKER_URL = 'http://93.115.106.210:6656';

function workers() {
    const list = [process.env.VPS_URL, ...String(process.env.WORKER_URLS || '').split(',')]
        .map(x => String(x || '').trim()).filter(Boolean);
    for (let i = 1; i <= 3; i++) if (process.env[`WORKER_URL_${i}`]) list.push(process.env[`WORKER_URL_${i}`].trim());
    if (!list.length) list.push(DEFAULT_WORKER_URL);
    return [...new Set(list.map(x => x.replace(/\/$/, '')))];
}

function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

async function request(url, options = {}, timeout = DEFAULT_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 500) }; }
        return { response, data };
    } finally { clearTimeout(timer); }
}

async function workerStatus(base) {
    try {
        const { response, data } = await request(`${base}/public-network-status`);
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return { base, ok: true, data };
    } catch (error) {
        return { base, ok: false, error: error.message };
    }
}

async function chooseWorker() {
    const results = await Promise.all(workers().map(workerStatus));
    const healthy = results.filter(x => x.ok);
    if (!healthy.length) throw new Error('No Railway worker is healthy');
    healthy.sort((a, b) => Number(a.data.activeUsers || 0) - Number(b.data.activeUsers || 0));
    return { selected: healthy[0], results };
}

function workerHeaders(extra = {}) {
    return { Accept: 'application/json', ...extra, ...(process.env.WORKER_API_KEY ? { 'x-worker-key': process.env.WORKER_API_KEY } : {}) };
}

async function proxyAdmin(req, res, suffix) {
    const supplied = req.headers['x-admin-key'] || '';
    if (!process.env.ADMIN_KEY || supplied !== process.env.ADMIN_KEY) return json(res, 403, { error: 'Admin key required' });
    const { selected } = await chooseWorker();
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const { response, data } = await request(`${selected.base}/admin/${suffix}`, { method: req.method, headers: workerHeaders({ 'Content-Type': 'application/json', 'x-admin-key': process.env.WORKER_ADMIN_KEY || process.env.ADMIN_KEY }), body });
    json(res, response.status, data);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; if (raw.length > 1000000) reject(new Error('Request too large')); });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const configured = workers();
    if (!configured.length) return json(res, 503, { error: 'No Railway workers configured. Set WORKER_URL_1..3.' });
    const url = new URL(req.url, `https://${req.headers.host || 'vercel.local'}`);
    const route = url.searchParams.get('route');
    const path = route === 'admin'
        ? `admin/${url.searchParams.get('suffix') || ''}`.replace(/\/$/, '')
        : (route || url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, ''));

    try {
        if (path === 'code') {
            const number = String(url.searchParams.get('number') || '').replace(/\D/g, '');
            if (number.length < 6 || number.length > 15) return json(res, 400, { error: 'Use a valid country-code number.' });
            const { selected } = await chooseWorker();
            const ref = url.searchParams.get('ref');
            const target = `${selected.base}/code?number=${encodeURIComponent(number)}${ref ? `&ref=${encodeURIComponent(ref.slice(0, 16))}` : ''}`;
            const { response, data } = await request(target, { headers: workerHeaders() }, 75000);
            return json(res, response.status, { ...data, worker: selected.data.servers?.[0]?.name || selected.base });
        }
        if (path === 'network' || path === 'status') {
            const results = await Promise.all(configured.map(workerStatus));
            const healthy = results.filter(x => x.ok);
            if (path === 'status') {
                const statuses = await Promise.all(healthy.map(async x => { try { const r = await request(`${x.base}/public-status`); return r.data; } catch (_) { return {}; } }));
                return json(res, 200, { activeSessions: statuses.reduce((n, x) => n + Number(x.activeSessions || 0), 0), savedSessions: statuses.reduce((n, x) => n + Number(x.savedSessions || 0), 0) });
            }
            const servers = healthy.flatMap(x => Array.isArray(x.data.servers) ? x.data.servers : []);
            return json(res, 200, { activeUsers: healthy.reduce((n, x) => n + Number(x.data.activeUsers || 0), 0), pairedUsers: healthy.reduce((n, x) => n + Number(x.data.pairedUsers || 0), 0), healthyServers: servers.length, totalServers: results.length, servers });
        }
        if (path.startsWith('admin/')) return await proxyAdmin(req, res, path.slice('admin/'.length));
        if (path === 'health') return json(res, 200, { ok: true, workers: (await Promise.all(configured.map(workerStatus))).map(x => ({ url: x.base, ok: x.ok, error: x.error })) });
        return json(res, 404, { error: 'Unknown coordinator endpoint' });
    } catch (error) { return json(res, 502, { error: error.message || 'Coordinator request failed' }); }
};
