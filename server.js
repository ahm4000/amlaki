'use strict';
// Amlaki — property management website. No external packages: Node.js 22.13+ only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { resolveLocation, LocationError } = require('./lib/location');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TZ = process.env.APP_TZ || 'Asia/Dubai';
const MAX_JSON = 100 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES_PER_PROPERTY = 300;
const MAX_USER_STORAGE = (Number(process.env.MAX_USER_STORAGE_MB) || 1024) * 1024 * 1024;
const MAX_PROPERTIES_PER_USER = 1000;
const SESSION_DAYS = 30;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','agent')), pass TEXT NOT NULL,
  agent_code TEXT UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, email TEXT, user_id INTEGER REFERENCES users(id),
  claim_code TEXT UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES users(id), owner_contact_id INTEGER REFERENCES contacts(id),
  agent_id INTEGER REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id),
  address TEXT, emirate TEXT, area TEXT, lat REAL, lng REAL, maps_url TEXT,
  rent_annual REAL NOT NULL DEFAULT 0, rent_period TEXT NOT NULL DEFAULT 'annual',
  next_inspection TEXT, notes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, email TEXT, contract_start TEXT NOT NULL, contract_end TEXT NOT NULL,
  annual_rent REAL NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL, amount REAL NOT NULL, paid_date TEXT, note TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date TEXT NOT NULL, title TEXT NOT NULL, contractor TEXT, cost REAL NOT NULL DEFAULT 0, notes TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title TEXT NOT NULL, interval_months INTEGER NOT NULL, next_due TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, note TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, doc_type TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  stored TEXT NOT NULL, maintenance_id INTEGER, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_prop_owner ON properties(owner_user_id);
CREATE INDEX IF NOT EXISTS ix_prop_agent ON properties(agent_id);
`);

if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google ON users(google_sub)');
if (!db.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'cheques')) db.exec('ALTER TABLE tenants ADD COLUMN cheques INTEGER NOT NULL DEFAULT 0');

const stmts = new Map();
const q = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };

// ---------- helpers ----------
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = () => { throw new HttpError(404, 'not_found'); };
const forbidden = () => { throw new HttpError(403, 'forbidden'); };
const sum = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const today = () => process.env.FAKE_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const dayNum = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 864e5);
const daysUntil = (from, to) => dayNum(to) - dayNum(from);
function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// Whole months covered by a contract, counting both the first and the last day (1 Mar to 28 Feb = 12).
function monthsBetween(start, end) {
  const e = new Date(Date.parse(end + 'T00:00:00Z') + 864e5);
  const [y, m, d] = start.split('-').map(Number);
  let n = (e.getUTCFullYear() - y) * 12 + (e.getUTCMonth() + 1 - m);
  if (e.getUTCDate() < d) n--;
  return Math.max(1, n);
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n) => Array.from({ length: n }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

const V = {
  str: (min, max) => (v, k) => {
    if (v == null) v = '';
    if (typeof v !== 'string') bad(k + ': must be text');
    v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (v.length < min) bad(k + ': required');
    if (v.length > max) bad(k + ': too long');
    return v;
  },
  date: (req) => (v, k) => {
    if (v == null || v === '') { if (req) bad(k + ': required'); return null; }
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(k + ': invalid date');
    const t = new Date(v + 'T00:00:00Z');
    if (isNaN(t) || t.toISOString().slice(0, 10) !== v) bad(k + ': invalid date');
    return v;
  },
  money: (req) => (v, k) => {
    if (v == null || v === '') { if (req) bad(k + ': required'); return 0; }
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isFinite(n) || n < 0 || n > 1e10) bad(k + ': invalid amount');
    return Math.round(n * 100) / 100;
  },
  int: (min, max) => (v, k) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isInteger(n) || n < min || n > max) bad(k + ': invalid number');
    return n;
  },
  optInt: (min, max) => (v, k) => {
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) bad(k + ': invalid number');
    return n;
  },
  one: (list, def) => (v, k) => {
    if ((v == null || v === '') && def) return def;
    if (!list.includes(v)) bad(k + ': invalid value');
    return v;
  },
  coord: (limit) => (v, k) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > limit) bad(k + ': invalid coordinate');
    return n;
  },
};
function clean(spec, body) {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) out[k] = fn(body[k], k);
  return out;
}

const PROPERTY_TYPES = ['villa', 'apartment', 'shop', 'land', 'other'];
const PROP_SPEC = {
  name: V.str(1, 120), type: V.one(PROPERTY_TYPES, 'villa'), address: V.str(0, 300), emirate: V.str(0, 60),
  area: V.str(0, 120), lat: V.coord(90), lng: V.coord(180), maps_url: V.str(0, 800),
  next_inspection: V.date(false), notes: V.str(0, 2000),
};
const KINDS = {
  tenants: { name: V.str(1, 120), phone: V.str(0, 40), email: V.str(0, 160), contract_start: V.date(true), contract_end: V.date(true), annual_rent: V.money(false), cheques: V.optInt(0, 24) },
  payments: { due_date: V.date(true), amount: V.money(true), paid_date: V.date(false), note: V.str(0, 300) },
  maintenance: { date: V.date(true), title: V.str(1, 160), contractor: V.str(0, 160), cost: V.money(false), notes: V.str(0, 1000) },
  reminders: { title: V.str(1, 160), interval_months: V.int(1, 120), next_due: V.date(true) },
  expenses: { date: V.date(true), category: V.one(['service', 'other'], 'other'), amount: V.money(true), note: V.str(0, 300) },
};
const ORDER = { tenants: 'contract_start DESC', payments: 'due_date', maintenance: 'date DESC', reminders: 'next_due', expenses: 'date DESC' };
const KIND_RE = '(?<kind>tenants|payments|maintenance|reminders|expenses)';

function propFields(body) {
  const f = clean(PROP_SPEC, body);
  if ((f.lat == null) !== (f.lng == null)) bad('location: both latitude and longitude are needed');
  const period = V.one(['monthly', 'annual'], 'annual')(body.rent_period, 'rent_period');
  const amount = V.money(false)(body.rent_amount, 'rent_amount');
  f.rent_period = period;
  f.rent_annual = period === 'monthly' ? Math.round(amount * 12 * 100) / 100 : amount;
  if (f.maps_url && !/^https:\/\//i.test(f.maps_url)) f.maps_url = '';
  return f;
}

// A contract can be entered with an end date or with a duration in months.
function tenantFields(body) {
  const b = { ...body };
  if ((b.contract_end == null || b.contract_end === '') && b.duration_months != null && b.duration_months !== '') {
    const months = V.int(1, 120)(b.duration_months, 'duration_months');
    b.contract_end = addDays(addMonths(V.date(true)(b.contract_start, 'contract_start'), months), -1);
  }
  const f = clean(KINDS.tenants, b);
  if (f.contract_end < f.contract_start) bad('contract_end: must be after the start date');
  return f;
}
// One expected rent payment per cheque, spread evenly over the contract. The last cheque takes any rounding difference.
function chequeSchedule(f) {
  if (!f.cheques || !(f.annual_rent > 0)) return [];
  const months = monthsBetween(f.contract_start, f.contract_end);
  const total = Math.round(f.annual_rent * months / 12 * 100) / 100;
  const each = Math.floor(total / f.cheques * 100) / 100;
  return Array.from({ length: f.cheques }, (_, i) => ({
    due_date: addMonths(f.contract_start, Math.floor(i * months / f.cheques)),
    amount: i === f.cheques - 1 ? Math.round((total - each * (f.cheques - 1)) * 100) / 100 : each,
    note: `Cheque ${i + 1} of ${f.cheques}`,
  }));
}

// ---------- rate limiting ----------
const buckets = new Map();
function limit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  if (++b.count > max) throw new HttpError(429, 'too_many');
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
  q('DELETE FROM sessions WHERE expires < ?').run(t);
}, 10 * 60 * 1000).unref();
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

// ---------- passwords and sessions ----------
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  const want = Buffer.from(hashHex || '', 'hex');
  const got = await scrypt(pw, Buffer.from(saltHex || '00', 'hex'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);
const NO_PASSWORD = 'none$00$00';   // marks an account that signs in with Google only
const isSecure = (req) => process.env.COOKIE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
function cookie(req, value, maxAge) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}
function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?,?,?)').run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', cookie(req, token, SESSION_DAYS * 86400));
}
function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{20,100})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = q('SELECT user_id, expires FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!s || s.expires < Date.now()) return null;
  return q('SELECT id, email, name, role, agent_code, google_sub, pass FROM users WHERE id = ?').get(s.user_id) || null;
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, agent_code: u.role === 'agent' ? u.agent_code : null, google: !!u.google_sub, has_password: u.pass !== NO_PASSWORD });

// ---------- Google sign-in (OpenID Connect, authorization-code flow) ----------
const GOOGLE = {
  id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '',
  authUrl: process.env.OAUTH_TEST_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',     // overrides exist for the automated tests only
  tokenUrl: process.env.OAUTH_TEST_TOKEN_URL || 'https://oauth2.googleapis.com/token',
};
const googleEnabled = () => !!(GOOGLE.id && GOOGLE.secret);
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return (isSecure(req) ? 'https' : 'http') + '://' + req.headers.host;
}
const stateCookie = (req, value, maxAge) => `g_state=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
function redirect(res, location, cookies) {
  if (cookies) res.setHeader('Set-Cookie', cookies);
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
async function googleAuth(req, res, url) {
  if (!googleEnabled()) notFound();
  limit('gauth:' + clientIp(req), 40, 15 * 60 * 1000);
  const redirectUri = baseUrl(req) + '/auth/google/callback';
  if (url.pathname === '/auth/google') {
    const asked = url.searchParams.get('role');
    const role = asked === 'owner' || asked === 'agent' ? asked : '';
    const state = crypto.randomBytes(24).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url');
    const params = new URLSearchParams({ client_id: GOOGLE.id, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' });
    return redirect(res, GOOGLE.authUrl + '?' + params, [stateCookie(req, `${state}.${nonce}.${role}`, 600)]);
  }
  // Callback from Google. The state cookie ties this reply to the browser that started the sign-in.
  const fail = (code) => redirect(res, '/#/login/' + code, [stateCookie(req, '', 0)]);
  const m = /(?:^|;\s*)g_state=([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{20,})\.(owner|agent|)(?:;|$)/.exec(req.headers.cookie || '');
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!m || !code || code.length > 2000 || state.length !== m[1].length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(m[1]))) return fail('google_failed');
  let claims = null;
  try {
    const r = await fetch(GOOGLE.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({ code, client_id: GOOGLE.id, client_secret: GOOGLE.secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const j = await r.json();
    if (r.ok && j && typeof j.id_token === 'string') claims = JSON.parse(Buffer.from(j.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
  } catch { claims = null; }
  // The token comes straight from Google's token endpoint over HTTPS; its claims are still checked.
  if (!claims || typeof claims !== 'object' || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== GOOGLE.id ||
      !(Number(claims.exp) * 1000 > Date.now()) || claims.nonce !== m[2] || typeof claims.sub !== 'string' || !/^[\w.-]{1,64}$/.test(claims.sub)) return fail('google_failed');
  if ((claims.email_verified !== true && claims.email_verified !== 'true') || typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 160) return fail('google_unverified');
  const email = claims.email.trim().toLowerCase();
  let user = q('SELECT * FROM users WHERE google_sub = ?').get(claims.sub);
  if (!user) {
    const existing = q('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) {
      if (existing.google_sub) return fail('google_failed');
      // Email addresses of password accounts are not verified, so linking removes the old password and logs out
      // every device. Otherwise someone who pre-registered this email could keep access to the account.
      q('UPDATE users SET google_sub = ?, pass = ? WHERE id = ?').run(claims.sub, NO_PASSWORD, existing.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      user = existing;
    } else {
      if (!m[3]) return redirect(res, '/#/signup/google_role', [stateCookie(req, '', 0)]);
      const name = String(claims.name || email.split('@')[0]).replace(/[\u0000-\u001F]/g, '').trim().slice(0, 80) || 'User';
      const id = q('INSERT INTO users (email, name, role, pass, agent_code, google_sub, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(email, name, m[3], NO_PASSWORD, m[3] === 'agent' ? randomCode(8) : null, claims.sub, now()).lastInsertRowid;
      user = { id: Number(id) };
    }
  }
  startSession(req, res, user.id);
  return redirect(res, '/#/dashboard', [res.getHeader('Set-Cookie'), stateCookie(req, '', 0)]);
}

// ---------- access rules ----------
// Owner: full control of properties they own. Agent: view/edit properties they manage;
// may delete only things they added themselves. Everyone else: the property does not exist (404).
function accessOf(user, prop) {
  if (!prop) return null;
  if (user.role === 'owner' && prop.owner_user_id === user.id) return 'owner';
  if (user.role === 'agent' && prop.agent_id === user.id) return 'agent';
  return null;
}
function loadProperty(user, id) {
  const p = q('SELECT * FROM properties WHERE id = ?').get(Number(id));
  const acc = accessOf(user, p);
  if (!acc) notFound();
  return { p, acc };
}
const canDeleteRecord = (user, acc, rec) => acc === 'owner' || rec.created_by === user.id;
function canDeleteProperty(user, acc, p) {
  if (acc === 'owner') return true;
  if (p.created_by !== user.id) return false;
  for (const t of [...Object.keys(KINDS), 'files']) {
    if (q(`SELECT 1 AS x FROM ${t} WHERE property_id = ? AND created_by <> ? LIMIT 1`).get(p.id, user.id)) return false;
  }
  return true;
}
function accessibleProperties(user) {
  return user.role === 'owner'
    ? q('SELECT * FROM properties WHERE owner_user_id = ? ORDER BY id DESC').all(user.id)
    : q('SELECT * FROM properties WHERE agent_id = ? ORDER BY id DESC').all(user.id);
}
function childrenOf(pid) {
  const out = {};
  for (const k of Object.keys(KINDS)) out[k] = q(`SELECT * FROM ${k} WHERE property_id = ? ORDER BY ${ORDER[k]}`).all(pid);
  for (const t of out.tenants) t.duration_months = monthsBetween(t.contract_start, t.contract_end);
  out.files = q('SELECT id, property_id, kind, doc_type, name, mime, size, maintenance_id, created_by, created_at FROM files WHERE property_id = ? ORDER BY id').all(pid);
  return out;
}
function findAgentByCode(user, code) {
  limit('code:' + user.id, 20, 60 * 60 * 1000);
  const a = q("SELECT id FROM users WHERE role = 'agent' AND agent_code = ?").get(String(code || '').trim().toUpperCase());
  if (!a) throw new HttpError(400, 'invalid_code');
  return a;
}

function summarize(p, ch, T, year) {
  const yr = String(year);
  const inYear = (d) => !!d && d.slice(0, 4) === yr;
  const received = sum(ch.payments.filter((x) => inYear(x.paid_date)).map((x) => x.amount));
  const unpaid = ch.payments.filter((x) => !x.paid_date && x.due_date <= yr + '-12-31');
  const outstanding = sum(unpaid.map((x) => x.amount));
  const overdue = sum(unpaid.filter((x) => x.due_date < T).map((x) => x.amount));
  const maint = sum(ch.maintenance.filter((x) => inYear(x.date)).map((x) => x.cost));
  const service = sum(ch.expenses.filter((x) => inYear(x.date) && x.category === 'service').map((x) => x.amount));
  const other = sum(ch.expenses.filter((x) => inYear(x.date) && x.category !== 'service').map((x) => x.amount));
  const expenses = sum([maint, service, other]);
  const active = ch.tenants.find((t) => t.contract_start <= T && t.contract_end >= T) || null;
  let status = 'vacant';
  if (active) status = daysUntil(T, active.contract_end) <= 90 ? 'renewal' : 'rented';
  if (overdue > 0) status = 'overdue';
  return { expected: p.rent_annual, received, outstanding, overdue, expenses, byCategory: { maintenance: maint, service, other },
    net: sum([received, -expenses]), occupied: !!active, status, tenant: active ? active.name : null,
    contract: active ? { start: active.contract_start, end: active.contract_end, months: monthsBetween(active.contract_start, active.contract_end), cheques: active.cheques } : null };
}
function present(user, p, ch) {
  const acc = accessOf(user, p);
  const ownerUser = p.owner_user_id ? q('SELECT name FROM users WHERE id = ?').get(p.owner_user_id) : null;
  const contact = p.owner_contact_id ? q('SELECT name FROM contacts WHERE id = ?').get(p.owner_contact_id) : null;
  const agent = p.agent_id ? q('SELECT name, email FROM users WHERE id = ?').get(p.agent_id) : null;
  const cover = ch.files.find((f) => f.kind === 'photo' && !f.maintenance_id);
  return {
    id: p.id, name: p.name, type: p.type, address: p.address, emirate: p.emirate, area: p.area, lat: p.lat, lng: p.lng,
    maps_url: p.maps_url, rent_annual: p.rent_annual, rent_period: p.rent_period, next_inspection: p.next_inspection, notes: p.notes,
    owner_name: ownerUser ? ownerUser.name : contact ? contact.name : '', owner_linked: !!p.owner_user_id,
    agent_name: agent ? agent.name : null, agent_email: agent && acc === 'owner' ? agent.email : null,
    cover_id: cover ? cover.id : null, role: acc, owner_contact_id: acc === 'agent' ? p.owner_contact_id : null,
    can: { assign_agent: acc === 'owner', delete: canDeleteProperty(user, acc, p) },
  };
}

function buildDashboard(user, year) {
  const T = today();
  const yr = String(year);
  const props = accessibleProperties(user);
  const totals = { properties: props.length, occupied: 0, vacant: 0, expected: 0, received: 0, outstanding: 0, overdue: 0, expenses: 0 };
  const byCategory = { maintenance: 0, service: 0, other: 0 };
  const monthly = Array.from({ length: 12 }, () => ({ income: 0, expenses: 0 }));
  const attention = [], calendar = [], list = [];
  for (const p of props) {
    const ch = childrenOf(p.id);
    const s = summarize(p, ch, T, year);
    list.push({ ...present(user, p, ch), summary: s });
    totals.occupied += s.occupied ? 1 : 0;
    for (const k of ['expected', 'received', 'outstanding', 'overdue', 'expenses']) totals[k] += s[k];
    for (const k of Object.keys(byCategory)) byCategory[k] += s.byCategory[k];
    const months = Array(12).fill(null);
    for (const pay of ch.payments) {
      if (pay.paid_date && pay.paid_date.slice(0, 4) === yr) monthly[Number(pay.paid_date.slice(5, 7)) - 1].income += pay.amount;
      if (pay.due_date.slice(0, 4) === yr) {
        const i = Number(pay.due_date.slice(5, 7)) - 1;
        const d = daysUntil(T, pay.due_date);
        const st = pay.paid_date ? 'paid' : d < 0 ? 'overdue' : d <= 30 ? 'due' : 'upcoming';
        const rank = { paid: 0, upcoming: 1, due: 2, overdue: 3 };
        const cell = months[i] || (months[i] = { amount: 0, status: st });
        cell.amount = sum([cell.amount, pay.amount]);
        if (rank[st] > rank[cell.status]) cell.status = st;
      }
      if (!pay.paid_date) {
        const d = daysUntil(T, pay.due_date);
        if (d <= 30) attention.push({ type: d < 0 ? 'rent_overdue' : 'rent_due', date: pay.due_date, days: d, amount: pay.amount, property_id: p.id, property_name: p.name });
      }
    }
    for (const m of ch.maintenance) if (m.date.slice(0, 4) === yr) monthly[Number(m.date.slice(5, 7)) - 1].expenses += m.cost;
    for (const e of ch.expenses) if (e.date.slice(0, 4) === yr) monthly[Number(e.date.slice(5, 7)) - 1].expenses += e.amount;
    for (const r of ch.reminders) {
      const d = daysUntil(T, r.next_due);
      if (d <= 30) attention.push({ type: 'maintenance', date: r.next_due, days: d, title: r.title, property_id: p.id, property_name: p.name });
    }
    const latest = ch.tenants[0];
    if (latest) {
      const d = daysUntil(T, latest.contract_end);
      if (d <= 90 && d >= -30) attention.push({ type: 'contract', date: latest.contract_end, days: d, title: latest.name, property_id: p.id, property_name: p.name });
    }
    if (p.next_inspection) {
      const d = daysUntil(T, p.next_inspection);
      if (d <= 30) attention.push({ type: 'inspection', date: p.next_inspection, days: d, property_id: p.id, property_name: p.name });
    }
    calendar.push({ property_id: p.id, name: p.name, months });
  }
  for (const k of Object.keys(totals)) totals[k] = sum([totals[k]]);
  for (const k of Object.keys(byCategory)) byCategory[k] = sum([byCategory[k]]);
  for (const m of monthly) { m.income = sum([m.income]); m.expenses = sum([m.expenses]); }
  totals.vacant = totals.properties - totals.occupied;
  totals.net = sum([totals.received, -totals.expenses]);
  totals.collected_pct = totals.expected > 0 ? Math.min(100, Math.round((totals.received / totals.expected) * 100)) : 0;
  attention.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { year: Number(year), today: T, totals, byCategory, monthly, attention, calendar, properties: list };
}

// ---------- files ----------
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
function removeStored(stored) {
  if (!/^[a-f0-9]{32}$/.test(stored)) return;
  fs.rm(path.join(UPLOAD_DIR, stored), { force: true }, () => {});
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d{1,12})') + '$'), handler, opts });
}

route('POST', '/api/signup', async (c) => {
  limit('signup:' + c.ip, 10, 60 * 60 * 1000);
  const b = await c.json();
  const email = V.str(3, 160)(b.email, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('email: invalid');
  const name = V.str(1, 80)(b.name, 'name');
  const role = V.one(['owner', 'agent'])(b.role, 'role');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) throw new HttpError(400, 'weak_password');
  const pass = await hashPassword(b.password);
  let id;
  try {
    id = q('INSERT INTO users (email, name, role, pass, agent_code, created_at) VALUES (?,?,?,?,?,?)')
      .run(email, name, role, pass, role === 'agent' ? randomCode(8) : null, now()).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'email_taken');
    throw e;
  }
  startSession(c.req, c.res, Number(id));
  return publicUser(q('SELECT * FROM users WHERE id = ?').get(Number(id)));
}, { public: true });

route('POST', '/api/login', async (c) => {
  const b = await c.json();
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160);
  limit('login-ip:' + c.ip, 60, 15 * 60 * 1000);
  limit('login:' + c.ip + ':' + email, 10, 15 * 60 * 1000);
  const u = q('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await checkPassword(String(b.password || '').slice(0, 200), u ? u.pass : DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'invalid_login');
  startSession(c.req, c.res, u.id);
  return publicUser(u);
}, { public: true });

route('POST', '/api/logout', async (c) => {
  const token = sessionToken(c.req);
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  c.res.setHeader('Set-Cookie', cookie(c.req, '', 0));
  return { ok: true };
}, { public: true });

route('GET', '/api/me', async (c) => publicUser(c.user));
route('GET', '/api/config', async () => ({ google: googleEnabled() }), { public: true });

route('POST', '/api/password', async (c) => {
  limit('pw:' + c.user.id, 10, 15 * 60 * 1000);
  const b = await c.json();
  const u = q('SELECT * FROM users WHERE id = ?').get(c.user.id);
  if (u.pass !== NO_PASSWORD && !(await checkPassword(String(b.current || '').slice(0, 200), u.pass))) throw new HttpError(400, 'invalid_login');
  if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 200) throw new HttpError(400, 'weak_password');
  q('UPDATE users SET pass = ? WHERE id = ?').run(await hashPassword(b.next), u.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  startSession(c.req, c.res, u.id);
  return { ok: true };
});

route('GET', '/api/dashboard', async (c) => {
  const y = Number(c.query.get('year')) || Number(today().slice(0, 4));
  if (!Number.isInteger(y) || y < 2000 || y > 2100) bad('year: invalid');
  return buildDashboard(c.user, y);
});

route('POST', '/api/properties', async (c) => {
  const b = await c.json();
  const f = propFields(b);
  const u = c.user;
  if (q('SELECT COUNT(*) AS n FROM properties WHERE created_by = ?').get(u.id).n >= MAX_PROPERTIES_PER_USER) bad('properties: limit reached');
  let ownerUser = null, ownerContact = null, agentId = null;
  if (u.role === 'owner') {
    ownerUser = u.id;
    if (b.agent_code) agentId = findAgentByCode(u, b.agent_code).id;
  } else {
    agentId = u.id;
    if (b.contact_id) {
      const ct = q('SELECT * FROM contacts WHERE id = ? AND agent_id = ?').get(Number(b.contact_id), u.id);
      if (!ct) bad('owner: not found');
      ownerContact = ct.id; ownerUser = ct.user_id;
    } else if (b.new_contact && typeof b.new_contact === 'object') {
      const nc = clean({ name: V.str(1, 120), phone: V.str(0, 40), email: V.str(0, 160) }, b.new_contact);
      ownerContact = Number(q('INSERT INTO contacts (agent_id, name, phone, email, created_at) VALUES (?,?,?,?,?)').run(u.id, nc.name, nc.phone, nc.email, now()).lastInsertRowid);
    } else bad('owner: required');
  }
  const id = q(`INSERT INTO properties (name, type, owner_user_id, owner_contact_id, agent_id, created_by, address, emirate, area, lat, lng, maps_url, rent_annual, rent_period, next_inspection, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.name, f.type, ownerUser, ownerContact, agentId, u.id, f.address, f.emirate, f.area, f.lat, f.lng, f.maps_url, f.rent_annual, f.rent_period, f.next_inspection, f.notes, now()).lastInsertRowid;
  return { id: Number(id) };
});

route('GET', '/api/properties/:id', async (c) => {
  const { p, acc } = loadProperty(c.user, c.params.id);
  const ch = childrenOf(p.id);
  const T = today();
  for (const k of [...Object.keys(KINDS), 'files']) for (const r of ch[k]) r.can_delete = canDeleteRecord(c.user, acc, r);
  return { property: present(c.user, p, ch), summary: summarize(p, ch, T, Number(T.slice(0, 4))), today: T, ...ch };
});

route('PUT', '/api/properties/:id', async (c) => {
  const { p } = loadProperty(c.user, c.params.id);
  const f = propFields(await c.json());
  q(`UPDATE properties SET name=?, type=?, address=?, emirate=?, area=?, lat=?, lng=?, maps_url=?, rent_annual=?, rent_period=?, next_inspection=?, notes=? WHERE id=?`)
    .run(f.name, f.type, f.address, f.emirate, f.area, f.lat, f.lng, f.maps_url, f.rent_annual, f.rent_period, f.next_inspection, f.notes, p.id);
  return { ok: true };
});

route('DELETE', '/api/properties/:id', async (c) => {
  const { p, acc } = loadProperty(c.user, c.params.id);
  if (!canDeleteProperty(c.user, acc, p)) forbidden();
  const stored = q('SELECT stored FROM files WHERE property_id = ?').all(p.id);
  q('DELETE FROM properties WHERE id = ?').run(p.id);
  for (const s of stored) removeStored(s.stored);
  return { ok: true };
});

route('PUT', '/api/properties/:id/agent', async (c) => {
  const { p, acc } = loadProperty(c.user, c.params.id);
  if (acc !== 'owner') forbidden();
  const b = await c.json();
  const agentId = b.agent_code ? findAgentByCode(c.user, b.agent_code).id : null;
  q('UPDATE properties SET agent_id = ? WHERE id = ?').run(agentId, p.id);
  return { ok: true };
});

route('POST', '/api/properties/:id/' + KIND_RE, async (c) => {
  const { p } = loadProperty(c.user, c.params.id);
  const kind = c.params.kind;
  const body = await c.json();
  const f = kind === 'tenants' ? tenantFields(body) : clean(KINDS[kind], body);
  const keys = Object.keys(f);
  const id = q(`INSERT INTO ${kind} (property_id, ${keys.join(', ')}, created_by, created_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)`)
    .run(p.id, ...keys.map((k) => f[k]), c.user.id, now()).lastInsertRowid;
  let cheques = 0;
  if (kind === 'tenants') {
    for (const ch of chequeSchedule(f)) {
      q('INSERT INTO payments (property_id, due_date, amount, paid_date, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)').run(p.id, ch.due_date, ch.amount, null, ch.note, c.user.id, now());
      cheques++;
    }
  }
  return { id: Number(id), cheques_created: cheques };
});

function loadRecord(user, kind, id) {
  const rec = q(`SELECT * FROM ${kind} WHERE id = ?`).get(Number(id));
  if (!rec) notFound();
  const { p, acc } = loadProperty(user, rec.property_id);
  return { rec, p, acc };
}

route('PUT', '/api/records/' + KIND_RE + '/:id', async (c) => {
  const kind = c.params.kind;
  const { rec } = loadRecord(c.user, kind, c.params.id);
  const body = await c.json();
  const f = kind === 'tenants' ? tenantFields({ ...body, cheques: rec.cheques }) : clean(KINDS[kind], body);
  const keys = Object.keys(f);
  q(`UPDATE ${kind} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), rec.id);
  return { ok: true };
});

route('DELETE', '/api/records/' + KIND_RE + '/:id', async (c) => {
  const kind = c.params.kind;
  const { rec, acc } = loadRecord(c.user, kind, c.params.id);
  if (!canDeleteRecord(c.user, acc, rec)) forbidden();
  if (kind === 'maintenance') q('UPDATE files SET maintenance_id = NULL WHERE maintenance_id = ?').run(rec.id);
  q(`DELETE FROM ${kind} WHERE id = ?`).run(rec.id);
  return { ok: true };
});

route('POST', '/api/reminders/:id/done', async (c) => {
  const { rec } = loadRecord(c.user, 'reminders', c.params.id);
  const b = await c.json();
  const f = clean({ date: V.date(true), cost: V.money(false), contractor: V.str(0, 160) }, b);
  q('INSERT INTO maintenance (property_id, date, title, contractor, cost, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(rec.property_id, f.date, rec.title, f.contractor, f.cost, '', c.user.id, now());
  q('UPDATE reminders SET next_due = ? WHERE id = ?').run(addMonths(f.date, rec.interval_months), rec.id);
  return { ok: true };
});

route('GET', '/api/records/(?<kind>tenants|payments|maintenance|reminders|expenses|files)', async (c) => {
  const kind = c.params.kind;
  const rows = [];
  for (const p of accessibleProperties(c.user)) {
    const acc = accessOf(c.user, p);
    const list = kind === 'files'
      ? q('SELECT id, property_id, kind, doc_type, name, mime, size, maintenance_id, created_by, created_at FROM files WHERE property_id = ? ORDER BY id DESC').all(p.id)
      : q(`SELECT * FROM ${kind} WHERE property_id = ? ORDER BY ${ORDER[kind]}`).all(p.id);
    for (const r of list) rows.push({ ...r, ...(kind === 'tenants' ? { duration_months: monthsBetween(r.contract_start, r.contract_end) } : {}), property_name: p.name, can_delete: canDeleteRecord(c.user, acc, r) });
  }
  return { today: today(), rows };
});

route('POST', '/api/properties/:id/files', async (c) => {
  const { p } = loadProperty(c.user, c.params.id);
  limit('upload:' + c.user.id, 120, 60 * 60 * 1000);
  const kind = V.one(['photo', 'document'])(c.query.get('kind'), 'kind');
  const docType = kind === 'document' ? V.one(['contract', 'invoice', 'warranty', 'deed', 'other'], 'other')(c.query.get('doc_type') || '', 'doc_type') : null;
  const name = (V.str(0, 120)(c.query.get('name') || '', 'name').replace(/[\\/:*?"<>|]/g, '_')) || 'file';
  let maintenanceId = null;
  if (c.query.get('maintenance_id')) {
    const m = q('SELECT id FROM maintenance WHERE id = ? AND property_id = ?').get(Number(c.query.get('maintenance_id')), p.id);
    if (!m) bad('maintenance_id: not found');
    maintenanceId = m.id;
  }
  if (q('SELECT COUNT(*) AS n FROM files WHERE property_id = ?').get(p.id).n >= MAX_FILES_PER_PROPERTY) bad('files: limit reached for this property');
  const buf = await c.raw(MAX_FILE);
  const used = q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE created_by = ?').get(c.user.id).n;
  if (used + buf.length > MAX_USER_STORAGE) throw new HttpError(413, 'storage_full');
  const mime = sniff(buf);
  const okTypes = kind === 'photo' ? ['image/jpeg', 'image/png', 'image/webp'] : ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!mime || !okTypes.includes(mime)) throw new HttpError(415, 'file_type');
  const stored = crypto.randomBytes(16).toString('hex');
  await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), buf, { flag: 'wx', mode: 0o600 });
  const id = q('INSERT INTO files (property_id, kind, doc_type, name, mime, size, stored, maintenance_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(p.id, kind, docType, name, mime, buf.length, stored, maintenanceId, c.user.id, now()).lastInsertRowid;
  return { id: Number(id) };
});

function loadFile(user, id) {
  const f = q('SELECT * FROM files WHERE id = ?').get(Number(id));
  if (!f) notFound();
  const { acc } = loadProperty(user, f.property_id);
  return { f, acc };
}
route('GET', '/api/files/:id', async (c) => {
  const { f } = loadFile(c.user, c.params.id);
  const full = path.join(UPLOAD_DIR, f.stored);
  if (!/^[a-f0-9]{32}$/.test(f.stored) || !fs.existsSync(full)) notFound();
  const inline = f.mime.startsWith('image/');
  c.res.writeHead(200, {
    'Content-Type': f.mime, 'Content-Length': f.size, 'Cache-Control': 'private, max-age=600',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  fs.createReadStream(full).on('error', () => c.res.destroy()).pipe(c.res);
  return undefined;
});
route('DELETE', '/api/files/:id', async (c) => {
  const { f, acc } = loadFile(c.user, c.params.id);
  if (!canDeleteRecord(c.user, acc, f)) forbidden();
  q('DELETE FROM files WHERE id = ?').run(f.id);
  removeStored(f.stored);
  return { ok: true };
});

// Agent's client list (owners they act for)
const agentOnly = (c) => { if (c.user.role !== 'agent') forbidden(); };
route('GET', '/api/contacts', async (c) => {
  agentOnly(c);
  return q(`SELECT c.id, c.name, c.phone, c.email, c.claim_code, c.user_id IS NOT NULL AS linked,
    (SELECT COUNT(*) FROM properties p WHERE p.owner_contact_id = c.id AND p.agent_id = c.agent_id) AS properties
    FROM contacts c WHERE c.agent_id = ? ORDER BY c.name`).all(c.user.id);
});
route('POST', '/api/contacts', async (c) => {
  agentOnly(c);
  const f = clean({ name: V.str(1, 120), phone: V.str(0, 40), email: V.str(0, 160) }, await c.json());
  return { id: Number(q('INSERT INTO contacts (agent_id, name, phone, email, created_at) VALUES (?,?,?,?,?)').run(c.user.id, f.name, f.phone, f.email, now()).lastInsertRowid) };
});
route('POST', '/api/contacts/:id/code', async (c) => {
  agentOnly(c);
  const ct = q('SELECT * FROM contacts WHERE id = ? AND agent_id = ?').get(Number(c.params.id), c.user.id);
  if (!ct) notFound();
  if (ct.user_id) bad('owner: already linked');
  const code = randomCode(10);
  q('UPDATE contacts SET claim_code = ? WHERE id = ?').run(code, ct.id);
  return { code };
});
route('DELETE', '/api/contacts/:id', async (c) => {
  agentOnly(c);
  const ct = q('SELECT * FROM contacts WHERE id = ? AND agent_id = ?').get(Number(c.params.id), c.user.id);
  if (!ct) notFound();
  if (q('SELECT 1 AS x FROM properties WHERE owner_contact_id = ? LIMIT 1').get(ct.id)) bad('owner: has properties');
  q('DELETE FROM contacts WHERE id = ?').run(ct.id);
  return { ok: true };
});
// Owner links their account to an agent's client record using a one-time code from the agent.
route('POST', '/api/claim', async (c) => {
  if (c.user.role !== 'owner') forbidden();
  limit('claim:' + c.user.id, 10, 60 * 60 * 1000);
  const code = String((await c.json()).code || '').trim().toUpperCase();
  const ct = code.length === 10 ? q('SELECT * FROM contacts WHERE claim_code = ? AND user_id IS NULL').get(code) : null;
  if (!ct) throw new HttpError(400, 'invalid_code');
  q('UPDATE contacts SET user_id = ?, claim_code = NULL WHERE id = ?').run(c.user.id, ct.id);
  const n = q('UPDATE properties SET owner_user_id = ? WHERE owner_contact_id = ? AND owner_user_id IS NULL').run(c.user.id, ct.id).changes;
  return { properties: Number(n) };
});

route('POST', '/api/resolve-location', async (c) => {
  limit('loc:' + c.user.id, 40, 60 * 1000);
  const text = V.str(1, 2000)((await c.json()).text, 'text');
  try {
    const r = await resolveLocation(text);
    return { lat: Math.round(r.lat * 1e7) / 1e7, lng: Math.round(r.lng * 1e7) / 1e7, source: r.source };
  } catch (e) {
    if (e instanceof LocationError) throw new HttpError(422, e.code);
    throw e;
  }
});

// ---------- http plumbing ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function readBody(req, max) {
  return new Promise((ok, no) => {
    if (Number(req.headers['content-length'] || 0) > max) { req.resume(); return no(new HttpError(413, 'file_too_large')); }
    const chunks = [];
    let n = 0, failed = false;
    req.on('data', (ch) => {
      if (failed) return;
      n += ch.length;
      if (n > max) { failed = true; no(new HttpError(413, 'file_too_large')); req.resume(); } else chunks.push(ch);
    });
    req.on('end', () => { if (!failed) ok(Buffer.concat(chunks)); });
    req.on('error', no);
  });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    if (url.pathname === '/auth/google' || url.pathname === '/auth/google/callback') return googleAuth(req, res, url);
    return serveStatic(req, res, url.pathname);
  }
  if (req.method !== 'GET') {
    // CSRF: a custom header cannot be sent cross-site without CORS (which is never granted), plus an Origin check.
    if (req.headers['x-requested-with'] !== 'amlaki') forbidden();
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.headers.host) forbidden();
    }
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const user = currentUser(req);
    if (!r.opts.public && !user) throw new HttpError(401, 'login_required');
    const ctx = {
      req, res, user, params: m.groups || {}, query: url.searchParams, ip: clientIp(req),
      raw: (max) => readBody(req, max),
      json: async () => {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) bad('body: JSON expected');
        let data;
        try { data = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}'); } catch (e) { if (e instanceof HttpError) throw e; bad('body: invalid JSON'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) bad('body: object expected');
        return data;
      },
    };
    const out = await r.handler(ctx);
    if (out !== undefined) sendJson(res, 200, out);
    return;
  }
  throw new HttpError(404, 'not_found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code });
    console.error('Unexpected error:', e);
    sendJson(res, 500, { error: 'server_error' });
  });
});
server.requestTimeout = 60000;
server.headersTimeout = 20000;

if (require.main === module) {
  server.listen(PORT, () => console.log(`Amlaki running on http://localhost:${PORT}`));
}
module.exports = { server, addMonths };
