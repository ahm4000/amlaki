'use strict';
// End-to-end tests against a real running server with a temporary database.
// Run: node test/api.test.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCoords, resolveLocation, allowedUrl } = require('../lib/location');
const { startFakeGoogle } = require('./fake-google');
const GID = 'test-client-id.apps.googleusercontent.com';

const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'amlaki-test-'));
const results = [];
let group = '';
function check(name, cond, detail) {
  results.push({ group, name, ok: !!cond, detail });
  if (!cond) console.log('  FAIL', group, '-', name, detail !== undefined ? JSON.stringify(detail) : '');
}
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (!opt.noCsrf) headers['x-requested-with'] = 'amlaki';
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (opt.raw) { payload = opt.raw; headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { this.setCookie = set; this.cookie = set.split(';')[0]; }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u) { return this.req('DELETE', u); }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function main() {
  const google = await startFakeGoogle(GID);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FAKE_TODAY: '2026-11-13', MAX_USER_STORAGE_MB: '1', NODE_NO_WARNINGS: '1',
      GOOGLE_CLIENT_ID: GID, GOOGLE_CLIENT_SECRET: 'test-secret', OAUTH_TEST_AUTH_URL: google.authUrl, OAUTH_TEST_TOKEN_URL: google.tokenUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((ok, no) => { server.stdout.on('data', (d) => { if (String(d).includes('running')) ok(); }); server.on('exit', () => no(new Error('server exited: ' + serverErr))); setTimeout(() => no(new Error('server start timeout')), 8000); });

  try {
    const A = new Client(), B = new Client(), X = new Client(), Y = new Client(), anon = new Client();

    group = 'Sign-up and login';
    let r = await A.post('/api/signup', { email: 'OwnerA@example.com', name: 'Ahmed Owner', password: 'correct horse 1', role: 'owner' });
    check('owner A signs up', r.status === 200 && r.json.role === 'owner' && r.json.email === 'ownera@example.com', r.json);
    check('session cookie is HttpOnly and SameSite=Strict', /HttpOnly/.test(A.setCookie) && /SameSite=Strict/.test(A.setCookie), A.setCookie);
    check('password hash is never returned', !/scrypt|"pass"/.test(r.text));
    r = await B.post('/api/signup', { email: 'ownerb@example.com', name: 'Badr Owner', password: 'another pass 2', role: 'owner' });
    check('owner B signs up', r.status === 200);
    r = await X.post('/api/signup', { email: 'agentx@example.com', name: 'Xavier Agent', password: 'agent pass x1', role: 'agent' });
    check('agent X signs up and gets an agent code', r.status === 200 && /^[A-Z2-9]{8}$/.test(r.json.agent_code), r.json);
    const codeX = r.json.agent_code;
    r = await Y.post('/api/signup', { email: 'agenty@example.com', name: 'Yara Agent', password: 'agent pass y1', role: 'agent' });
    const codeY = r.json.agent_code;
    check('agent Y signs up', r.status === 200);
    r = await anon.post('/api/signup', { email: 'ownera@example.com', name: 'Dup', password: 'whatever 123', role: 'owner' });
    check('duplicate email is refused', r.status === 409 && r.json.error === 'email_taken');
    r = await anon.post('/api/signup', { email: 'weak@example.com', name: 'Weak', password: 'short', role: 'owner' });
    check('short password is refused', r.status === 400 && r.json.error === 'weak_password');
    r = await anon.post('/api/signup', { email: 'admin@example.com', name: 'Adm', password: 'long enough 1', role: 'admin' });
    check('unknown role is refused', r.status === 400);
    r = await anon.post('/api/login', { email: 'ownera@example.com', password: 'wrong password' });
    check('wrong password is refused', r.status === 401 && r.json.error === 'invalid_login');
    r = await anon.post('/api/login', { email: 'nobody@example.com', password: 'wrong password' });
    check('unknown email gives the same error as wrong password', r.status === 401 && r.json.error === 'invalid_login');
    const A2 = new Client();
    r = await A2.post('/api/login', { email: 'ownera@example.com', password: 'correct horse 1' });
    check('owner A logs in on a second device', r.status === 200);
    r = await anon.get('/api/dashboard');
    check('dashboard requires login', r.status === 401);
    r = await anon.get('/api/me');
    check('/api/me requires login', r.status === 401);

    group = 'Request forgery protection';
    r = await A.req('POST', '/api/properties', { name: 'CSRF' }, { noCsrf: true });
    check('write without the custom header is refused', r.status === 403);
    r = await A.req('POST', '/api/properties', { name: 'CSRF' }, { headers: { origin: 'https://evil.example' } });
    check('write from another origin is refused', r.status === 403);
    r = await A.req('POST', '/api/properties', undefined, { raw: Buffer.from('name=x'), headers: {} });
    check('non-JSON body is refused', r.status === 400);

    group = 'Add property and records (owner)';
    const mk = async (client, body) => (await client.post('/api/properties', body));
    r = await mk(A, { name: 'Villa 12', type: 'villa', emirate: 'Ras Al Khaimah', area: 'Al Dhait', rent_amount: 150000, rent_period: 'annual', lat: 25.7891, lng: 55.9432, next_inspection: '2026-12-01', notes: 'Corner plot' });
    check('owner creates Villa 12', r.status === 200 && r.json.id > 0, r.json);
    const v12 = r.json.id;
    const v7 = (await mk(A, { name: 'Villa 7', type: 'villa', area: 'Khuzam', rent_amount: 130000 })).json.id;
    const a302 = (await mk(A, { name: 'Apartment 302', type: 'apartment', area: 'Al Nakheel', rent_amount: 60000 })).json.id;
    const a105 = (await mk(A, { name: 'Apartment 105', type: 'apartment', area: 'Al Nakheel', rent_amount: 5000, rent_period: 'monthly' })).json.id;
    const shop = (await mk(A, { name: 'Shop 3', type: 'shop', area: 'Al Seer', rent_amount: 80000 })).json.id;
    r = await A.get('/api/properties/' + a105);
    check('monthly rent 5,000 is stored as 60,000 a year', r.json.property.rent_annual === 60000 && r.json.property.rent_period === 'monthly', r.json.property);
    const pay = (pid, due, amount, paid) => A.post('/api/properties/' + pid + '/payments', { due_date: due, amount, paid_date: paid || '' });
    await pay(v12, '2026-03-01', 37000, '2026-03-01'); await pay(v12, '2026-06-01', 37000, '2026-06-03'); await pay(v12, '2026-09-01', 38000, '2026-09-01');
    const v12due = (await pay(v12, '2026-11-20', 38000)).json.id;
    await pay(v7, '2026-01-10', 65000, '2026-01-10'); await pay(v7, '2026-07-10', 65000, '2026-07-10');
    await pay(a302, '2026-05-01', 30000, '2026-05-01'); await pay(a302, '2026-11-01', 30000);
    for (const m of ['01', '04', '07', '10']) await pay(a105, `2026-${m}-05`, 15000, `2026-${m}-05`);
    await pay(shop, '2026-04-15', 40000, '2026-04-15'); await pay(shop, '2026-10-15', 40000, '2026-10-15');
    await pay(v12, '2025-12-01', 9999, '2025-12-01');   // last year: must not count
    await pay(v12, '2027-03-01', 40000);                // next year: must not count as outstanding
    const ten = (pid, name, s, e) => A.post('/api/properties/' + pid + '/tenants', { name, contract_start: s, contract_end: e, annual_rent: 1 });
    await ten(v12, 'Tenant One', '2026-03-01', '2027-02-28'); await ten(v7, 'Tenant Two', '2026-01-16', '2027-01-15');
    await ten(a302, 'Tenant Three', '2026-05-01', '2027-04-30'); await ten(a105, 'Tenant Four', '2026-01-05', '2027-01-04');
    await ten(shop, 'Old Tenant', '2024-01-01', '2025-06-30');
    const mnt = (pid, date, title, cost) => A.post('/api/properties/' + pid + '/maintenance', { date, title, cost, contractor: 'Cool Air LLC' });
    await mnt(v12, '2026-02-12', 'Repainting', 7500); await mnt(v12, '2026-05-25', 'AC service', 1000); await mnt(v7, '2026-08-10', 'Roof repair', 22700);
    await mnt(v7, '2025-08-10', 'Old job', 5000);       // last year
    const exp = (pid, date, category, amount) => A.post('/api/properties/' + pid + '/expenses', { date, category, amount });
    await exp(a302, '2026-01-15', 'service', 9000); await exp(a105, '2026-01-15', 'service', 12000); await exp(shop, '2026-06-01', 'other', 6200);
    const rem = (await A.post('/api/properties/' + v12 + '/reminders', { title: 'AC service', interval_months: 6, next_due: '2026-11-25' })).json.id;
    await A.post('/api/properties/' + a302 + '/reminders', { title: 'Water tank cleaning', interval_months: 6, next_due: '2026-12-05' });
    await A.post('/api/properties/' + shop + '/reminders', { title: 'Far away', interval_months: 12, next_due: '2027-06-01' });

    group = 'Calculations (checked against hand-calculated figures)';
    r = await A.get('/api/dashboard?year=2026');
    const T = r.json.totals;
    check('total properties = 5', T.properties === 5, T);
    check('occupied = 4, vacant = 1', T.occupied === 4 && T.vacant === 1, T);
    check('expected rent = 480,000', T.expected === 480000, T.expected);
    check('rent received = 412,000', T.received === 412000, T.received);
    check('outstanding rent = 68,000', T.outstanding === 68000, T.outstanding);
    check('overdue rent = 30,000', T.overdue === 30000, T.overdue);
    check('expenses = 58,400', T.expenses === 58400, T.expenses);
    check('net profit = 353,600', T.net === 353600, T.net);
    check('collected = 86%', T.collected_pct === 86, T.collected_pct);
    check('expense split = 31,200 / 21,000 / 6,200', r.json.byCategory.maintenance === 31200 && r.json.byCategory.service === 21000 && r.json.byCategory.other === 6200, r.json.byCategory);
    check('monthly income adds up to the total', r.json.monthly.reduce((a, m) => a + m.income, 0) === 412000 && r.json.monthly[0].income === 80000 && r.json.monthly[6].income === 80000);
    check('monthly expenses add up to the total', Math.round(r.json.monthly.reduce((a, m) => a + m.expenses, 0)) === 58400);
    const st = Object.fromEntries(r.json.properties.map((p) => [p.name, p.summary.status]));
    check('statuses: rented / renewal / overdue / rented / vacant', st['Villa 12'] === 'rented' && st['Villa 7'] === 'renewal' && st['Apartment 302'] === 'overdue' && st['Apartment 105'] === 'renewal' && st['Shop 3'] === 'vacant', st);
    const calV12 = r.json.calendar.find((c) => c.name === 'Villa 12').months;
    check('rent calendar marks paid, due and empty months', calV12[2].status === 'paid' && calV12[2].amount === 37000 && calV12[10].status === 'due' && calV12[0] === null, calV12);
    const calA302 = r.json.calendar.find((c) => c.name === 'Apartment 302').months;
    check('rent calendar marks the overdue month', calA302[10].status === 'overdue');
    r = await A.get('/api/properties/' + v12);
    check('per-property: received 112,000, expenses 8,500, net 103,500', r.json.summary.received === 112000 && r.json.summary.expenses === 8500 && r.json.summary.net === 103500, r.json.summary);

    group = 'Reminders';
    r = await A.get('/api/dashboard?year=2026');
    const att = r.json.attention;
    const has = (type, name, days) => att.some((a) => a.type === type && a.property_name === name && a.days === days);
    check('overdue rent shows as 12 days late', has('rent_overdue', 'Apartment 302', -12), att);
    check('rent due in 7 days is listed', has('rent_due', 'Villa 12', 7));
    check('AC service due in 12 days is listed', has('maintenance', 'Villa 12', 12));
    check('water tank cleaning due in 22 days is listed', has('maintenance', 'Apartment 302', 22));
    check('contract ending in 63 days is listed', has('contract', 'Villa 7', 63));
    check('inspection due in 18 days is listed', has('inspection', 'Villa 12', 18));
    check('far-away items are not listed', !att.some((a) => a.title === 'Far away') && !att.some((a) => a.type === 'contract' && a.property_name === 'Villa 12'));
    check('items are sorted by date', att.every((a, i) => i === 0 || att[i - 1].date <= a.date));
    r = await A.post('/api/reminders/' + rem + '/done', { date: '2026-11-24', cost: 1000, contractor: 'Cool Air LLC' });
    const after = (await A.get('/api/properties/' + v12)).json;
    check('marking a reminder done logs maintenance and moves it 6 months on', r.status === 200 && after.reminders[0].next_due === '2027-05-24' && after.maintenance.some((m) => m.date === '2026-11-24' && m.cost === 1000), after.reminders);

    group = 'Rent duration and cheques';
    const durProp = (await mk(A, { name: 'Duration Test', type: 'villa' })).json.id;
    const addTen = (b) => A.post('/api/properties/' + durProp + '/tenants', { name: 'Dura Tenant', ...b });
    const pays = async () => (await A.get('/api/properties/' + durProp)).json.payments;
    r = await addTen({ contract_start: '2027-03-01', duration_months: 12, annual_rent: 120000, cheques: 4 });
    let dp = (await A.get('/api/properties/' + durProp)).json;
    check('a 12-month duration from 1 Mar 2027 sets the end date to 29 Feb 2028', r.status === 200 && dp.tenants[0].contract_end === '2028-02-29' && dp.tenants[0].duration_months === 12 && dp.tenants[0].cheques === 4, dp.tenants[0]);
    check('four cheques of 30,000 are expected on 1 Mar, 1 Jun, 1 Sep and 1 Dec', r.json.cheques_created === 4 && dp.payments.map((x) => x.due_date + ':' + x.amount).join(' ') === '2027-03-01:30000 2027-06-01:30000 2027-09-01:30000 2027-12-01:30000', dp.payments);
    check('each expected cheque is unpaid and labelled', dp.payments.every((x, i) => x.paid_date === null && x.note === `Cheque ${i + 1} of 4`));
    for (const x of dp.payments) await A.del('/api/records/payments/' + x.id);
    r = await addTen({ contract_start: '2029-01-15', contract_end: '2030-01-14', annual_rent: 100000, cheques: 3 });
    let ps = await pays();
    check('an uneven split adds up exactly (33,333.33 + 33,333.33 + 33,333.34)', ps.map((x) => x.amount).join(' ') === '33333.33 33333.33 33333.34' && ps.map((x) => x.due_date).join(' ') === '2029-01-15 2029-05-15 2029-09-15', ps);
    for (const x of ps) await A.del('/api/records/payments/' + x.id);
    r = await addTen({ contract_start: '2031-05-01', contract_end: '2031-10-31', annual_rent: 60000, cheques: 2 });
    ps = await pays();
    check('a 6-month contract at 60,000 a year expects 2 cheques of 15,000, three months apart', ps.map((x) => x.due_date + ':' + x.amount).join(' ') === '2031-05-01:15000 2031-08-01:15000' && (await A.get('/api/properties/' + durProp)).json.tenants[0].duration_months === 6, ps);
    for (const x of ps) await A.del('/api/records/payments/' + x.id);
    r = await addTen({ contract_start: '2033-01-01', duration_months: 12, annual_rent: 50000, cheques: 0 });
    check('choosing no cheques creates none', r.json.cheques_created === 0 && (await pays()).length === 0);
    r = await addTen({ contract_start: '2034-01-01', duration_months: 12, cheques: 4 });
    check('no rent amount means no cheques are created', r.json.cheques_created === 0 && (await pays()).length === 0);
    r = await addTen({ contract_start: '2035-01-31', duration_months: 1, annual_rent: 12000, cheques: 1 });
    ps = await pays();
    check('a 1-month contract from 31 Jan ends on 27 Feb with one cheque of 1,000', (await A.get('/api/properties/' + durProp)).json.tenants[0].contract_end === '2035-02-27' && ps.length === 1 && ps[0].amount === 1000, ps);
    const tenId = (await A.get('/api/properties/' + durProp)).json.tenants[0].id;
    r = await A.put('/api/records/tenants/' + tenId, { name: 'Renamed', contract_start: '2035-01-31', contract_end: '2035-12-31', annual_rent: 12000, cheques: 12 });
    dp = (await A.get('/api/properties/' + durProp)).json;
    check('editing a contract does not create more cheques', r.status === 200 && dp.payments.length === 1 && dp.tenants[0].name === 'Renamed' && dp.tenants[0].cheques === 1 && dp.tenants[0].duration_months === 11, dp.tenants[0]);
    check('a contract needs an end date or a duration', (await addTen({ contract_start: '2036-01-01' })).status === 400);
    check('a duration of 0 or 500 months is refused', (await addTen({ contract_start: '2036-01-01', duration_months: 0 })).status === 400 && (await addTen({ contract_start: '2036-01-01', duration_months: 500 })).status === 400);
    check('99 cheques is refused', (await addTen({ contract_start: '2036-01-01', duration_months: 12, annual_rent: 1000, cheques: 99 })).status === 400);
    for (const x of await pays()) await A.del('/api/records/payments/' + x.id);
    const quick = (b) => A.post('/api/properties/' + durProp + '/cheques', b);
    r = await quick({ total: 80000, count: 4, first_date: '2026-11-01', preview: true });
    check('quick cheques preview: 80,000 in 4 cheques = 20,000 every 3 months', r.status === 200 && r.json.created === 0 && r.json.cheques.map((x) => x.due_date + ':' + x.amount).join(' ') === '2026-11-01:20000 2027-02-01:20000 2027-05-01:20000 2027-08-01:20000', r.json);
    check('a preview saves nothing', (await pays()).length === 0);
    r = await quick({ total: 80000, count: 4, first_date: '2026-11-01' });
    ps = await pays();
    check('quick cheques creates the four unpaid payments', r.json.created === 4 && ps.length === 4 && ps.every((x, i) => x.amount === 20000 && x.paid_date === null && x.note === `Cheque ${i + 1} of 4`));
    for (const x of ps) await A.del('/api/records/payments/' + x.id);
    r = await quick({ total: 60000, count: 12, first_date: '2027-01-31', preview: true });
    check('12 cheques are monthly, and month-end dates stay valid', r.json.cheques.length === 12 && r.json.cheques.every((x) => x.amount === 5000) && r.json.cheques[1].due_date === '2027-02-28' && r.json.cheques[2].due_date === '2027-03-31' && r.json.cheques[11].due_date === '2027-12-31', r.json.cheques.map((x) => x.due_date));
    r = await quick({ total: 100000, count: 3, first_date: '2027-01-01', preview: true });
    check('3 cheques are every 4 months and add up exactly', r.json.cheques.map((x) => x.due_date + ':' + x.amount).join(' ') === '2027-01-01:33333.33 2027-05-01:33333.33 2027-09-01:33333.34');
    r = await quick({ total: 30000, count: 2, first_date: '2027-01-01', months: 6, preview: true });
    check('a 6-month period with 2 cheques spaces them 3 months apart', r.json.cheques.map((x) => x.due_date).join(' ') === '2027-01-01 2027-04-01');
    check('quick cheques refuses a zero total, zero cheques or a bad date', (await quick({ total: 0, count: 4, first_date: '2027-01-01' })).status === 400 && (await quick({ total: 1000, count: 0, first_date: '2027-01-01' })).status === 400 && (await quick({ total: 1000, count: 4, first_date: '2027-02-30' })).status === 400 && (await quick({ total: 1000, count: 99, first_date: '2027-01-01' })).status === 400);
    r = await quick({ items: [{ due_date: '2027-01-10', amount: 25000 }, { due_date: '2027-04-20', amount: 15000.5 }, { due_date: '2027-09-01', amount: 40000 }] });
    ps = await pays();
    check('adjusted cheques are saved with exactly the dates and amounts entered', r.json.created === 3 && ps.map((x) => x.due_date + ':' + x.amount + ':' + x.note).join(' | ') === '2027-01-10:25000:Cheque 1 of 3 | 2027-04-20:15000.5:Cheque 2 of 3 | 2027-09-01:40000:Cheque 3 of 3', ps);
    for (const x of ps) await A.del('/api/records/payments/' + x.id);
    check('one bad adjusted cheque stops the whole batch', (await quick({ items: [{ due_date: '2027-01-10', amount: 100 }, { due_date: '2027-13-01', amount: 100 }] })).status === 400 && (await quick({ items: [{ due_date: '2027-01-10', amount: 0 }] })).status === 400 && (await quick({ items: [] })).status === 400 && (await quick({ items: Array.from({ length: 25 }, () => ({ due_date: '2027-01-10', amount: 1 })) })).status === 400 && (await pays()).length === 0);
    check('another owner cannot create cheques on this property', (await B.post('/api/properties/' + durProp + '/cheques', { total: 1000, count: 2, first_date: '2027-01-01' })).status === 404 && (await pays()).length === 0);
    r = await A.get('/api/properties/' + v12);
    check('existing contracts show their duration (1 Mar 2026 to 28 Feb 2027 = 12 months)', r.json.tenants[0].duration_months === 12 && r.json.summary.contract.months === 12 && r.json.summary.contract.end === '2027-02-28');
    check('contract durations appear in the all-tenants list', (await A.get('/api/records/tenants')).json.rows.every((x) => x.duration_months >= 1));
    await A.del('/api/properties/' + durProp);

    group = 'Upgrade from the previous version';
    {
      const { DatabaseSync } = require('node:sqlite');
      const D3 = fs.mkdtempSync(path.join(os.tmpdir(), 'amlaki-old-')), P3 = PORT + 2;
      const old = new DatabaseSync(path.join(D3, 'app.db'));
      old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','agent')), pass TEXT NOT NULL, agent_code TEXT UNIQUE, created_at TEXT NOT NULL);
        CREATE TABLE properties (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, owner_user_id INTEGER, owner_contact_id INTEGER, agent_id INTEGER, created_by INTEGER NOT NULL, address TEXT, emirate TEXT, area TEXT, lat REAL, lng REAL, maps_url TEXT, rent_annual REAL NOT NULL DEFAULT 0, rent_period TEXT NOT NULL DEFAULT 'annual', next_inspection TEXT, notes TEXT, created_at TEXT NOT NULL);
        CREATE TABLE tenants (id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE, name TEXT NOT NULL, phone TEXT, email TEXT, contract_start TEXT NOT NULL, contract_end TEXT NOT NULL, annual_rent REAL NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at TEXT NOT NULL);`);
      old.close();
      const env3 = { ...process.env, PORT: String(P3), DATA_DIR: D3, FAKE_TODAY: '2026-11-13', NODE_NO_WARNINGS: '1' };
      const run = () => new Promise((ok) => { const pr = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: env3, stdio: ['ignore', 'pipe', 'ignore'] }); pr.stdout.on('data', (d) => { if (String(d).includes('running')) ok(pr); }); setTimeout(() => ok(pr), 5000); });
      const call = async (cl, m, u, b2) => { const res = await fetch('http://127.0.0.1:' + P3 + u, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'amlaki', cookie: cl.cookie || '' }, body: b2 ? JSON.stringify(b2) : undefined }); const sc = res.headers.get('set-cookie'); if (sc) cl.cookie = sc.split(';')[0]; return { status: res.status, json: await res.json().catch(() => null) }; };
      let pr = await run();
      const U = {};
      const su = await call(U, 'POST', '/api/signup', { email: 'old@example.com', name: 'Old User', password: 'old password 1', role: 'owner' });
      const op = (await call(U, 'POST', '/api/properties', { name: 'Old Villa', type: 'villa', rent_amount: 1000 })).json.id;
      const ot = await call(U, 'POST', '/api/properties/' + op + '/tenants', { name: 'Old Tenant', contract_start: '2026-01-01', contract_end: '2026-12-31' });
      pr.kill(); await new Promise((ok) => setTimeout(ok, 300));
      pr = await run();   // second start on the already-upgraded database
      const again = await call(U, 'GET', '/api/properties/' + op);
      pr.kill(); fs.rmSync(D3, { recursive: true, force: true });
      check('a database from the previous version is upgraded and works', su.status === 200 && ot.status === 200);
      check('data survives a restart after the upgrade', again.status === 200 && again.json.tenants[0].name === 'Old Tenant' && again.json.tenants[0].duration_months === 12 && again.json.tenants[0].cheques === 0, again.json);
    }

    group = 'Validation';
    r = await A.post('/api/properties/' + v12 + '/payments', { due_date: '2026-02-31', amount: 100 });
    check('impossible date is refused', r.status === 400);
    r = await A.post('/api/properties/' + v12 + '/payments', { due_date: '2026-02-01', amount: -5 });
    check('negative amount is refused', r.status === 400);
    r = await A.post('/api/properties/' + v12 + '/tenants', { name: 'T', contract_start: '2026-05-01', contract_end: '2026-04-01' });
    check('contract ending before it starts is refused', r.status === 400);
    r = await mk(A, { name: '', type: 'villa' });
    check('property without a name is refused', r.status === 400);
    r = await mk(A, { name: 'Bad', type: 'castle' });
    check('unknown property type is refused', r.status === 400);
    r = await mk(A, { name: 'Bad', lat: 250, lng: 10 });
    check('out-of-range coordinates are refused', r.status === 400);
    const evil = '<img src=x onerror=alert(1)>\'; DROP TABLE users;--';
    r = await mk(A, { name: evil, notes: evil });
    const evilId = r.json.id;
    r = await A.get('/api/properties/' + evilId);
    check('script and SQL text is stored as plain text', r.status === 200 && r.json.property.name === evil && /application\/json/.test(r.headers.get('content-type')));
    check('database still works after SQL-looking input', (await A.get('/api/me')).status === 200);
    await A.del('/api/properties/' + evilId);
    r = await A.req('POST', '/api/properties/' + v12 + '/users', { email: 'x' });
    check('unknown record kind is not routed', r.status === 404);
    r = await A.get('/api/properties/1%20OR%201=1');
    check('non-numeric id is not routed', r.status === 404);

    group = 'Permissions: owners are isolated';
    r = await B.get('/api/dashboard');
    check('owner B sees no properties', r.json.totals.properties === 0 && r.json.properties.length === 0);
    check('owner B cannot open owner A\'s property (by direct address)', (await B.get('/api/properties/' + v12)).status === 404);
    check('owner B cannot edit it', (await B.put('/api/properties/' + v12, { name: 'Hacked' })).status === 404);
    check('owner B cannot delete it', (await B.del('/api/properties/' + v12)).status === 404);
    check('owner B cannot add a payment to it', (await B.post('/api/properties/' + v12 + '/payments', { due_date: '2026-01-01', amount: 1 })).status === 404);
    check('owner B cannot edit its payment', (await B.put('/api/records/payments/' + v12due, { due_date: '2026-01-01', amount: 1 })).status === 404);
    check('owner B cannot delete its payment', (await B.del('/api/records/payments/' + v12due)).status === 404);
    check('owner B cannot mark its reminder done', (await B.post('/api/reminders/' + rem + '/done', { date: '2026-11-24' })).status === 404);
    check('owner B cannot assign an agent to it', (await B.put('/api/properties/' + v12 + '/agent', { agent_code: codeX })).status === 404);
    check('owner B sees none of A\'s payments in lists', (await B.get('/api/records/payments')).json.rows.length === 0);

    group = 'Permissions: agents';
    check('unassigned agent cannot open the property', (await X.get('/api/properties/' + v12)).status === 404);
    check('unassigned agent cannot edit the property', (await X.put('/api/properties/' + v12, { name: 'Hacked' })).status === 404);
    check('unassigned agent sees an empty dashboard', (await X.get('/api/dashboard')).json.properties.length === 0);
    check('owners cannot use agent-only pages', (await A.get('/api/contacts')).status === 403);
    check('agents cannot use the owner link-code page', (await X.post('/api/claim', { code: 'ABCDEFGHJK' })).status === 403);
    check('a wrong agent code is refused', (await A.put('/api/properties/' + v12 + '/agent', { agent_code: 'WRONG123' })).json.error === 'invalid_code');
    r = await A.put('/api/properties/' + v12 + '/agent', { agent_code: codeX.toLowerCase() });
    check('owner assigns agent X to Villa 12', r.status === 200);
    r = await X.get('/api/dashboard?year=2026');
    check('agent X now sees only Villa 12', r.json.properties.length === 1 && r.json.properties[0].name === 'Villa 12' && r.json.totals.expected === 150000);
    check('agent Y still sees nothing', (await Y.get('/api/dashboard')).json.properties.length === 0 && (await Y.get('/api/properties/' + v12)).status === 404);
    check('agent X cannot open another property of the same owner', (await X.get('/api/properties/' + v7)).status === 404);
    check('agent X can edit the assigned property', (await X.put('/api/properties/' + v12, { name: 'Villa 12', type: 'villa', area: 'Al Dhait', rent_amount: 150000, lat: 25.7891, lng: 55.9432, owner_user_id: 999, agent_id: 999, created_by: 999 })).status === 200);
    r = await A.get('/api/properties/' + v12);
    check('extra ownership fields in a request are ignored', r.status === 200 && r.json.property.agent_name === 'Xavier Agent' && r.json.property.role === 'owner');
    check('agent X cannot delete the owner\'s property', (await X.del('/api/properties/' + v12)).status === 403);
    check('agent X cannot change the agent assignment', (await X.put('/api/properties/' + v12 + '/agent', { agent_code: codeY })).status === 403);
    check('agent X cannot delete a payment the owner added', (await X.del('/api/records/payments/' + v12due)).status === 403);
    check('agent X can edit a payment on the assigned property', (await X.put('/api/records/payments/' + v12due, { due_date: '2026-11-20', amount: 38000 })).status === 200);
    r = await X.post('/api/properties/' + v12 + '/payments', { due_date: '2027-06-01', amount: 500 });
    const xPay = r.json.id;
    r = await X.get('/api/properties/' + v12);
    check('delete buttons are offered only for the agent\'s own records', r.json.payments.find((p) => p.id === xPay).can_delete === true && r.json.payments.find((p) => p.id === v12due).can_delete === false && r.json.property.can.delete === false && r.json.property.can.assign_agent === false);
    check('agent X does not receive the owner\'s email address', !/ownera@example\.com/.test(r.text));
    check('agent X can delete a payment he added himself', (await X.del('/api/records/payments/' + xPay)).status === 200);
    r = await X.post('/api/properties/' + v12 + '/payments', { due_date: '2027-06-01', amount: 500 });
    check('owner can delete a record the agent added', (await A.del('/api/records/payments/' + r.json.id)).status === 200);

    group = 'Permissions: agent-registered properties';
    r = await mk(X, { name: 'No owner', type: 'villa' });
    check('agent must choose or add an owner', r.status === 400);
    r = await mk(X, { name: 'Agent Villa', type: 'villa', rent_amount: 90000, new_contact: { name: 'Client Carl', phone: '0500000000' } });
    check('agent X registers a property with a new owner', r.status === 200);
    const xProp = r.json.id;
    const contacts = (await X.get('/api/contacts')).json;
    check('the new owner appears in the agent\'s owner list', contacts.length === 1 && contacts[0].name === 'Client Carl' && contacts[0].properties === 1);
    check('agent Y cannot see agent X\'s property', (await Y.get('/api/properties/' + xProp)).status === 404 && (await Y.put('/api/properties/' + xProp, { name: 'x' })).status === 404 && (await Y.del('/api/properties/' + xProp)).status === 404);
    check('agent Y cannot see agent X\'s owners', (await Y.get('/api/contacts')).json.length === 0);
    check('agent Y cannot register a property under agent X\'s owner', (await mk(Y, { name: 'Steal', contact_id: contacts[0].id })).status === 400);
    check('agent Y cannot create a link code for agent X\'s owner', (await Y.post('/api/contacts/' + contacts[0].id + '/code', {})).status === 404);
    check('owner A cannot see agent X\'s property', (await A.get('/api/properties/' + xProp)).status === 404);
    const xProp2 = (await mk(X, { name: 'Agent Flat', type: 'apartment', contact_id: contacts[0].id })).json.id;
    check('agent X can delete a property he registered himself', (await X.del('/api/properties/' + xProp2)).status === 200 && (await X.get('/api/properties/' + xProp2)).status === 404);
    r = await X.post('/api/contacts/' + contacts[0].id + '/code', {});
    const claim = r.json.code;
    check('agent X creates a one-time link code', r.status === 200 && /^[A-Z2-9]{10}$/.test(claim));
    check('a wrong link code is refused', (await B.post('/api/claim', { code: 'AAAAAAAAAA' })).json.error === 'invalid_code');
    r = await B.post('/api/claim', { code: claim });
    check('owner B links the properties with the code', r.status === 200 && r.json.properties === 1);
    check('the link code cannot be used twice', (await A.post('/api/claim', { code: claim })).status === 400);
    check('owner B now sees and controls the property', (await B.get('/api/properties/' + xProp)).json.property.role === 'owner');
    const bPay = (await B.post('/api/properties/' + xProp + '/payments', { due_date: '2026-12-01', amount: 7500 })).json.id;
    check('agent X cannot delete a record the owner added', (await X.del('/api/records/payments/' + bPay)).status === 403);
    check('agent X can no longer delete the property once the owner has records on it', (await X.del('/api/properties/' + xProp)).status === 403);
    r = await B.put('/api/properties/' + xProp + '/agent', { agent_code: null });
    check('owner B removes the agent', r.status === 200);
    check('the removed agent loses access immediately', (await X.get('/api/properties/' + xProp)).status === 404 && (await X.put('/api/properties/' + xProp, { name: 'x' })).status === 404 && (await X.get('/api/dashboard')).json.properties.every((p) => p.id !== xProp));

    group = 'Files';
    const up = (client, pid, kind, name, buf) => client.req('POST', `/api/properties/${pid}/files?kind=${kind}&name=${encodeURIComponent(name)}`, undefined, { raw: buf });
    r = await up(A, v12, 'photo', 'front.png', PNG);
    check('owner uploads a photo', r.status === 200);
    const photoId = r.json.id;
    r = await up(A, v12, 'document', 'contract.pdf', Buffer.from('%PDF-1.4\n%%EOF'));
    check('owner uploads a PDF document', r.status === 200);
    const pdfId = r.json.id;
    r = await up(A, v12, 'photo', 'evil.png', Buffer.from('<html><script>alert(1)</script></html>'));
    check('a web page disguised as an image is refused', r.status === 415 && r.json.error === 'file_type');
    r = await up(A, v12, 'photo', 'doc.pdf', Buffer.from('%PDF-1.4\n%%EOF'));
    check('a PDF is refused as a photo', r.status === 415);
    r = await up(A, v12, 'photo', 'big.png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    check('a file over 10 MB is refused', r.status === 413);
    r = await up(A, v12, 'photo', '../../etc/passwd.png', PNG);
    const weird = (await A.get('/api/properties/' + v12)).json.files.find((f) => f.id === r.json.id);
    check('path characters in file names are neutralised', r.status === 200 && !/[\\/]/.test(weird.name), weird && weird.name);
    r = await A.get('/api/files/' + photoId);
    check('owner can open the photo', r.status === 200 && r.headers.get('content-type') === 'image/png');
    check('files are served with a locked-down policy', /sandbox/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff');
    r = await A.get('/api/files/' + pdfId);
    check('PDFs are served as downloads', /^attachment/.test(r.headers.get('content-disposition')));
    check('files need a login', (await anon.get('/api/files/' + photoId)).status === 401);
    check('another owner cannot open the file', (await B.get('/api/files/' + photoId)).status === 404);
    check('an unassigned agent cannot open the file', (await Y.get('/api/files/' + photoId)).status === 404);
    check('the assigned agent can open the file', (await X.get('/api/files/' + photoId)).status === 200);
    check('the assigned agent cannot delete the owner\'s file', (await X.del('/api/files/' + photoId)).status === 403);
    r = await up(X, v12, 'photo', 'agent.png', PNG);
    check('the assigned agent can upload and delete his own file', r.status === 200 && (await X.del('/api/files/' + r.json.id)).status === 200);
    check('another owner cannot upload to the property', (await up(B, v12, 'photo', 'x.png', PNG)).status === 404);
    check('uploads stop when a user\'s storage allowance is used up', (await up(B, xProp, 'photo', 'huge.png', Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]))).json.error === 'storage_full' && (await up(B, xProp, 'photo', 'ok.png', PNG)).status === 200);
    const stored = fs.readdirSync(path.join(DATA, 'uploads')).length;
    await A.del('/api/files/' + photoId);
    check('deleting a file removes it from storage', await new Promise((ok) => setTimeout(() => ok(fs.readdirSync(path.join(DATA, 'uploads')).length === stored - 1), 200)));

    group = 'Location from Google Maps';
    const near = (c, lat, lng) => c && Math.abs(c.lat - lat) < 1e-6 && Math.abs(c.lng - lng) < 1e-6;
    check('plain coordinates', near(parseCoords('25.7891, 55.9432'), 25.7891, 55.9432));
    check('coordinates with brackets and spaces', near(parseCoords(' (25.7891 55.9432) '), 25.7891, 55.9432));
    check('degrees-minutes-seconds', near(parseCoords('25°47\'20.8"N 55°56\'35.5"E'), 25 + 47 / 60 + 20.8 / 3600, 55 + 56 / 60 + 35.5 / 3600));
    check('full link with a place pin (uses the pin, not the map centre)', near(parseCoords('https://www.google.com/maps/place/Al+Dhait/@25.70,55.90,14z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d25.7891!4d55.9432!16s'), 25.7891, 55.9432));
    check('full link with only a map centre', near(parseCoords('https://www.google.com/maps/@25.7891,55.9432,15z'), 25.7891, 55.9432));
    check('link with ?q=lat,lng', near(parseCoords('https://maps.google.com/?q=25.7891,55.9432'), 25.7891, 55.9432));
    check('link with encoded query', near(parseCoords('https://www.google.com/maps/search/?api=1&query=25.7891%2C55.9432'), 25.7891, 55.9432));
    check('dropped-pin link', near(parseCoords('https://www.google.com/maps/place/25.7891,55.9432'), 25.7891, 55.9432));
    check('negative coordinates', near(parseCoords('-33.8688, 151.2093'), -33.8688, 151.2093));
    check('nonsense text gives nothing', parseCoords('hello world') === null && parseCoords('999, 999') === null && parseCoords('') === null);
    const hops = [];
    const fakeFetch = (map) => async (url) => {
      hops.push(url);
      const hit = map[url];
      if (!hit) return { status: 404, headers: new Headers(), text: async () => '' };
      return { status: hit.status || 302, headers: new Headers(hit.location ? { location: hit.location } : {}), text: async () => hit.body || '' };
    };
    let loc = await resolveLocation('https://maps.app.goo.gl/AbCdEf123', fakeFetch({ 'https://maps.app.goo.gl/AbCdEf123': { location: 'https://www.google.com/maps/place/Villa/@25.7,55.9,17z/data=!3d25.7891!4d55.9432' } }));
    check('short share link is resolved through the server', near(loc, 25.7891, 55.9432) && loc.source === 'link');
    loc = await resolveLocation('Look: https://goo.gl/maps/xyz ok', fakeFetch({ 'https://goo.gl/maps/xyz': { location: 'https://maps.google.com/maps?foo=1' }, 'https://maps.google.com/maps?foo=1': { location: 'https://www.google.com/maps/@25.7891,55.9432,15z' } }));
    check('short link with two redirects is resolved', near(loc, 25.7891, 55.9432));
    loc = await resolveLocation('https://maps.app.goo.gl/consent', fakeFetch({ 'https://maps.app.goo.gl/consent': { location: 'https://consent.google.com/m?continue=https%3A%2F%2Fwww.google.com%2Fmaps%2F%4025.7891%2C55.9432%2C15z' } }));
    check('coordinates are read from a consent redirect without opening it', near(loc, 25.7891, 55.9432));
    const rejects = async (input, map) => { try { await resolveLocation(input, fakeFetch(map || {})); return null; } catch (e) { return e.code; } };
    hops.length = 0;
    check('a non-Google link is refused and never fetched', (await rejects('https://evil.example/maps/abc')) === 'host_not_allowed' && hops.length === 0);
    check('an internal address is refused and never fetched', (await rejects('http://169.254.169.254/latest/meta-data')) === 'host_not_allowed' && (await rejects('http://localhost:3000/api/me')) === 'host_not_allowed' && hops.length === 0);
    check('look-alike hosts are refused', !allowedUrl('https://maps.app.goo.gl.evil.example/x') && !allowedUrl('https://maps.app.goo.gl@evil.example/x') && !allowedUrl('https://evilgoogle.com/maps') && !allowedUrl('https://google.com.evil.io/maps') && !allowedUrl('ftp://maps.app.goo.gl/x') && !allowedUrl('https://maps.app.goo.gl:8443/x') && !allowedUrl('https://goo.gl/notmaps'));
    hops.length = 0;
    check('a redirect to a non-Google host is not followed', (await rejects('https://maps.app.goo.gl/bad', { 'https://maps.app.goo.gl/bad': { location: 'http://169.254.169.254/secret' } })) === 'no_coordinates' && hops.length === 1, hops);
    check('a link without coordinates reports that clearly', (await rejects('https://maps.app.goo.gl/none', { 'https://maps.app.goo.gl/none': { status: 200, body: '<html>nothing</html>' } })) === 'no_coordinates');
    check('text that is neither a link nor coordinates is reported', (await rejects('my house near the mosque')) === 'not_recognized');
    r = await A.post('/api/resolve-location', { text: 'https://www.google.com/maps/@25.7891,55.9432,15z' });
    check('website endpoint returns the coordinates', r.status === 200 && r.json.lat === 25.7891 && r.json.lng === 55.9432, r.json);
    r = await A.post('/api/resolve-location', { text: 'https://evil.example/x' });
    check('website endpoint refuses a non-Google link', r.status === 422 && r.json.error === 'host_not_allowed');
    check('location lookup requires login', (await anon.post('/api/resolve-location', { text: '1,1' })).status === 401);

    group = 'Website files and headers';
    r = await anon.get('/');
    check('home page loads', r.status === 200 && /<div id="app">/.test(r.text));
    const csp = r.headers.get('content-security-policy') || '';
    check('pages forbid inline scripts and framing', /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && /frame-ancestors 'none'/.test(csp) && r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff');
    for (const f of ['/app.js', '/styles.css', '/i18n.js', '/map.js', '/icon.svg']) check('static file ' + f + ' loads', (await anon.get(f)).status === 200);
    const raw = await new Promise((ok) => { const s = require('node:net').connect(PORT, '127.0.0.1', () => s.write('GET /../server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')); let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => ok(d)); });
    check('files outside the public folder cannot be read (../)', /^HTTP\/1\.1 404/.test(raw) && !/DatabaseSync/.test(raw));
    check('files outside the public folder cannot be read (encoded)', (await anon.get('/%2e%2e/server.js')).status === 404 && (await anon.get('/..%2fserver.js')).status === 404 && (await anon.get('/%2e%2e%2fdata%2fapp.db')).status === 404);
    r = await anon.get('/api/nothing');
    check('unknown API address returns 404 without details', r.status === 404 && r.json.error === 'not_found');
    r = await A.req('POST', '/api/login', undefined, { raw: Buffer.from('{bad json'), headers: { 'content-type': 'application/json' } });
    check('broken input gives a clean error, not a crash', r.status === 400 || r.status === 415);

    group = 'Google sign-in';
    const gStart = async (role) => {
      const res = await fetch(BASE + '/auth/google' + (role ? '?role=' + role : ''), { redirect: 'manual' });
      const raw = res.headers.getSetCookie()[0] || '';
      return { status: res.status, loc: new URL(res.headers.get('location')), raw, cookie: raw.split(';')[0] };
    };
    const gBack = async (start, claims, opt = {}) => {
      const code = Buffer.from(JSON.stringify({ nonce: start.loc.searchParams.get('nonce'), ...claims })).toString('base64url');
      const res = await fetch(BASE + '/auth/google/callback?code=' + code + '&state=' + (opt.state || start.loc.searchParams.get('state')), { redirect: 'manual', headers: opt.noCookie ? {} : { cookie: start.cookie } });
      const set = res.headers.getSetCookie();
      const sid = set.find((x) => x.startsWith('sid=') && !x.startsWith('sid=;'));
      const cl = new Client(); cl.cookie = sid ? sid.split(';')[0] : '';
      return { status: res.status, location: res.headers.get('location'), sid, set, client: cl };
    };
    check('the site reports that Google sign-in is switched on', (await anon.get('/api/config')).json.google === true);
    let g = await gStart('owner');
    check('starting Google sign-in sends the browser to Google with the right details', g.status === 302 && g.loc.href.startsWith(google.authUrl) && g.loc.searchParams.get('client_id') === GID && g.loc.searchParams.get('redirect_uri') === BASE + '/auth/google/callback' && /openid/.test(g.loc.searchParams.get('scope')) && /email/.test(g.loc.searchParams.get('scope')) && g.loc.searchParams.get('response_type') === 'code' && g.loc.searchParams.get('state').length >= 20 && g.loc.searchParams.get('nonce').length >= 20);
    check('the sign-in attempt is tied to the browser with a protected cookie', /HttpOnly/.test(g.raw) && /SameSite=Lax/.test(g.raw) && /Path=\/auth/.test(g.raw) && /Max-Age=600/.test(g.raw));
    let b = await gBack(g, { sub: 'g-1001', email: 'Gina@Example.com', name: 'Gina Google' });
    check('a new owner signs up with Google and is logged in', b.status === 302 && b.location === '/#/dashboard' && !!b.sid && /HttpOnly/.test(b.sid) && /SameSite=Strict/.test(b.sid));
    let gm = (await b.client.get('/api/me')).json;
    check('the Google account becomes an owner with the Google email and no password', gm && gm.role === 'owner' && gm.email === 'gina@example.com' && gm.name === 'Gina Google' && gm.google === true && gm.has_password === false, gm);
    check('the one-time sign-in cookie is cleared afterwards', b.set.some((x) => x.startsWith('g_state=;') && /Max-Age=0/.test(x)));
    const tr = google.tokenRequests[google.tokenRequests.length - 1];
    check('the server exchanges the code with Google using its secret', tr.client_id === GID && tr.client_secret === 'test-secret' && tr.grant_type === 'authorization_code' && tr.redirect_uri === BASE + '/auth/google/callback');
    const ginaId = gm.id;
    b = await gBack(await gStart(), { sub: 'g-1001', email: 'gina@example.com' });
    check('logging in again with the same Google account opens the same account', b.location === '/#/dashboard' && (await b.client.get('/api/me')).json.id === ginaId);
    b = await gBack(await gStart(), { sub: 'g-2002', email: 'newperson@example.com' });
    check('a new Google user must choose owner or agent first', b.location === '/#/signup/google_role' && !b.sid && (await anon.post('/api/login', { email: 'newperson@example.com', password: 'x' })).status === 401);
    b = await gBack(await gStart('admin'), { sub: 'g-2002', email: 'newperson@example.com' });
    check('an invented role is ignored', b.location === '/#/signup/google_role' && !b.sid);
    b = await gBack(await gStart('agent'), { sub: 'g-2002', email: 'newperson@example.com', name: '<b>Neo</b>' });
    gm = (await b.client.get('/api/me')).json;
    check('a new agent signs up with Google and gets an agent code', b.location === '/#/dashboard' && gm.role === 'agent' && /^[A-Z2-9]{8}$/.test(gm.agent_code) && gm.name === '<b>Neo</b>');
    g = await gStart('owner');
    check('a reply with the wrong state is refused', (b = await gBack(g, { sub: 'g-3', email: 'x3@example.com' }, { state: 'A'.repeat(32) })).location === '/#/login/google_failed' && !b.sid);
    check('a reply without the browser cookie is refused', (b = await gBack(g, { sub: 'g-3', email: 'x3@example.com' }, { noCookie: true })).location === '/#/login/google_failed' && !b.sid);
    const other = await gStart('owner');
    check('a reply meant for another browser is refused', (b = await gBack(g, { sub: 'g-3', email: 'x3@example.com' }, { state: other.loc.searchParams.get('state') })).location === '/#/login/google_failed' && !b.sid);
    const bad = async (claims) => { const x = await gBack(await gStart('owner'), claims); return x.location === '/#/login/google_failed' && !x.sid; };
    check('a token issued for a different website is refused', await bad({ sub: 'g-4', email: 'x4@example.com', aud: 'someone-else.apps.googleusercontent.com' }));
    check('an expired token is refused', await bad({ sub: 'g-4', email: 'x4@example.com', exp: Math.floor(Date.now() / 1000) - 10 }));
    check('a token with the wrong one-time number is refused', await bad({ sub: 'g-4', email: 'x4@example.com', nonce: 'B'.repeat(32) }));
    check('a token not issued by Google is refused', await bad({ sub: 'g-4', email: 'x4@example.com', iss: 'https://evil.example' }));
    check('a rejected code is refused', await bad({ reject: true }));
    b = await gBack(await gStart('owner'), { sub: 'g-4', email: 'x4@example.com', email_verified: false });
    check('a Google account with an unverified email is refused', b.location === '/#/login/google_unverified' && !b.sid);
    check('none of the refused attempts created an account', (await anon.post('/api/signup', { email: 'x4@example.com', name: 'X4', password: 'free to register', role: 'owner' })).status === 200);
    const P = new Client();
    await P.post('/api/signup', { email: 'pat@example.com', name: 'Pat Password', password: 'pat password 1', role: 'owner' });
    const patId = (await P.get('/api/me')).json.id;
    const patProp = (await mk(P, { name: 'Pat Villa', type: 'villa' })).json.id;
    b = await gBack(await gStart(), { sub: 'g-5005', email: 'pat@example.com' });
    gm = (await b.client.get('/api/me')).json;
    check('Google sign-in links to an existing account with the same email and keeps its data', b.location === '/#/dashboard' && gm.id === patId && gm.google === true && (await b.client.get('/api/properties/' + patProp)).status === 200);
    check('linking removes the old password and logs out old devices', gm.has_password === false && (await P.get('/api/me')).status === 401 && (await new Client().post('/api/login', { email: 'pat@example.com', password: 'pat password 1' })).status === 401);
    check('a different Google account cannot take over an email already linked', await bad({ sub: 'g-9999', email: 'pat@example.com' }));
    check('a Google-only account can set a password and then log in with it', (await b.client.post('/api/password', { next: 'pat new password' })).status === 200 && (await new Client().post('/api/login', { email: 'pat@example.com', password: 'pat new password' })).json.has_password === true);
    check('the Google pages accept only normal page loads', (await anon.req('POST', '/auth/google', {})).status === 405);
    let lastG = 0;
    for (let i = 0; i < 45 && lastG !== 429; i++) lastG = (await fetch(BASE + '/auth/google', { redirect: 'manual' })).status;
    check('repeated Google sign-in attempts are rate limited', lastG === 429);
    const P2 = PORT + 1, D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'amlaki-test2-'));
    const env2 = { ...process.env, PORT: String(P2), DATA_DIR: D2, NODE_NO_WARNINGS: '1' };
    delete env2.GOOGLE_CLIENT_ID; delete env2.GOOGLE_CLIENT_SECRET;
    const plain = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: env2, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((ok) => { plain.stdout.on('data', (d) => { if (String(d).includes('running')) ok(); }); setTimeout(ok, 5000); });
    const cfg = await (await fetch('http://127.0.0.1:' + P2 + '/api/config')).json();
    const off = (await fetch('http://127.0.0.1:' + P2 + '/auth/google', { redirect: 'manual' })).status;
    plain.kill(); fs.rmSync(D2, { recursive: true, force: true });
    check('without Google settings the feature is off and its pages do not exist', cfg.google === false && off === 404);

    group = 'Sessions';
    r = await A2.post('/api/password', { current: 'wrong', next: 'new password 99' });
    check('password change needs the current password', r.status === 400);
    r = await A2.post('/api/password', { current: 'correct horse 1', next: 'new password 99' });
    check('password can be changed', r.status === 200);
    check('other devices are logged out after a password change', (await A.get('/api/me')).status === 401 && (await A2.get('/api/me')).status === 200);
    const oldCookie = A2.cookie;
    await A2.post('/api/logout', {});
    const ghost = new Client(); ghost.cookie = oldCookie;
    check('a logged-out session can no longer be used', (await ghost.get('/api/me')).status === 401);
    check('the new password works and the old one does not', (await new Client().post('/api/login', { email: 'ownera@example.com', password: 'new password 99' })).status === 200 && (await new Client().post('/api/login', { email: 'ownera@example.com', password: 'correct horse 1' })).status === 401);
    const forged = new Client(); forged.cookie = 'sid=' + 'A'.repeat(43);
    check('a made-up session cookie is refused', (await forged.get('/api/me')).status === 401);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await new Client().post('/api/login', { email: 'ownerb@example.com', password: 'guess ' + i })).status;
    check('repeated wrong logins are blocked', last === 429, last);

    group = 'Delete property';
    const C = new Client();
    await C.post('/api/signup', { email: 'ownerc@example.com', name: 'Cleo', password: 'cleo password', role: 'owner' });
    const cp = (await mk(C, { name: 'Temp', type: 'land' })).json.id;
    await C.post('/api/properties/' + cp + '/payments', { due_date: '2026-01-01', amount: 10 });
    const cf = (await up(C, cp, 'photo', 'a.png', PNG)).json.id;
    const before = fs.readdirSync(path.join(DATA, 'uploads')).length;
    check('owner deletes a property', (await C.del('/api/properties/' + cp)).status === 200);
    check('its records and files are gone', (await C.get('/api/properties/' + cp)).status === 404 && (await C.get('/api/files/' + cf)).status === 404 && (await C.get('/api/records/payments')).json.rows.length === 0);
    check('its stored files are removed from disk', await new Promise((ok) => setTimeout(() => ok(fs.readdirSync(path.join(DATA, 'uploads')).length === before - 1), 200)));
  } finally {
    server.kill();
    google.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  if (serverErr.trim()) console.log('\nServer error output:\n' + serverErr);
  const groups = [...new Set(results.map((x) => x.group))];
  console.log('\nRESULTS');
  for (const g of groups) {
    const rows = results.filter((x) => x.group === g);
    console.log(`  ${rows.every((x) => x.ok) ? 'PASS' : 'FAIL'}  ${g}  (${rows.filter((x) => x.ok).length}/${rows.length})`);
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
