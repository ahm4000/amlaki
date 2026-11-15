'use strict';
// Drives the website in a real Chrome browser. Needs Playwright (not shipped with the site):
//   PLAYWRIGHT=/path/to/node_modules/playwright CHROME=/usr/bin/google-chrome node test/ui.test.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { startFakeGoogle } = require('./fake-google');
const GID = 'test-client-id.apps.googleusercontent.com';
let google = null;

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'amlaki-ui-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'amlaki-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const results = [];
let group = '';
const check = (name, cond, detail) => { results.push({ group, name, ok: !!cond }); if (!cond) console.log('  FAIL', group, '-', name, detail !== undefined ? JSON.stringify(detail) : ''); };
const problems = [];

async function newPage(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(BASE) || route.request().url().startsWith(google.origin) ? route.continue() : route.abort()));
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) problems.push('console: ' + m.text()); });
  return { ctx, page };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function addRecord(page, kind, values) {
  await page.click(`[data-add="${kind}"]`);
  for (const [k, v] of Object.entries(values)) {
    const sel = `dialog [name="${k}"]`;
    if (await page.locator(sel).evaluate((e) => e.tagName === 'SELECT')) await page.selectOption(sel, v); else await page.fill(sel, String(v));
  }
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.waitForSelector(`#${kind} table`);
}

async function main() {
  google = await startFakeGoogle(GID);
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FAKE_TODAY: '2026-11-13', NODE_NO_WARNINGS: '1', GOOGLE_CLIENT_ID: GID, GOOGLE_CLIENT_SECRET: 'test-secret', OAUTH_TEST_AUTH_URL: google.authUrl, OAUTH_TEST_TOKEN_URL: google.tokenUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((ok, no) => { server.stdout.on('data', (d) => { if (String(d).includes('running')) ok(); }); setTimeout(() => no(new Error('server start timeout')), 8000); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox', '--no-proxy-server'] });
  try {
    const { ctx, page } = await newPage(browser, { viewport: { width: 1440, height: 900 } });

    group = 'Owner: sign-up and first property';
    await page.goto(BASE);
    await page.waitForSelector('.auth-card');
    check('login page is shown first', await page.locator('input[name=email]').isVisible());
    await page.fill('input[name=email]', 'nobody@example.com'); await page.fill('input[name=password]', 'wrong password');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.form-error').textContent.length > 0);
    check('wrong login shows a clear message', /not correct/.test(await page.textContent('.form-error')));
    await page.click('a[href="#/signup"]');
    await page.fill('input[name=name]', 'Ahmed Owner'); await page.fill('input[name=email]', 'ahmed@example.com'); await page.fill('input[name=password]', 'short');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.querySelector('.form-error').textContent.length > 0);
    check('short password shows a clear message', /8 characters/.test(await page.textContent('.form-error')));
    await page.fill('input[name=password]', 'a good password');
    await page.click('button[type=submit]');
    await page.waitForSelector('.empty');
    check('new owner lands on an empty dashboard with a call to add a property', /first property/.test(await page.textContent('.empty')));
    await page.click('.empty a.btn');
    await page.waitForSelector('#loc-input');
    await page.fill('input[name=name]', 'Villa 12');
    await page.selectOption('select[name=emirate]', 'Ras Al Khaimah');
    await page.fill('input[name=area]', 'Al Dhait');
    await page.fill('#loc-input', 'not a location'); await page.click('#loc-find');
    await page.waitForFunction(() => document.getElementById('loc-status').className === 'bad-text');
    check('invalid location shows an error and offers the map', /tap the map/.test(await page.textContent('#loc-status')));
    await page.click('.mmap', { position: { x: 200, y: 120 } });
    await page.waitForFunction(() => /\d/.test(document.getElementById('coords').textContent));
    check('tapping the map places the pin manually', /^-?\d+\.\d+, -?\d+\.\d+$/.test(await page.textContent('#coords')) && (await page.locator('.mmap-pin').count()) === 1);
    await page.fill('#loc-input', '25.7891, 55.9432'); await page.click('#loc-find');
    await page.waitForFunction(() => document.getElementById('coords').textContent === '25.7891, 55.9432');
    check('pasted coordinates are read and pinned', (await page.textContent('#loc-status')).includes('found'));
    await page.fill('#loc-input', 'https://www.google.com/maps/place/X/@25.1,55.1,15z/data=!3d25.8001!4d55.9502'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('coords').textContent === '25.8001, 55.9502');
    check('pasted Google Maps link is read and pinned', true);
    await page.fill('#loc-input', '25.7891, 55.9432'); await page.click('#loc-find');
    await page.waitForFunction(() => document.getElementById('coords').textContent === '25.7891, 55.9432');
    await page.fill('input[name=rent_amount]', '150000');
    await page.setInputFiles('#new-photos', { name: 'front.png', mimeType: 'image/png', buffer: PNG });
    await page.click('form.form-page button[type=submit]');
    await page.waitForSelector('.phead h1');
    check('property is saved and its page opens', (await page.textContent('.phead h1')) === 'Villa 12');
    check('the photo chosen on the form was uploaded', (await page.locator('#photos .photo img').count()) === 1 && (await page.locator('.phead-cover img').count()) === 1);
    check('saved coordinates show with a Google Maps link', (await page.textContent('.mono')).includes('25.7891, 55.9432') && /google\.com\/maps\?q=25\.7891,55\.9432/.test(await page.getAttribute('a[target=_blank][rel*=noreferrer]', 'href')));

    group = 'Owner: records on the property page';
    await addRecord(page, 'payments', { due_date: '2026-03-01', amount: 37000, paid_date: '2026-03-01' });
    await addRecord(page, 'payments', { due_date: '2026-11-20', amount: 38000 });
    await addRecord(page, 'payments', { due_date: '2026-11-01', amount: 5000 });
    let rows = await page.locator('#payments tbody tr').allTextContents();
    check('payments show Paid, Rent overdue and Due soon', rows.length === 3 && /Paid/.test(rows[0]) && /Rent overdue/.test(rows[1]) && /Due soon/.test(rows[2]), rows);
    await page.locator('#payments tbody tr', { hasText: '5,000' }).getByText('Mark paid').click();
    await page.waitForFunction(() => document.querySelectorAll('#payments .st-overdue').length === 0);
    check('Mark paid turns an overdue payment into Paid', (await page.locator('#payments .st-paid').count()) === 2);
    await addRecord(page, 'tenants', { name: 'Tenant One', phone: '0501234567', contract_start: '2026-03-01', contract_end: '2027-02-28', annual_rent: 150000 });
    await addRecord(page, 'reminders', { title: 'AC service', interval_months: 6, next_due: '2026-11-25' });
    await addRecord(page, 'maintenance', { date: '2026-05-25', title: 'AC service', contractor: 'Cool Air', cost: 900 });
    await addRecord(page, 'expenses', { date: '2026-01-15', category: 'service', amount: 2100 });
    await addRecord(page, 'expenses', { date: '2026-02-15', category: 'other', amount: 777 });
    check('tenant, reminder, maintenance and expenses are listed', (await page.locator('#tenants tbody tr').count()) === 1 && /in 12 days/.test(await page.textContent('#reminders tbody')) && (await page.locator('#expenses tbody tr').count()) === 2);
    await page.locator('#maintenance tbody tr').getByText('Edit').click();
    await page.fill('dialog [name=cost]', '1000'); await page.click('dialog button[type=submit]');
    await page.waitForFunction(() => /1,000/.test(document.querySelector('#maintenance tbody').textContent));
    check('editing a record saves the change', true);
    await page.locator('#expenses tbody tr', { hasText: '777' }).getByText('Delete').click();
    await page.click('#confirm-yes');
    await page.waitForFunction(() => document.querySelectorAll('#expenses tbody tr').length === 1);
    check('deleting a record asks for confirmation and removes it', true);
    await page.setInputFiles('#documents input[type=file]', { name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
    await page.waitForSelector('#documents tbody tr');
    check('a document can be uploaded and is listed', /contract\.pdf/.test(await page.textContent('#documents tbody')));
    await page.setInputFiles('#documents input[type=file]', { name: 'bad.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ fake') });
    await page.waitForSelector('.toast-bad');
    check('a wrong file type shows a clear message', /not accepted/.test(await page.textContent('.toast-bad')));
    await page.waitForSelector('.toast-bad', { state: 'detached' });
    const stats = await page.locator('.phead .stats b').allTextContents();
    check('property totals: expected 150,000 / received 42,000 / expenses 3,100 / net 38,900', stats.join('|') === '150,000|42,000|3,100|38,900', stats);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-property.png'), fullPage: true });

    group = 'Owner: dashboard';
    // Add four more properties through the same API the forms use, to fill the dashboard.
    await page.evaluate(async () => {
      const call = (m, u, b) => fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'amlaki' }, body: JSON.stringify(b) }).then((r) => r.json());
      const mk = async (name, type, area, rent, lat, lng) => (await call('POST', '/api/properties', { name, type, area, emirate: 'Ras Al Khaimah', rent_amount: rent, lat, lng })).id;
      const v7 = await mk('Villa 7', 'villa', 'Khuzam', 130000, 25.765, 55.94), a302 = await mk('Apartment 302', 'apartment', 'Al Nakheel', 60000, 25.79, 55.97), a105 = await mk('Apartment 105', 'apartment', 'Al Nakheel', 60000, 25.795, 55.975), shop = await mk('Shop 3', 'shop', 'Al Seer', 80000, 25.81, 55.99);
      const pay = (p, due, amount, paid) => call('POST', `/api/properties/${p}/payments`, { due_date: due, amount, paid_date: paid || '' });
      await pay(v7, '2026-01-10', 65000, '2026-01-10'); await pay(v7, '2026-07-10', 65000, '2026-07-10');
      await pay(a302, '2026-05-01', 30000, '2026-05-01'); await pay(a302, '2026-11-01', 30000);
      for (const m of ['01', '04', '07', '10']) await pay(a105, `2026-${m}-05`, 15000, `2026-${m}-05`);
      await pay(shop, '2026-04-15', 40000, '2026-04-15'); await pay(shop, '2026-10-15', 40000, '2026-10-15');
      const ten = (p, n, s, e) => call('POST', `/api/properties/${p}/tenants`, { name: n, contract_start: s, contract_end: e });
      await ten(v7, 'Tenant Two', '2026-01-16', '2027-01-15'); await ten(a302, 'Tenant Three', '2026-05-01', '2027-04-30'); await ten(a105, 'Tenant Four', '2026-03-05', '2027-03-04');
      await call('POST', `/api/properties/${v7}/maintenance`, { date: '2026-08-10', title: 'Roof repair', cost: 22700 });
      await call('POST', `/api/properties/${a302}/expenses`, { date: '2026-01-15', category: 'service', amount: 9000 });
      await call('POST', `/api/properties/${a302}/reminders`, { title: 'Water tank cleaning', interval_months: 6, next_due: '2026-12-05' });
    });
    await page.goto(BASE + '/#/dashboard');
    await page.waitForSelector('#net-profit');
    const dash = { net: await page.textContent('#net-profit'), rec: await page.textContent('#tot-received'), out: await page.textContent('#tot-outstanding'), exp: await page.textContent('#tot-expenses'), n: await page.textContent('#tot-properties') };
    // received: 42,000 + 130,000 + 30,000 + 60,000 + 80,000 = 342,000; expenses: 3,100 + 22,700 + 9,000 = 34,800; outstanding: 38,000 + 30,000
    check('dashboard totals match hand calculation (342,000 / 68,000 / 34,800 / net 307,200 / 5)', dash.rec === '342,000' && dash.out === '68,000' && dash.exp === '34,800' && dash.net === '307,200' && dash.n === '5', dash);
    check('needs-attention list shows overdue rent first', /Rent overdue/.test(await page.locator('.att-row').first().textContent()) && (await page.locator('.att-row').count()) >= 5);
    check('rent calendar has one row per property and coloured cells', (await page.locator('.cal-row').count()) === 6 && (await page.locator('.cell.st-paid').count()) >= 10 && (await page.locator('.cell.st-overdue').count()) === 1 && (await page.locator('.cell.st-due').count()) === 1);
    check('map shows one pin per located property', (await page.locator('.map-pin').count()) === 5 && (await page.locator('.map-pin.st-overdue').count()) === 1);
    check('chart and property cards are drawn', (await page.locator('.chart-col').count()) === 12 && (await page.locator('.pcard').count()) === 5);
    check('notification bell shows the count', Number(await page.textContent('.badge')) === (await page.locator('.att-row').count()));
    check('no sideways scrolling on a computer screen', await noOverflow(page));
    await page.screenshot({ path: path.join(SHOTS, 'desktop-dashboard.png'), fullPage: true });
    await page.locator('.map-pin', { hasText: 'Shop 3' }).click();
    await page.waitForSelector('.phead h1');
    check('a map pin opens its property', (await page.textContent('.phead h1')) === 'Shop 3' && /Vacant/.test(await page.textContent('.phead-title')));

    group = 'Search, filters and list pages';
    await page.goto(BASE + '/#/properties');
    await page.waitForSelector('.filters');
    await page.fill('.filters input[type=search]', 'nakheel');
    check('search by area narrows the list', (await page.locator('.pcard').count()) === 2);
    await page.fill('.filters input[type=search]', '');
    await page.selectOption('.filters select >> nth=1', 'overdue');
    check('status filter works', (await page.locator('.pcard').count()) === 1 && /Apartment 302/.test(await page.textContent('.cards')));
    await page.selectOption('.filters select >> nth=1', ''); await page.selectOption('.filters select >> nth=0', 'villa');
    check('type filter works', (await page.locator('.pcard').count()) === 2);
    for (const [kind, expect] of [['payments', 'Total received: AED 342,000'], ['maintenance', 'Roof repair'], ['expenses', 'AED 11,100'], ['tenants', 'Tenant Three'], ['files', 'contract.pdf']]) {
      await page.goto(BASE + '/#/list/' + kind);
      await page.waitForSelector('.page-head');
      await page.waitForFunction((e) => document.querySelector('.main').textContent.includes(e), expect).catch(() => {});
      check('list page "' + kind + '" loads with data', (await page.textContent('.main')).includes(expect));
    }

    group = 'Arabic';
    await page.goto(BASE + '/#/settings');
    await page.waitForSelector('.lang');
    await page.getByRole('button', { name: 'العربية' }).click();
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    check('switching to Arabic turns the page right-to-left', (await page.getAttribute('html', 'lang')) === 'ar' && /الإعدادات/.test(await page.textContent('.page-head')));
    await page.goto(BASE + '/#/dashboard');
    await page.waitForSelector('#net-profit');
    const sideBox = await page.locator('.side').boundingBox();
    check('the menu moves to the right side', sideBox.x > 1000, sideBox);
    check('Arabic labels are used and numbers stay readable', /صافي ربح الإيجار/.test(await page.textContent('.hero')) && (await page.textContent('#net-profit')) === '307,200');
    check('no sideways scrolling in Arabic', await noOverflow(page));
    await page.screenshot({ path: path.join(SHOTS, 'desktop-dashboard-arabic.png'), fullPage: true });
    await page.goto(BASE + '/#/property/1');
    await page.waitForSelector('.phead h1');
    check('property page renders in Arabic', /دفعات الإيجار/.test(await page.textContent('#payments')) && await noOverflow(page));
    await page.goto(BASE + '/#/settings');
    await page.waitForSelector('.lang');
    await page.getByRole('button', { name: 'English' }).click();
    await page.waitForFunction(() => document.documentElement.dir === 'ltr');

    group = 'iPhone size';
    const state = await ctx.storageState();
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: state });
    for (const [name, hash, sel] of [['dashboard', '#/dashboard', '#net-profit'], ['properties', '#/properties', '.pcard'], ['property', '#/property/1', '.phead h1'], ['add-property', '#/new', '#loc-input'], ['payments', '#/list/payments', '.tbl'], ['settings', '#/settings', '#logout']]) {
      await phone.page.goto(BASE + '/' + hash);
      await phone.page.waitForSelector(sel);
      await phone.page.waitForTimeout(150);
      check('iPhone: ' + name + ' fits the screen width', await noOverflow(phone.page));
      await phone.page.screenshot({ path: path.join(SHOTS, 'iphone-' + name + '.png'), fullPage: name !== 'dashboard' ? true : false });
    }
    await phone.page.goto(BASE + '/#/dashboard'); await phone.page.waitForSelector('#net-profit');
    await phone.page.screenshot({ path: path.join(SHOTS, 'iphone-dashboard-full.png'), fullPage: true });
    check('iPhone: bottom menu is shown and the side menu is hidden', await phone.page.locator('.bottom').isVisible() && !(await phone.page.locator('.side').isVisible()));
    const small = await phone.page.evaluate(() => [...document.querySelectorAll('.bottom a, .btn, .icon-btn')].filter((e) => e.offsetParent && (e.getBoundingClientRect().height < 43 || e.getBoundingClientRect().width < 43)).map((e) => e.textContent.trim().slice(0, 20)));
    check('iPhone: buttons are large enough to tap', small.length === 0, small);
    await phone.page.tap('.bottom a.fab');
    await phone.page.waitForSelector('#loc-input');
    check('iPhone: the + button opens the add-property form', true);
    await phone.page.goto(BASE + '/#/property/1'); await phone.page.waitForSelector('[data-add=payments]');
    await phone.page.tap('[data-add=payments]');
    await phone.page.waitForSelector('dialog[open]');
    const dlgBox = await phone.page.locator('dialog').boundingBox();
    check('iPhone: forms open in a dialog that fits the screen', dlgBox.width <= 390 && dlgBox.x >= 0, dlgBox);
    await phone.page.screenshot({ path: path.join(SHOTS, 'iphone-form.png') });
    await phone.ctx.close();

    group = 'Agent';
    const ag = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    await ag.page.goto(BASE + '/#/signup');
    await ag.page.waitForSelector('input[name=name]');
    await ag.page.fill('input[name=name]', 'Xavier Agent'); await ag.page.fill('input[name=email]', 'xavier@example.com'); await ag.page.fill('input[name=password]', 'agent password');
    await ag.page.check('input[value=agent]');
    await ag.page.click('button[type=submit]');
    await ag.page.waitForSelector('.empty');
    check('agent signs up and sees the Owners menu', (await ag.page.locator('.side-links a[href="#/clients"]').count()) === 1);
    await ag.page.goto(BASE + '/#/settings'); await ag.page.waitForSelector('#agent-code');
    const agentCode = await ag.page.textContent('#agent-code');
    check('agent code is shown in Settings', /^[A-Z2-9]{8}$/.test(agentCode));
    await ag.page.goto(BASE + '/#/new'); await ag.page.waitForSelector('#owner-name');
    check('the owner box explains that it is a real name, not a username', /not a username/.test(await ag.page.textContent('#owner-note')));
    await ag.page.fill('input[name=name]', 'Client Flat');
    await ag.page.click('form.form-page button[type=submit]');
    await ag.page.waitForFunction(() => document.querySelector('form.form-page .form-error').textContent.length > 0);
    check('agent cannot save a property without naming the owner', /Type the name of the property owner/.test(await ag.page.textContent('form.form-page .form-error')));
    await ag.page.fill('#owner-name', 'Client Carl');
    check('a new name is announced as a new owner and asks for optional contact details', /New owner/.test(await ag.page.textContent('#owner-note')) && await ag.page.locator('input[name=owner_phone]').isVisible());
    await ag.page.click('form.form-page button[type=submit]');
    await ag.page.waitForSelector('.phead h1');
    check('agent registers a property for a new owner', /Client Carl/.test(await ag.page.textContent('.agent-box')) && (await ag.page.locator('#delete-property').count()) === 1);
    await ag.page.click('#invite-owner');
    await ag.page.waitForSelector('#invite-code');
    check('"Invite owner to view" shows a code with plain instructions', /^[A-Z2-9]{10}$/.test(await ag.page.textContent('#invite-code')) && /Give this code to Client Carl/.test(await ag.page.textContent('dialog')));
    await ag.page.goto(BASE + '/#/new'); await ag.page.waitForSelector('#owner-name');
    await ag.page.fill('input[name=name]', 'Client Shop'); await ag.page.fill('#owner-name', 'client carl');
    check('typing a known owner\'s name recognises them', /Already in your owner list \(1 properties\)/.test(await ag.page.textContent('#owner-note')) && !(await ag.page.locator('input[name=owner_phone]').isVisible()), await ag.page.textContent('#owner-note'));
    await ag.page.click('form.form-page button[type=submit]');
    await ag.page.waitForSelector('.phead h1');
    await ag.page.goto(BASE + '/#/clients'); await ag.page.waitForSelector('.tbl');
    check('the second property is added to the same owner, not a duplicate', (await ag.page.locator('.tbl tbody tr').count()) === 1 && /Client Carl/.test(await ag.page.textContent('.tbl tbody')) && (await ag.page.locator('.tbl tbody td').nth(3).textContent()) === '2');
    await ag.page.getByText('Create link code').click();
    await ag.page.waitForSelector('code.code');
    check('agent creates a link code for the owner', /^[A-Z2-9]{10}$/.test(await ag.page.textContent('code.code')));
    await ag.page.goto(BASE + '/#/property/1');
    await ag.page.waitForSelector('.empty');
    check('agent typing another property\'s address gets "not found"', /Not found/.test(await ag.page.textContent('.empty')));

    group = 'Owner assigns the agent';
    await page.goto(BASE + '/#/property/1'); await page.waitForSelector('.agent-box');
    await page.getByText('+ Assign an agent').click();
    await page.fill('dialog [name=agent_code]', 'WRONG999'); await page.click('dialog button[type=submit]');
    await page.waitForFunction(() => document.querySelector('dialog .form-error').textContent.length > 0);
    check('a wrong agent code is refused with a message', /not valid/.test(await page.textContent('dialog .form-error')));
    await page.fill('dialog [name=agent_code]', agentCode); await page.click('dialog button[type=submit]');
    await page.waitForFunction(() => /Xavier Agent/.test(document.querySelector('.agent-box').textContent));
    check('owner assigns the agent with the agent code', true);
    await ag.page.reload(); await ag.page.waitForSelector('.phead h1');
    check('agent can now open the property', (await ag.page.textContent('.phead h1')) === 'Villa 12');
    check('agent sees no Delete property button and no Delete on the owner\'s records', (await ag.page.locator('#delete-property').count()) === 0 && (await ag.page.locator('#payments .btn-link.danger').count()) === 0 && (await ag.page.locator('#photos .photo-del').count()) === 0);
    await addRecord(ag.page, 'expenses', { date: '2026-11-10', category: 'other', amount: 55 });
    check('agent can add a record and delete only his own', (await ag.page.locator('#expenses .btn-link.danger').count()) === 1);
    await page.goto(BASE + '/#/property/1'); await page.waitForSelector('.agent-box');
    await page.getByText('Remove agent').click(); await page.click('#confirm-yes');
    await page.waitForFunction(() => /Assign an agent/.test(document.querySelector('.agent-box').textContent));
    await ag.page.goto(BASE + '/#/dashboard'); await ag.page.waitForSelector('.pcard');
    await ag.page.goto(BASE + '/#/property/1'); await ag.page.waitForSelector('.empty');
    check('after removal the agent is locked out again', /Not found/.test(await ag.page.textContent('.empty')));
    await ag.ctx.close();

    group = 'Rent duration and cheques';
    await page.goto(BASE + '/#/properties'); await page.waitForSelector('.pcard');
    await page.locator('.pcard', { hasText: 'Shop 3' }).click();
    await page.waitForSelector('[data-add=tenants]');
    await page.click('[data-add="tenants"]');
    check('the contract form offers duration and number of cheques', (await page.locator('dialog [name=duration_months]').count()) === 1 && (await page.locator('dialog select[name=cheques] option').count()) === 7);
    await page.fill('dialog [name=name]', 'Shop Tenant'); await page.fill('dialog [name=contract_start]', '2026-11-01'); await page.fill('dialog [name=duration_months]', '12');
    await page.fill('dialog [name=annual_rent]', '80000'); await page.selectOption('dialog [name=cheques]', '4');
    await page.click('dialog button[type=submit]');
    await page.waitForSelector('dialog', { state: 'detached' });
    await page.waitForSelector('#contract-info');
    check('the contract shows its dates, duration and cheque count', /1 Nov 2026 – 31 Oct 2027 · 12 months · 4 cheques/.test(await page.textContent('#contract-info')), await page.textContent('#contract-info'));
    check('the tenants table shows the duration', /12 months/.test(await page.textContent('#tenants tbody')));
    const cheq = await page.locator('#payments tbody tr', { hasText: 'Cheque' }).allTextContents();
    check('four expected cheques of AED 20,000 are listed with their dates', cheq.length === 4 && cheq.every((x) => /20,000/.test(x)) && /1 Nov 2026/.test(cheq[0]) && /1 Feb 2027/.test(cheq[1]) && /1 May 2027/.test(cheq[2]) && /1 Aug 2027/.test(cheq[3]), cheq);
    check('the first cheque is already overdue and the others are upcoming', /Rent overdue/.test(cheq[0]) && /Upcoming/.test(cheq[1]));
    await page.locator('#tenants tbody tr', { hasText: 'Shop Tenant' }).getByText('Edit').click();
    check('editing a contract does not offer to create cheques again', (await page.locator('dialog [name=cheques]').count()) === 0 && (await page.inputValue('dialog [name=contract_end]')) === '2027-10-31');
    await page.click('dialog .dlg-actions button[type=button]');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-cheques.png'), fullPage: true });

    group = 'Log out';
    await page.goto(BASE + '/#/settings'); await page.waitForSelector('#logout');
    await page.click('#logout');
    await page.waitForSelector('.auth-card');
    await page.goto(BASE + '/#/dashboard'); await page.waitForSelector('.auth-card');
    check('after logging out, pages show the login screen', true);
    const leak = await page.evaluate(() => fetch('/api/dashboard').then((r) => r.status));
    check('after logging out, data requests are refused', leak === 401);

    group = 'Google sign-in';
    const gg = await newPage(browser, { viewport: { width: 1440, height: 900 } });
    google.nextUser = { sub: 'ui-1', email: 'gina@example.com', name: 'Gina Google' };
    await gg.page.goto(BASE + '/#/login');
    await gg.page.waitForSelector('#google-login');
    check('the login page offers "Continue with Google"', /Continue with Google/.test(await gg.page.textContent('#google-login')));
    await gg.page.screenshot({ path: path.join(SHOTS, 'desktop-login.png') });
    await gg.page.click('#google-login');
    await gg.page.waitForFunction(() => location.hash === '#/signup/google_role' && document.querySelector('.form-error'));
    check('a new Google user is asked to choose owner or agent', /Choose owner or agent/.test(await gg.page.textContent('.form-error')));
    await gg.page.check('input[value=agent]');
    check('the Google button follows the chosen role', (await gg.page.getAttribute('#google-login', 'href')) === '/auth/google?role=agent');
    await gg.page.click('#google-login');
    await gg.page.waitForSelector('.empty');
    check('signing up with Google as an agent lands on the dashboard, logged in', (await gg.page.locator('.side-links a[href="#/clients"]').count()) === 1 && /Gina Google/.test(await gg.page.textContent('.side-user')));
    await gg.page.goto(BASE + '/#/settings'); await gg.page.waitForSelector('#logout');
    check('Settings shows Google as the sign-in method and asks for no current password', /Google/.test(await gg.page.textContent('.dl')) && (await gg.page.locator('input[name=current]').count()) === 0 && (await gg.page.locator('input[name=next]').count()) === 1);
    await gg.page.click('#logout');
    await gg.page.waitForSelector('#google-login');
    await gg.page.click('#google-login');
    await gg.page.waitForSelector('.empty');
    check('logging in again with Google goes straight to the dashboard', /Gina Google/.test(await gg.page.textContent('.side-user')));
    google.nextUser = { sub: 'ui-2', email: 'nomail@example.com', email_verified: false };
    await gg.page.goto(BASE + '/#/settings'); await gg.page.waitForSelector('#logout'); await gg.page.click('#logout');
    await gg.page.waitForSelector('#google-login'); await gg.page.click('#google-login');
    await gg.page.waitForFunction(() => location.hash === '#/login/google_unverified' && document.querySelector('.form-error'));
    check('a failed Google sign-in returns to the login page with a clear message', /no verified email/.test(await gg.page.textContent('.form-error')));
    await gg.ctx.close();

    group = 'Browser errors';
    check('no script errors or blocked-content warnings in the browser', problems.length === 0, problems);
  } finally {
    await browser.close();
    server.kill();
    google.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  if (serverErr.trim()) console.log('\nServer error output:\n' + serverErr);
  console.log('\nRESULTS');
  for (const g of [...new Set(results.map((x) => x.group))]) {
    const rows = results.filter((x) => x.group === g);
    console.log(`  ${rows.every((x) => x.ok) ? 'PASS' : 'FAIL'}  ${g}  (${rows.filter((x) => x.ok).length}/${rows.length})`);
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
