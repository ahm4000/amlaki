'use strict';
(function () {
  const root = document.getElementById('app');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let me = null;
  let config = { google: false };
  let lang = store.get('lang') === 'ar' ? 'ar' : 'en';
  let renderToken = 0;

  // ---------- small helpers ----------
  function t(key, vars) {
    let s = window.I18N[lang][key];
    if (s == null) s = window.I18N.en[key];
    if (s == null) s = key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'for') el.htmlFor = v;
      else if (k in el && !k.includes('-')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }
  const ICONS = {
    dashboard: 'M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z',
    properties: 'M3 11l9-8 9 8M5 10v10h14V10',
    payments: 'M3 6h18v12H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    maintenance: 'M14.5 6.5a4 4 0 0 0-5.2 5.2L3 18l3 3 6.3-6.3a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.5-2.5z',
    expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
    tenants: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
    files: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    clients: 'M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2 20a7 7 0 0 1 14 0M17 6a3 3 0 0 1 0 6M22 20a6 6 0 0 0-4-5.6',
    settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0',
    plus: 'M12 5v14M5 12h14',
  };
  const icon = (name, size) => svg('svg', { width: size || 18, height: size || 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d: ICONS[name] }));
  const logo = () => svg('svg', { width: 34, height: 34, viewBox: '0 0 34 34', 'aria-hidden': 'true' },
    svg('rect', { width: 34, height: 34, rx: 9, fill: '#DDB876' }),
    svg('path', { d: 'M10 26V15a7 7 0 0 1 14 0v11M17 26v-6', fill: 'none', stroke: '#0B1310', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));

  const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const aed = (n) => t('aed') + ' ' + money(n);
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));
  const locale = () => (lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB');
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const monthName = (i) => new Date(2024, i, 1).toLocaleDateString(locale(), { month: 'short' });
  const daysText = (d) => (d < 0 ? t('days_late', { n: -d }) : d === 0 ? t('today') : t('in_days', { n: d }));
  const dayDiff = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);
  const mapsLink = (p) => (p.maps_url && /^https:\/\//i.test(p.maps_url) ? p.maps_url : 'https://www.google.com/maps?q=' + p.lat + ',' + p.lng);

  function errText(code) {
    if (!code) return t('err.generic');
    const known = window.I18N.en['err.' + code];
    if (known) return t('err.' + code);
    const m = /^(\w+): (.+)$/.exec(code);
    if (m) {
      const field = window.I18N.en['f.' + m[1]] ? t('f.' + m[1]) : m[1];
      const msg = window.I18N.en['v.' + m[2]] ? t('v.' + m[2]) : m[2];
      return field + ': ' + msg;
    }
    return t('err.generic');
  }
  async function api(method, url, body, raw) {
    const opt = { method, headers: { 'x-requested-with': 'amlaki' }, credentials: 'same-origin' };
    if (raw) { opt.body = raw.body; opt.headers['content-type'] = raw.type; }
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, opt); } catch { throw new Error(t('err.network')); }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && me) { me = null; location.hash = '#/login'; }
    if (!res.ok) throw new Error(errText(data && data.error));
    return data;
  }
  function toast(msg, bad) {
    const el = h('div', { class: 'toast' + (bad ? ' toast-bad' : ''), role: 'status' }, msg);
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }
  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

  function pill(status) { return h('span', { class: 'pill st-' + status }, t('st.' + status)); }

  // ---------- dialogs ----------
  function openDialog(title, body, wide) {
    const dlg = h('dialog', { class: 'dlg' + (wide ? ' dlg-wide' : '') },
      h('div', { class: 'dlg-head' }, h('h2', {}, title), h('button', { class: 'btn-ghost', type: 'button', 'aria-label': t('close'), onclick: () => dlg.close() }, '✕')),
      body);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }
  function confirmBox(message, yesLabel) {
    return new Promise((resolve) => {
      let answer = false;
      const dlg = openDialog(t('confirm'), h('div', { class: 'dlg-body' },
        h('p', {}, message),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('cancel')),
          h('button', { class: 'btn btn-danger', type: 'button', id: 'confirm-yes', onclick: () => { answer = true; dlg.close(); } }, yesLabel || t('delete')))));
      dlg.addEventListener('close', () => resolve(answer));
    });
  }
  function field(f, value) {
    const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
    let input;
    if (f.type === 'select') {
      input = h('select', { id, name: f.name, required: !!f.required },
        f.options.map((o) => h('option', { value: o.value, selected: String(value ?? '') === String(o.value) }, o.label)));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: 3, required: !!f.required }, value || '');
    } else {
      input = h('input', { id, name: f.name, type: f.type, required: !!f.required, value: value == null ? '' : String(value), placeholder: f.placeholder || '' });
      if (f.type === 'number') { input.min = '0'; input.step = f.step || 'any'; input.inputMode = 'decimal'; }
    }
    return h('div', { class: 'field' + (f.wide ? ' field-wide' : '') },
      h('label', { for: id }, f.label || t('f.' + f.name), f.required ? null : h('span', { class: 'opt' }, ' · ' + t('optional'))),
      input, f.hint ? h('small', {}, f.hint) : null);
  }
  function formDialog(title, fields, values, onSubmit, submitLabel) {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel || t('save'));
    const form = h('form', { class: 'dlg-body', novalidate: false },
      h('div', { class: 'form-grid' }, fields.map((f) => field(f, values ? values[f.name] : f.value))),
      error,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('cancel')), submit));
    const dlg = openDialog(title, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const vals = Object.fromEntries(new FormData(form).entries());
      submit.disabled = true;
      error.textContent = '';
      try { await onSubmit(vals); dlg.close(); } catch (err) { error.textContent = err.message; submit.disabled = false; }
    });
    return dlg;
  }

  // ---------- record kinds ----------
  const KINDS = {
    payments: [{ name: 'due_date', type: 'date', required: true }, { name: 'amount', type: 'number', required: true }, { name: 'paid_date', type: 'date' }, { name: 'note', type: 'text', wide: true }],
    tenants: [{ name: 'name', type: 'text', required: true, wide: true }, { name: 'phone', type: 'tel' }, { name: 'email', type: 'email' }, { name: 'contract_start', type: 'date', required: true }, { name: 'duration_months', type: 'number', step: '1', createOnly: true, get hint() { return t('h.duration'); } }, { name: 'contract_end', type: 'date', get hint() { return t('h.contract_end'); } }, { name: 'annual_rent', type: 'number' },
      { name: 'cheques', type: 'select', createOnly: true, wide: true, get options() { return [{ value: 0, label: t('cheques.none') }].concat([1, 2, 3, 4, 6, 12].map((n) => ({ value: n, label: t('cheques.n', { n }) }))); }, get hint() { return t('h.cheques'); } }],
    maintenance: [{ name: 'date', type: 'date', required: true }, { name: 'title', type: 'text', required: true }, { name: 'contractor', type: 'text' }, { name: 'cost', type: 'number' }, { name: 'notes', type: 'textarea', wide: true }],
    reminders: [{ name: 'title', type: 'text', required: true, wide: true }, { name: 'interval_months', type: 'number', required: true, step: '1' }, { name: 'next_due', type: 'date', required: true }],
    expenses: [{ name: 'date', type: 'date', required: true }, { name: 'category', type: 'select', required: true, get options() { return [{ value: 'service', label: t('d.cat.service') }, { value: 'other', label: t('d.cat.other') }]; } }, { name: 'amount', type: 'number', required: true }, { name: 'note', type: 'text', wide: true }],
  };
  function paymentStatus(r, today) {
    if (r.paid_date) return 'paid';
    const d = dayDiff(today, r.due_date);
    return d < 0 ? 'overdue' : d <= 30 ? 'due' : 'upcoming';
  }
  function columns(kind, today) {
    const c = {
      payments: [['f.due_date', (r) => fmtDate(r.due_date)], ['f.amount', (r) => aed(r.amount), 'num'], ['f.paid_date', (r) => (r.paid_date ? fmtDate(r.paid_date) : '—')], ['f.status', (r) => pill(paymentStatus(r, today))], ['f.note', (r) => r.note || '']],
      tenants: [['f.name', (r) => r.name], ['f.phone', (r) => r.phone || '—'], ['f.email', (r) => r.email || '—'], ['f.contract_start', (r) => fmtDate(r.contract_start)], ['f.contract_end', (r) => fmtDate(r.contract_end)], ['f.duration', (r) => t('months_n', { n: r.duration_months })], ['f.cheques', (r) => (r.cheques ? r.cheques : '—')], ['f.annual_rent', (r) => aed(r.annual_rent), 'num']],
      maintenance: [['f.date', (r) => fmtDate(r.date)], ['f.title', (r) => r.title], ['f.contractor', (r) => r.contractor || '—'], ['f.cost', (r) => aed(r.cost), 'num']],
      reminders: [['f.title', (r) => r.title], ['f.interval_months', (r) => t('p.every_months', { n: r.interval_months })], ['f.next_due', (r) => fmtDate(r.next_due)], ['f.status', (r) => { const d = dayDiff(today, r.next_due); return h('span', { class: 'pill st-' + (d < 0 ? 'overdue' : d <= 30 ? 'due' : 'upcoming') }, daysText(d)); }]],
      expenses: [['f.date', (r) => fmtDate(r.date)], ['f.category', (r) => t('d.cat.' + (r.category === 'service' ? 'service' : 'other'))], ['f.amount', (r) => aed(r.amount), 'num'], ['f.note', (r) => r.note || '']],
    };
    return c[kind];
  }
  function recordForm(kind, propertyId, rec, done) {
    formDialog(t(rec ? 'edit' : 'add') + ' · ' + t('kind.' + kind), KINDS[kind].filter((f) => !rec || !f.createOnly), rec, async (vals) => {
      if (rec) await api('PUT', '/api/records/' + kind + '/' + rec.id, vals);
      else await api('POST', '/api/properties/' + propertyId + '/' + kind, vals);
      done();
    });
  }
  function recordTable(kind, rows, today, refresh, withProperty) {
    if (!rows.length) return h('p', { class: 'muted' }, t('p.empty'));
    const cols = columns(kind, today);
    const head = h('tr', {}, withProperty ? h('th', {}, t('f.property')) : null, cols.map((c) => h('th', { class: c[2] || '' }, t(c[0]))), h('th', { class: 'actions' }, t('actions')));
    const body = rows.map((r) => {
      const acts = [];
      if (kind === 'payments' && !r.paid_date) acts.push(h('button', { class: 'btn-link', type: 'button', onclick: async () => { try { await api('PUT', '/api/records/payments/' + r.id, { ...r, paid_date: today }); toast(t('saved')); refresh(); } catch (e) { toast(e.message, true); } } }, t('p.mark_paid')));
      if (kind === 'reminders') acts.push(h('button', { class: 'btn-link', type: 'button', onclick: () => formDialog(t('p.done') + ' · ' + r.title, [{ name: 'date', type: 'date', required: true, value: today }, { name: 'cost', type: 'number' }, { name: 'contractor', type: 'text', wide: true }], null, async (v) => { await api('POST', '/api/reminders/' + r.id + '/done', v); refresh(); }) }, t('p.done')));
      if (kind === 'maintenance') acts.push(h('button', { class: 'btn-link', type: 'button', onclick: () => maintenancePhotos(r, refresh) }, t('p.photos')));
      acts.push(h('button', { class: 'btn-link', type: 'button', onclick: () => recordForm(kind, r.property_id, r, refresh) }, t('edit')));
      if (r.can_delete) acts.push(h('button', { class: 'btn-link danger', type: 'button', onclick: async () => { if (!(await confirmBox(t('confirm_delete')))) return; try { await api('DELETE', '/api/records/' + kind + '/' + r.id); refresh(); } catch (e) { toast(e.message, true); } } }, t('delete')));
      return h('tr', {}, withProperty ? h('td', {}, h('a', { href: '#/property/' + r.property_id }, r.property_name)) : null, cols.map((c) => h('td', { class: c[2] || '' }, c[1](r))), h('td', { class: 'actions' }, acts));
    });
    return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, body)));
  }

  // ---------- uploads ----------
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.85));
  }
  async function uploadFile(propertyId, file, kind, extra) {
    let blob = file, name = file.name || 'file';
    if (kind === 'photo') { try { blob = await shrink(file); name = name.replace(/\.[^.]+$/, '') + '.jpg'; } catch { /* send as is */ } }
    const qs = new URLSearchParams({ kind, name, ...(extra || {}) });
    return api('POST', '/api/properties/' + propertyId + '/files?' + qs, undefined, { body: blob, type: 'application/octet-stream' });
  }
  function fileInput(label, accept, multiple, onFiles) {
    const input = h('input', { type: 'file', accept, multiple, class: 'sr-only' });
    const btn = h('label', { class: 'btn btn-outline' }, label, input);
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      btn.classList.add('busy');
      try { await onFiles(files); } catch (e) { toast(e.message, true); }
      btn.classList.remove('busy');
    });
    return btn;
  }
  function photoGrid(files, refresh) {
    if (!files.length) return h('p', { class: 'muted' }, t('p.empty'));
    return h('div', { class: 'photos' }, files.map((f) => h('div', { class: 'photo' },
      h('a', { href: '/api/files/' + f.id, target: '_blank', rel: 'noopener' }, h('img', { src: '/api/files/' + f.id, alt: f.name, loading: 'lazy' })),
      f.can_delete ? h('button', { class: 'photo-del', type: 'button', 'aria-label': t('delete'), onclick: async () => { if (!(await confirmBox(t('confirm_delete')))) return; try { await api('DELETE', '/api/files/' + f.id); refresh(); } catch (e) { toast(e.message, true); } } }, '✕') : null)));
  }
  async function maintenancePhotos(rec, refresh) {
    const box = h('div', { class: 'dlg-body' });
    const dlg = openDialog(t('p.photos') + ' · ' + rec.title, box, true);
    const load = async () => {
      const d = await api('GET', '/api/properties/' + rec.property_id);
      box.replaceChildren(
        photoGrid(d.files.filter((f) => f.maintenance_id === rec.id), load),
        h('div', { class: 'dlg-actions' }, fileInput(t('p.upload'), 'image/*', true, async (files) => { for (const f of files) await uploadFile(rec.property_id, f, 'photo', { maintenance_id: rec.id }); await load(); })));
    };
    dlg.addEventListener('close', refresh);
    try { await load(); } catch (e) { box.textContent = e.message; }
  }

  // ---------- art for properties without a photo ----------
  function art(type) {
    const g = { viewBox: '0 0 120 96', width: 120, height: 96, 'aria-hidden': 'true' };
    if (type === 'apartment') return svg('svg', g, svg('rect', { x: 22, y: 14, width: 76, height: 82, rx: 6, fill: 'currentColor', opacity: 0.35 }), svg('path', { d: 'M36 30h12M54 30h12M72 30h12M36 46h12M54 46h12M72 46h12M36 62h12M54 62h12M72 62h12', stroke: '#0B1310', 'stroke-opacity': 0.5, 'stroke-width': 8 }));
    if (type === 'shop') return svg('svg', g, svg('rect', { x: 14, y: 40, width: 92, height: 56, rx: 4, fill: 'currentColor', opacity: 0.3 }), svg('path', { d: 'M10 40l8-18h84l8 18z', fill: 'currentColor', opacity: 0.5 }), svg('rect', { x: 46, y: 58, width: 28, height: 38, fill: '#0B1310', opacity: 0.5 }));
    if (type === 'land') return svg('svg', g, svg('path', { d: 'M6 96l30-34 22 18 20-30 36 46z', fill: 'currentColor', opacity: 0.35 }));
    return svg('svg', g, svg('path', { d: 'M10 96V44a50 50 0 0 1 100 0v52', fill: 'currentColor', opacity: 0.35 }), svg('path', { d: 'M38 96V52a22 22 0 0 1 44 0v44', fill: '#0B1310', opacity: 0.5 }));
  }
  function cover(p, cls) {
    return h('div', { class: 'cover tone-' + p.summary.status + ' ' + (cls || '') }, p.cover_id ? h('img', { src: '/api/files/' + p.cover_id, alt: '', loading: 'lazy' }) : art(p.type));
  }
  function propertyCard(p) {
    const s = p.summary;
    const pct = s.expected > 0 ? Math.min(100, Math.round((s.received / s.expected) * 100)) : 0;
    return h('a', { class: 'card pcard', href: '#/property/' + p.id },
      h('div', { class: 'pcard-top' }, cover(p), h('div', { class: 'pcard-pill' }, pill(s.status))),
      h('div', { class: 'pcard-body' },
        h('strong', {}, p.name),
        h('span', { class: 'muted' }, [t('type.' + p.type), p.area || p.emirate].filter(Boolean).join(' · ')),
        me.role === 'agent' ? h('span', { class: 'muted' }, t('p.owner') + ': ' + (p.owner_name || '—')) : null,
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill' + (s.status === 'overdue' ? ' bad' : ''), style: { width: pct + '%' } })),
        h('span', { class: 'muted' }, t('d.collected_of', { a: short(s.received), b: short(s.expected) }))));
  }

  // ---------- layout ----------
  function navItems() {
    const items = [['dashboard', '#/dashboard'], ['properties', '#/properties'], ['payments', '#/list/payments'], ['maintenance', '#/list/maintenance'], ['expenses', '#/list/expenses'], ['tenants', '#/list/tenants'], ['files', '#/list/files']];
    if (me.role === 'agent') items.push(['clients', '#/clients']);
    items.push(['settings', '#/settings']);
    return items;
  }
  function shell(active, content) {
    const side = h('nav', { class: 'side', 'aria-label': t('nav.menu') },
      h('a', { class: 'brand', href: '#/dashboard' }, logo(), h('span', {}, h('b', {}, 'Amlaki'), h('i', { lang: 'ar' }, 'أملاكي'))),
      h('div', { class: 'side-links' }, navItems().map(([k, href]) => h('a', { href, class: active === k ? 'on' : '' }, icon(k), t('nav.' + k)))),
      h('div', { class: 'side-user' }, h('b', {}, me.name), h('span', {}, t('auth.' + me.role))));
    const bottom = h('nav', { class: 'bottom', 'aria-label': t('nav.menu') },
      h('a', { href: '#/dashboard', class: active === 'dashboard' ? 'on' : '' }, icon('dashboard', 22), t('nav.home')),
      h('a', { href: '#/properties', class: active === 'properties' ? 'on' : '' }, icon('properties', 22), t('nav.properties')),
      h('a', { href: '#/new', class: 'fab', 'aria-label': t('nav.add') }, icon('plus', 24)),
      h('a', { href: '#/list/payments', class: active === 'payments' ? 'on' : '' }, icon('payments', 22), t('nav.money')),
      h('a', { href: '#/settings', class: ['settings', 'maintenance', 'expenses', 'tenants', 'files', 'clients'].includes(active) ? 'on' : '' }, icon('settings', 22), t('nav.more')));
    return h('div', { class: 'shell' }, side, h('main', { class: 'main' }, content), bottom);
  }
  const pageHead = (title, sub, ...actions) => h('header', { class: 'page-head' }, h('div', {}, sub ? h('div', { class: 'eyebrow' }, sub) : null, h('h1', {}, title)), h('div', { class: 'head-actions' }, actions));

  // ---------- auth ----------
  function langSwitch() {
    return h('div', { class: 'lang' }, ['en', 'ar'].map((l) => h('button', { type: 'button', class: lang === l ? 'on' : '', onclick: () => { lang = l; store.set('lang', l); render(); } }, l === 'en' ? 'English' : 'العربية')));
  }
  function authPage(mode, note) {
    const signup = mode === 'signup';
    const error = h('p', { class: 'form-error', role: 'alert' });
    if (note === 'google_role') error.textContent = t('auth.google_role');
    else if (note === 'google_failed' || note === 'google_unverified') error.textContent = t('err.' + note);
    const googleBtn = config.google ? h('a', { class: 'btn btn-block btn-google', id: 'google-login', href: '/auth/google' + (signup ? '?role=owner' : '') }, t('auth.google')) : null;
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t(signup ? 'auth.signup' : 'auth.login'));
    const form = h('form', { class: 'auth-form' },
      signup ? field({ name: 'name', type: 'text', required: true, label: t('auth.name') }) : null,
      field({ name: 'email', type: 'email', required: true, label: t('auth.email') }),
      field({ name: 'password', type: 'password', required: true, label: t('auth.password'), hint: signup ? t('auth.pw_hint') : null }),
      signup ? h('fieldset', { class: 'roles' }, h('legend', {}, t('auth.role')),
        h('label', {}, h('input', { type: 'radio', name: 'role', value: 'owner', checked: true }), h('span', {}, h('b', {}, t('auth.owner')), h('small', {}, t('auth.owner_hint')))),
        h('label', {}, h('input', { type: 'radio', name: 'role', value: 'agent' }), h('span', {}, h('b', {}, t('auth.agent')), h('small', {}, t('auth.agent_hint'))))) : null,
      error, submit);
    if (googleBtn && signup) form.addEventListener('change', () => { googleBtn.href = '/auth/google?role=' + (form.querySelector('input[name=role]:checked') || { value: 'owner' }).value; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        me = await api('POST', signup ? '/api/signup' : '/api/login', Object.fromEntries(new FormData(form).entries()));
        go('#/dashboard');
      } catch (err) { error.textContent = err.message; submit.disabled = false; }
    });
    return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, logo(), h('span', {}, h('b', {}, 'Amlaki'), h('i', { lang: 'ar' }, 'أملاكي'))),
      h('h1', {}, t(signup ? 'auth.signup_title' : 'auth.login_title')),
      h('p', { class: 'muted' }, t('auth.tagline')),
      form,
      googleBtn ? [h('div', { class: 'divider' }, t('auth.or')), googleBtn, signup ? h('p', { class: 'muted center' }, t('auth.google_role_hint')) : null] : null,
      h('p', { class: 'muted center' }, h('a', { href: signup ? '#/login' : '#/signup' }, t(signup ? 'auth.to_login' : 'auth.to_signup'))),
      langSwitch()));
  }

  // ---------- dashboard ----------
  function ring(pct) {
    const c = 2 * Math.PI * 52;
    return h('div', { class: 'ring' },
      svg('svg', { width: 124, height: 124, viewBox: '0 0 124 124', role: 'img', 'aria-label': pct + '% ' + t('d.collected') },
        svg('circle', { cx: 62, cy: 62, r: 52, fill: 'none', stroke: '#22352C', 'stroke-width': 10 }),
        svg('circle', { cx: 62, cy: 62, r: 52, fill: 'none', stroke: '#DDB876', 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-dasharray': (c * pct) / 100 + ' ' + c, transform: 'rotate(-90 62 62)' })),
      h('div', { class: 'ring-text' }, h('b', {}, pct + '%'), h('span', {}, t('d.collected'))));
  }
  function attentionList(items) {
    if (!items.length) return h('p', { class: 'muted' }, t('d.nothing'));
    return h('div', { class: 'att' }, items.map((a) => {
      const tone = a.days < 0 ? 'overdue' : a.days <= 14 ? 'due' : 'upcoming';
      const d = new Date(a.date + 'T00:00:00');
      const title = a.type === 'rent_overdue' || a.type === 'rent_due' ? t('att.' + a.type) + ' · ' + aed(a.amount)
        : a.type === 'maintenance' ? a.title : a.type === 'contract' ? t('att.contract') + ' · ' + a.title : t('att.inspection');
      return h('a', { class: 'att-row', href: '#/property/' + a.property_id },
        h('div', { class: 'date-tile st-' + tone }, h('b', {}, String(d.getDate()).padStart(2, '0')), h('span', {}, monthName(d.getMonth()))),
        h('div', { class: 'att-text' }, h('strong', {}, title), h('span', { class: 'muted' }, a.property_name + ' · ' + daysText(a.days))));
    }));
  }
  async function dashboard() {
    const year = Number(store.get('year')) || new Date().getFullYear();
    const d = await api('GET', '/api/dashboard?year=' + year);
    const T = d.totals;
    const hour = new Date().getHours();
    const greet = t(hour < 12 ? 'd.morning' : hour < 18 ? 'd.afternoon' : 'd.evening');
    const thisYear = new Date().getFullYear();
    const yearSel = h('select', { class: 'select-sm', 'aria-label': t('year'), onchange: (e) => { store.set('year', e.target.value); render(); } },
      [thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => h('option', { value: y, selected: y === d.year }, y)));
    const bell = h('a', { class: 'icon-btn', href: '#attention', 'aria-label': t('d.attention') + ': ' + d.attention.length, onclick: (e) => { e.preventDefault(); const el = document.getElementById('attention'); if (el) el.scrollIntoView({ behavior: 'smooth' }); } },
      icon('bell', 20), d.attention.length ? h('span', { class: 'badge' }, d.attention.length) : null);
    const head = pageHead(greet + ', ' + me.name.split(' ')[0], new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      yearSel, bell, h('a', { class: 'btn btn-primary', href: '#/new' }, '+ ' + t('nav.add')));
    if (!d.properties.length) {
      return h('div', { class: 'page' }, head, h('section', { class: 'card empty' }, h('h2', {}, t('d.empty_title')), h('p', { class: 'muted' }, t('d.empty_text')), h('a', { class: 'btn btn-primary', href: '#/new' }, '+ ' + t('d.add_first'))));
    }
    const split = T.received + T.outstanding;
    const summary = h('section', { class: 'card hero', 'aria-label': t('d.net') },
      h('div', { class: 'hero-top' },
        h('div', {}, h('div', { class: 'eyebrow' }, t('d.net') + ' · ' + d.year),
          h('div', { class: 'big' }, h('span', {}, t('aed')), h('b', { id: 'net-profit' }, money(T.net))),
          h('p', { class: 'muted' }, t('d.net_sub', { n: T.properties }))),
        ring(T.collected_pct)),
      split > 0 ? h('div', { class: 'split' }, h('div', { class: 'ok', style: { flex: String(T.received || 0.001) } }), T.outstanding > 0 ? h('div', { class: 'bad', style: { flex: String(T.outstanding) } }) : null) : null,
      h('div', { class: 'stats' },
        h('div', {}, h('span', { class: 'dot ok' }, t('d.received')), h('b', { id: 'tot-received' }, money(T.received)), h('small', {}, t('d.of_expected', { n: money(T.expected) }))),
        h('div', {}, h('span', { class: 'dot bad' }, t('d.outstanding')), h('b', { id: 'tot-outstanding', class: T.outstanding > 0 ? 'bad-text' : '' }, money(T.outstanding)), h('small', {}, t('d.overdue_n', { n: money(T.overdue) }))),
        h('div', {}, h('span', { class: 'dot info' }, t('d.expenses')), h('b', { id: 'tot-expenses' }, money(T.expenses)), h('small', {}, t('d.all_props'))),
        h('div', {}, h('span', { class: 'dot' }, t('d.total')), h('b', { id: 'tot-properties' }, T.properties), h('small', {}, t('d.occ_vac', { a: T.occupied, b: T.vacant })))));

    const mapHost = h('div', { class: 'map-host' });
    const located = d.properties.filter((p) => p.lat != null && p.lng != null);
    const mapCard = h('section', { class: 'card map-card', 'aria-label': t('d.map') },
      h('div', { class: 'map-title' }, h('div', { class: 'eyebrow' }, t('d.map')), located.length ? null : h('span', { class: 'muted' }, t('d.no_location'))), mapHost,
      h('div', { class: 'legend map-legend' }, ['rented', 'renewal', 'overdue', 'vacant'].map((s) => h('span', { class: 'dot st-' + s }, t('st.' + s)))));
    setTimeout(() => {
      if (!mapHost.isConnected) return;
      const map = new window.MiniMap(mapHost, { lat: 25.3, lng: 55.4, zoom: 8 });
      for (const p of located) map.addMarker(p.lat, p.lng, h('a', { href: '#/property/' + p.id, class: 'map-pin st-' + p.summary.status }, h('i', {}), p.name));
      map.fit();
    }, 0);

    const cal = h('section', { class: 'card grow2', id: 'rent' },
      h('div', { class: 'card-head' }, h('h2', {}, t('d.calendar') + ' ' + d.year), h('div', { class: 'legend' }, ['paid', 'due', 'overdue', 'upcoming'].map((s) => h('span', { class: 'dot st-' + s }, t('st.' + s))))),
      h('div', { class: 'tbl-wrap' }, h('div', { class: 'cal' },
        h('div', { class: 'cal-row cal-head' }, h('span', {}), Array.from({ length: 12 }, (_, i) => h('span', {}, monthName(i)))),
        d.calendar.map((row) => h('div', { class: 'cal-row' }, h('a', { href: '#/property/' + row.property_id }, row.name),
          row.months.map((m) => (m ? h('div', { class: 'cell st-' + m.status, title: aed(m.amount) + ' · ' + t('st.' + m.status) }, short(m.amount)) : h('div', { class: 'cell' }))))))),
      h('p', { class: 'muted' }, t('d.calendar_sub')));
    const att = h('section', { class: 'card grow1', id: 'attention' }, h('div', { class: 'card-head' }, h('h2', {}, t('d.attention')), h('span', { class: 'muted' }, d.attention.length)), attentionList(d.attention));

    const max = Math.max(1, ...d.monthly.map((m) => Math.max(m.income, m.expenses)));
    const chart = h('section', { class: 'card grow2' },
      h('div', { class: 'card-head' }, h('h2', {}, t('d.chart')), h('div', { class: 'legend' }, h('span', { class: 'dot ok' }, t('d.income')), h('span', { class: 'dot info' }, t('d.expenses')))),
      h('div', { class: 'chart', role: 'img', 'aria-label': t('d.chart') }, d.monthly.map((m, i) => h('div', { class: 'chart-col', title: monthName(i) + ': ' + aed(m.income) + ' / ' + aed(m.expenses) },
        h('div', { class: 'bars' }, h('i', { class: 'ok', style: { height: Math.max(1, (m.income / max) * 100) + '%' } }), h('i', { class: 'info', style: { height: Math.max(1, (m.expenses / max) * 100) + '%' } })),
        h('span', {}, monthName(i))))));
    const cats = [['maintenance', 'info'], ['service', 'gold'], ['other', 'grey']];
    const where = h('section', { class: 'card grow1', id: 'expenses' }, h('h2', {}, t('d.where')),
      h('div', { class: 'big small' }, h('span', {}, t('aed')), h('b', {}, money(T.expenses))),
      T.expenses > 0 ? h('div', { class: 'split tall' }, cats.filter(([k]) => d.byCategory[k] > 0).map(([k, c]) => h('div', { class: c, style: { flex: String(d.byCategory[k]) } }))) : null,
      h('div', { class: 'cat-list' }, cats.map(([k, c]) => h('div', {}, h('span', { class: 'dot ' + c }, t('d.cat.' + k)), h('b', {}, money(d.byCategory[k]))))));

    return h('div', { class: 'page' }, head,
      h('div', { class: 'grid2' }, summary, mapCard),
      h('div', { class: 'row' }, cal, att),
      h('div', { class: 'row' }, chart, where),
      h('section', {}, h('div', { class: 'card-head' }, h('h2', {}, t('d.props')), h('a', { href: '#/properties' }, t('all'))), h('div', { class: 'cards' }, d.properties.slice(0, 8).map(propertyCard))));
  }

  // ---------- properties list ----------
  async function properties() {
    const d = await api('GET', '/api/dashboard');
    const grid = h('div', { class: 'cards' });
    const search = h('input', { type: 'search', placeholder: t('search'), 'aria-label': t('search') });
    const typeSel = h('select', { 'aria-label': t('f.type') }, h('option', { value: '' }, t('f.type') + ': ' + t('all')), ['villa', 'apartment', 'shop', 'land', 'other'].map((x) => h('option', { value: x }, t('type.' + x))));
    const statusSel = h('select', { 'aria-label': t('f.status') }, h('option', { value: '' }, t('f.status') + ': ' + t('all')), ['rented', 'renewal', 'overdue', 'vacant'].map((x) => h('option', { value: x }, t('st.' + x))));
    const owners = [...new Set(d.properties.map((p) => p.owner_name).filter(Boolean))].sort();
    const ownerSel = me.role === 'agent' ? h('select', { 'aria-label': t('p.owner') }, h('option', { value: '' }, t('p.owner') + ': ' + t('all')), owners.map((o) => h('option', { value: o }, o))) : null;
    const draw = () => {
      const s = search.value.trim().toLowerCase();
      const rows = d.properties.filter((p) =>
        (!s || [p.name, p.area, p.emirate, p.address, p.owner_name].some((v) => (v || '').toLowerCase().includes(s))) &&
        (!typeSel.value || p.type === typeSel.value) && (!statusSel.value || p.summary.status === statusSel.value) &&
        (!ownerSel || !ownerSel.value || p.owner_name === ownerSel.value));
      grid.replaceChildren(...(rows.length ? rows.map(propertyCard) : [h('p', { class: 'muted' }, t('p.empty'))]));
    };
    for (const el of [search, typeSel, statusSel, ownerSel]) if (el) el.addEventListener('input', draw);
    draw();
    return h('div', { class: 'page' }, pageHead(t('nav.properties'), d.properties.length + ' · ' + t('d.occ_vac', { a: d.totals.occupied, b: d.totals.vacant }), h('a', { class: 'btn btn-primary', href: '#/new' }, '+ ' + t('nav.add'))),
      h('div', { class: 'filters' }, search, typeSel, statusSel, ownerSel), grid);
  }

  // ---------- property page ----------
  async function property(id) {
    const d = await api('GET', '/api/properties/' + id);
    const p = d.property, s = d.summary, refresh = () => render();
    const p2 = { ...p, summary: s };
    const section = (kind, title) => h('section', { class: 'card', id: kind },
      h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'head-actions' },
        kind === 'payments' ? h('button', { class: 'btn btn-primary', type: 'button', id: 'add-cheques', onclick: () => chequesDialog(p, s, d.today, refresh, d.payments.length > 0) }, '+ ' + t('ch.add')) : null,
        h('button', { class: 'btn btn-outline', type: 'button', 'data-add': kind, onclick: () => recordForm(kind, p.id, null, refresh) }, '+ ' + t(kind === 'payments' ? 'ch.single' : 'add')))),
      recordTable(kind, d[kind], d.today, refresh));

    const agentBox = p.can.assign_agent ? h('div', { class: 'agent-box' },
      p.agent_name
        ? [h('span', {}, t('p.agent') + ': ', h('b', {}, p.agent_name), p.agent_email ? ' · ' + p.agent_email : ''), h('button', { class: 'btn-link danger', type: 'button', onclick: async () => { if (!(await confirmBox(t('p.remove_agent_q'), t('p.remove_agent')))) return; try { await api('PUT', '/api/properties/' + p.id + '/agent', { agent_code: null }); refresh(); } catch (e) { toast(e.message, true); } } }, t('p.remove_agent'))]
        : h('button', { class: 'btn-link', type: 'button', onclick: () => formDialog(t('p.assign'), [{ name: 'agent_code', type: 'text', required: true, wide: true, hint: t('p.agent_code_hint') }], null, async (v) => { await api('PUT', '/api/properties/' + p.id + '/agent', v); refresh(); }, t('p.assign')) }, '+ ' + t('p.assign')))
      : h('div', { class: 'agent-box' }, h('span', {}, t('p.owner') + ': ', h('b', {}, p.owner_name || '—'), p.owner_linked ? '' : ' · ' + t('p.owner_not_linked')),
        !p.owner_linked && p.owner_contact_id ? h('button', { class: 'btn-link', type: 'button', id: 'invite-owner', onclick: async () => {
          try {
            const r = await api('POST', '/api/contacts/' + p.owner_contact_id + '/code');
            openDialog(t('p.invite_title'), h('div', { class: 'dlg-body' }, h('p', {}, h('code', { class: 'code big-code', id: 'invite-code' }, r.code)), h('p', {}, t('p.invite_text', { name: p.owner_name }))));
          } catch (e) { toast(e.message, true); }
        } }, t('p.invite')) : null);

    const mapHost = h('div', { class: 'map-host small' });
    if (p.lat != null) setTimeout(() => { if (mapHost.isConnected) new window.MiniMap(mapHost, { lat: p.lat, lng: p.lng, zoom: 15 }).setPin(p.lat, p.lng); }, 0);

    const photos = d.files.filter((f) => f.kind === 'photo' && !f.maintenance_id);
    const docs = d.files.filter((f) => f.kind === 'document');
    const docType = h('select', { class: 'select-sm', 'aria-label': t('f.doc_type') }, ['contract', 'invoice', 'warranty', 'deed', 'other'].map((x) => h('option', { value: x }, t('p.doc.' + x))));

    return h('div', { class: 'page' },
      h('a', { class: 'back', href: '#/properties' }, '← ' + t('nav.properties')),
      h('section', { class: 'card phead' },
        cover(p2, 'phead-cover'),
        h('div', { class: 'phead-body' },
          h('div', { class: 'phead-title' }, h('h1', {}, p.name), pill(s.status)),
          h('p', { class: 'muted' }, [t('type.' + p.type), p.area, p.emirate].filter(Boolean).join(' · ')),
          p.address ? h('p', { class: 'muted' }, p.address) : null,
          agentBox,
          h('div', { class: 'stats' },
            h('div', {}, h('span', {}, t('p.expected')), h('b', {}, money(p.rent_annual)), h('small', {}, t('p.per_year'))),
            h('div', {}, h('span', {}, t('p.received')), h('b', { class: 'ok-text' }, money(s.received)), h('small', {}, t('p.this_year'))),
            h('div', {}, h('span', {}, t('p.expenses')), h('b', {}, money(s.expenses)), h('small', {}, t('p.this_year'))),
            h('div', {}, h('span', {}, t('p.net')), h('b', { class: 'gold-text' }, money(s.net)), h('small', {}, t('p.this_year')))),
          h('div', { class: 'head-actions' },
            h('a', { class: 'btn btn-outline', href: '#/edit/' + p.id }, t('edit')),
            p.can.delete ? h('button', { class: 'btn btn-danger-outline', type: 'button', id: 'delete-property', onclick: async () => { if (!(await confirmBox(t('p.delete_q', { name: p.name })))) return; try { await api('DELETE', '/api/properties/' + p.id); go('#/properties'); } catch (e) { toast(e.message, true); } } }, t('p.delete_property')) : null))),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('f.location')), p.lat != null ? h('a', { href: mapsLink(p), target: '_blank', rel: 'noopener noreferrer' }, t('p.open_maps')) : null),
          p.lat != null ? [mapHost, h('p', { class: 'muted mono' }, p.lat + ', ' + p.lng)] : h('p', { class: 'muted' }, t('p.no_location'))),
        h('section', { class: 'card' }, h('h2', {}, t('p.info')),
          h('dl', { class: 'dl' },
            h('dt', {}, t('p.tenant')), h('dd', {}, s.tenant || t('st.vacant')),
            s.contract ? [h('dt', {}, t('p.contract')), h('dd', { id: 'contract-info' }, fmtDate(s.contract.start) + ' – ' + fmtDate(s.contract.end) + ' · ' + t('months_n', { n: s.contract.months }) + (s.contract.cheques ? ' · ' + t('cheques.n', { n: s.contract.cheques }) : ''))] : null,
            h('dt', {}, t('f.next_inspection')), h('dd', {}, p.next_inspection ? fmtDate(p.next_inspection) + ' · ' + daysText(dayDiff(d.today, p.next_inspection)) : '—'),
            h('dt', {}, t('d.outstanding')), h('dd', {}, aed(s.outstanding)),
            h('dt', {}, t('f.notes')), h('dd', { class: 'pre' }, p.notes || '—')))),
      section('payments', t('p.payments')),
      section('tenants', t('p.tenants')),
      section('reminders', t('p.reminders')),
      section('maintenance', t('p.maintenance')),
      section('expenses', t('p.expenses_title')),
      h('section', { class: 'card', id: 'photos' }, h('div', { class: 'card-head' }, h('h2', {}, t('p.photos')),
        fileInput('+ ' + t('p.upload'), 'image/*', true, async (files) => { for (const f of files) await uploadFile(p.id, f, 'photo'); refresh(); })), photoGrid(photos, refresh)),
      h('section', { class: 'card', id: 'documents' }, h('div', { class: 'card-head' }, h('h2', {}, t('p.documents')),
        h('div', { class: 'head-actions' }, docType, fileInput('+ ' + t('p.upload'), 'application/pdf,image/*', true, async (files) => { for (const f of files) await uploadFile(p.id, f, 'document', { doc_type: docType.value }); refresh(); }))),
        docTable(docs, refresh)));
  }
  // Quick entry of several cheques: total and number of cheques in, amounts and dates out.
  function chequesDialog(p, s, today, refresh, hasPayments) {
    const preview = h('ol', { class: 'cheque-preview', id: 'cheque-preview' });
    const sumLine = h('p', { class: 'muted', id: 'cheque-sum' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, t('ch.create'));
    const top = h('div', { class: 'form-grid' },
      field({ name: 'total', type: 'number', required: true, label: t('ch.total') }, p.rent_annual || ''),
      field({ name: 'count', type: 'select', required: true, label: t('ch.count'), options: [1, 2, 3, 4, 6, 12].map((n) => ({ value: n, label: t('ch.every.' + n) })) }, 4),
      field({ name: 'first_date', type: 'date', required: true, label: t('ch.first') }, s.contract && !hasPayments ? s.contract.start : today),
      field({ name: 'months', type: 'number', required: true, step: '1', label: t('ch.months') }, s.contract ? s.contract.months : 12));
    const form = h('form', { class: 'dlg-body' },
      h('p', { class: 'muted' }, t('ch.intro')), top,
      h('strong', {}, t('ch.preview')), h('p', { class: 'muted' }, t('ch.editable')), preview, sumLine, error,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('cancel')), submit));
    const dlg = openDialog(t('ch.add'), form);
    const rows = () => [...preview.querySelectorAll('li')].map((li) => ({ due_date: li.querySelector('input[type=date]').value, amount: li.querySelector('input[type=number]').value }));
    const showSum = () => { sumLine.textContent = t('ch.sum', { n: rows().length, total: aed(rows().reduce((a, r) => a + (Number(r.amount) || 0), 0)) }); };
    let seq = 0;
    // Changing the boxes at the top recalculates every cheque. Each cheque can then be adjusted by hand.
    const draw = async () => {
      const mine = ++seq;
      try {
        const v = Object.fromEntries([...top.querySelectorAll('input, select')].map((el) => [el.name, el.value]));
        const r = await api('POST', '/api/properties/' + p.id + '/cheques', { ...v, preview: true });
        if (mine !== seq) return;
        error.textContent = '';
        preview.replaceChildren(...r.cheques.map((c, i) => {
          const dateIn = h('input', { type: 'date', value: c.due_date, required: true, 'aria-label': t('f.due_date') + ' ' + (i + 1) });
          const amtIn = h('input', { type: 'number', value: String(c.amount), required: true, min: '0', step: 'any', 'aria-label': t('f.amount') + ' ' + (i + 1) });
          amtIn.inputMode = 'decimal';
          return h('li', {}, h('div', { class: 'cheque-row' }, dateIn, amtIn));
        }));
        showSum();
      } catch (e) { if (mine === seq) { preview.replaceChildren(); sumLine.textContent = ''; error.textContent = e.message; } }
    };
    top.addEventListener('input', draw);
    preview.addEventListener('input', showSum);
    draw();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!rows().length) return;
      submit.disabled = true;
      try { await api('POST', '/api/properties/' + p.id + '/cheques', { items: rows() }); dlg.close(); toast(t('saved')); refresh(); } catch (err) { error.textContent = err.message; submit.disabled = false; }
    });
  }
  function docTable(docs, refresh, withProperty) {
    if (!docs.length) return h('p', { class: 'muted' }, t('p.empty'));
    return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, withProperty ? h('th', {}, t('f.property')) : null, h('th', {}, t('f.file')), h('th', {}, t('f.doc_type')), h('th', {}, t('f.date')), h('th', { class: 'actions' }, t('actions')))),
      h('tbody', {}, docs.map((f) => h('tr', {},
        withProperty ? h('td', {}, h('a', { href: '#/property/' + f.property_id }, f.property_name)) : null,
        h('td', {}, f.name), h('td', {}, t('p.doc.' + (f.doc_type || 'other'))), h('td', {}, fmtDate(String(f.created_at).slice(0, 10))),
        h('td', { class: 'actions' }, h('a', { class: 'btn-link', href: '/api/files/' + f.id, target: '_blank', rel: 'noopener' }, t('open')),
          f.can_delete ? h('button', { class: 'btn-link danger', type: 'button', onclick: async () => { if (!(await confirmBox(t('confirm_delete')))) return; try { await api('DELETE', '/api/files/' + f.id); refresh(); } catch (e) { toast(e.message, true); } } }, t('delete')) : null))))));
  }

  // ---------- all records of one kind ----------
  async function listPage(kind) {
    if (!['payments', 'maintenance', 'expenses', 'tenants', 'files', 'reminders'].includes(kind)) kind = 'payments';
    const d = await api('GET', '/api/records/' + kind);
    const refresh = () => render();
    const total = kind === 'payments' ? d.rows.filter((r) => r.paid_date).reduce((a, r) => a + r.amount, 0)
      : kind === 'maintenance' ? d.rows.reduce((a, r) => a + r.cost, 0) : kind === 'expenses' ? d.rows.reduce((a, r) => a + r.amount, 0) : null;
    const body = kind === 'files' ? docTable(d.rows.filter((f) => f.kind === 'document'), refresh, true) : recordTable(kind, d.rows, d.today, refresh, true);
    const extra = kind === 'maintenance' ? await api('GET', '/api/records/reminders') : null;
    return h('div', { class: 'page' }, pageHead(t('nav.' + kind), total != null ? t('list.total_' + kind) + ': ' + aed(total) : d.rows.length + ''),
      extra ? h('section', { class: 'card' }, h('h2', {}, t('p.reminders')), recordTable('reminders', extra.rows, extra.today, refresh, true)) : null,
      h('section', { class: 'card' }, extra ? h('h2', {}, t('p.maintenance')) : null, body),
      h('p', { class: 'muted' }, t('list.hint')));
  }

  // ---------- add / edit property ----------
  const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];
  async function propForm(id) {
    const editing = !!id;
    const p = editing ? (await api('GET', '/api/properties/' + id)).property : {};
    const contacts = !editing && me.role === 'agent' ? await api('GET', '/api/contacts') : [];
    let lat = p.lat ?? null, lng = p.lng ?? null, mapsUrl = p.maps_url || '';
    const coordText = h('span', { class: 'mono', id: 'coords' });
    const locStatus = h('p', { class: 'muted', id: 'loc-status', role: 'status' }, t('pf.loc_hint'));
    const mapHost = h('div', { class: 'map-host small' });
    let map = null;
    const showLoc = () => {
      coordText.textContent = lat != null ? lat + ', ' + lng : '—';
      if (map && lat != null) map.setPin(lat, lng);
      if (map && lat == null) map.clearMarkers();
    };
    setTimeout(() => {
      if (!mapHost.isConnected) return;
      map = new window.MiniMap(mapHost, { lat: lat ?? 25.3, lng: lng ?? 55.4, zoom: lat != null ? 15 : 8, onPick: (a, b) => { lat = a; lng = b; mapsUrl = ''; locStatus.textContent = t('pf.loc_manual'); showLoc(); } });
      showLoc();
    }, 0);
    const locInput = h('input', { type: 'text', id: 'loc-input', placeholder: t('pf.loc_placeholder'), autocomplete: 'off' });
    const find = async () => {
      const text = locInput.value.trim();
      if (!text) return;
      locStatus.textContent = t('pf.loc_searching');
      locStatus.className = 'muted';
      try {
        const r = await api('POST', '/api/resolve-location', { text });
        lat = r.lat; lng = r.lng; mapsUrl = /^https:\/\//i.test(text) ? text.slice(0, 800) : '';
        locStatus.textContent = t('pf.loc_found');
        locStatus.className = 'ok-text';
        showLoc();
      } catch (e) { locStatus.textContent = e.message + ' ' + t('pf.loc_fallback'); locStatus.className = 'bad-text'; }
    };
    locInput.addEventListener('paste', () => setTimeout(find, 0));
    locInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });

    // Agent: one box for the owner's name. A name already in the agent's list is reused; a new name is added.
    const ownerInput = h('input', { type: 'text', name: 'owner_name', id: 'owner-name', autocomplete: 'off', placeholder: t('pf.owner_placeholder') });
    ownerInput.setAttribute('list', 'owner-list');
    const ownerList = h('datalist', { id: 'owner-list' }, contacts.map((c) => h('option', { value: c.name })));
    const ownerNote = h('small', { id: 'owner-note' }, t('pf.owner_hint'));
    const ownerExtra = h('div', { class: 'form-grid', hidden: true }, field({ name: 'owner_phone', type: 'tel', label: t('pf.owner_phone') }), field({ name: 'owner_email', type: 'email', label: t('pf.owner_email') }));
    const findOwner = () => contacts.find((c) => c.name.trim().toLowerCase() === ownerInput.value.trim().toLowerCase());
    ownerInput.addEventListener('input', () => {
      const match = findOwner(), typed = ownerInput.value.trim();
      ownerNote.textContent = match ? t('pf.owner_existing', { n: match.properties }) : typed ? t('pf.owner_new') : t('pf.owner_hint');
      ownerNote.className = match ? 'ok-text' : '';
      ownerExtra.hidden = !typed || !!match;
    });

    const amount = p.rent_annual != null ? (p.rent_period === 'monthly' ? Math.round((p.rent_annual / 12) * 100) / 100 : p.rent_annual) : '';
    const photoInput = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'new-photos' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'));
    const form = h('form', { class: 'card form-page' },
      h('div', { class: 'form-grid' },
        field({ name: 'name', type: 'text', required: true }, p.name),
        field({ name: 'type', type: 'select', required: true, options: ['villa', 'apartment', 'shop', 'land', 'other'].map((x) => ({ value: x, label: t('type.' + x) })) }, p.type),
        !editing && me.role === 'agent' ? h('div', { class: 'field field-wide' }, h('label', { for: 'owner-name' }, t('pf.owner_label')), ownerInput, ownerList, ownerNote, ownerExtra) : null,
        !editing && me.role === 'owner' ? field({ name: 'agent_code', type: 'text', hint: t('p.agent_code_hint'), wide: true }) : null,
        field({ name: 'address', type: 'text', wide: true }, p.address),
        field({ name: 'emirate', type: 'select', options: [{ value: '', label: '—' }].concat(EMIRATES.map((x) => ({ value: x, label: t('em.' + x) }))) }, p.emirate),
        field({ name: 'area', type: 'text' }, p.area),
        h('div', { class: 'field field-wide' }, h('label', { for: 'loc-input' }, t('pf.loc_label')),
          h('div', { class: 'inline' }, locInput, h('button', { class: 'btn btn-outline', type: 'button', id: 'loc-find', onclick: find }, t('pf.find'))),
          locStatus, mapHost,
          h('div', { class: 'inline' }, coordText, h('button', { class: 'btn-link', type: 'button', onclick: () => { lat = lng = null; mapsUrl = ''; showLoc(); } }, t('pf.loc_clear')))),
        field({ name: 'rent_amount', type: 'number' }, amount),
        field({ name: 'rent_period', type: 'select', required: true, options: [{ value: 'annual', label: t('f.annual') }, { value: 'monthly', label: t('f.monthly') }] }, p.rent_period || 'annual'),
        field({ name: 'next_inspection', type: 'date' }, p.next_inspection),
        editing ? null : h('div', { class: 'field' }, h('label', { for: 'new-photos' }, t('f.photos'), h('span', { class: 'opt' }, ' · ' + t('optional'))), photoInput),
        field({ name: 'notes', type: 'textarea', wide: true }, p.notes)),
      error,
      h('div', { class: 'dlg-actions' }, h('a', { class: 'btn', href: editing ? '#/property/' + id : '#/properties' }, t('cancel')), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form).entries());
      const body = { name: v.name, type: v.type, address: v.address, emirate: v.emirate, area: v.area, rent_amount: v.rent_amount, rent_period: v.rent_period, next_inspection: v.next_inspection, notes: v.notes, lat, lng, maps_url: mapsUrl };
      if (!editing && me.role === 'owner' && v.agent_code) body.agent_code = v.agent_code;
      if (!editing && me.role === 'agent') {
        const match = findOwner();
        if (match) body.contact_id = match.id;
        else if (ownerInput.value.trim()) body.new_contact = { name: ownerInput.value.trim(), phone: v.owner_phone, email: v.owner_email };
        else { error.textContent = t('pf.owner_required'); ownerInput.focus(); return; }
      }
      submit.disabled = true;
      error.textContent = '';
      try {
        let pid = id;
        if (editing) await api('PUT', '/api/properties/' + id, body);
        else pid = (await api('POST', '/api/properties', body)).id;
        if (!editing) for (const f of [...photoInput.files]) { try { await uploadFile(pid, f, 'photo'); } catch (err) { toast(err.message, true); } }
        go('#/property/' + pid);
      } catch (err) { error.textContent = err.message; submit.disabled = false; }
    });
    return h('div', { class: 'page narrow' }, pageHead(t(editing ? 'pf.edit' : 'pf.new')), form);
  }

  // ---------- agent: clients ----------
  async function clients() {
    if (me.role !== 'agent') return dashboard();
    const list = await api('GET', '/api/contacts');
    const refresh = () => render();
    const add = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => formDialog(t('c.add'), [{ name: 'name', type: 'text', required: true, wide: true }, { name: 'phone', type: 'tel' }, { name: 'email', type: 'email' }], null, async (v) => { await api('POST', '/api/contacts', v); refresh(); }) }, '+ ' + t('c.add'));
    const table = list.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, [t('f.name'), t('f.phone'), t('f.email'), t('c.props'), t('c.link'), t('actions')].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, c.phone || '—'), h('td', {}, c.email || '—'), h('td', {}, c.properties),
        h('td', {}, c.linked ? pill('paid') : c.claim_code ? h('code', { class: 'code' }, c.claim_code) : h('span', { class: 'muted' }, t('c.not_linked'))),
        h('td', { class: 'actions' },
          c.linked ? null : h('button', { class: 'btn-link', type: 'button', onclick: async () => { try { const r = await api('POST', '/api/contacts/' + c.id + '/code'); toast(t('c.code_is', { code: r.code })); refresh(); } catch (e) { toast(e.message, true); } } }, t('c.make_code')),
          c.properties ? null : h('button', { class: 'btn-link danger', type: 'button', onclick: async () => { if (!(await confirmBox(t('confirm_delete')))) return; try { await api('DELETE', '/api/contacts/' + c.id); refresh(); } catch (e) { toast(e.message, true); } } }, t('delete')))))))) : h('p', { class: 'muted' }, t('c.empty'));
    return h('div', { class: 'page' }, pageHead(t('nav.clients'), null, add), h('section', { class: 'card' }, table), h('p', { class: 'muted' }, t('c.code_hint')));
  }

  // ---------- settings ----------
  async function settings() {
    const msg = (el, text, ok) => { el.textContent = text; el.className = ok ? 'ok-text' : 'form-error'; };
    const claimMsg = h('p', { role: 'status' });
    const claimForm = h('form', { class: 'inline' }, h('input', { name: 'code', type: 'text', required: true, placeholder: 'XXXXXXXXXX', 'aria-label': t('s.claim'), autocomplete: 'off' }), h('button', { class: 'btn btn-outline', type: 'submit' }, t('s.claim_btn')));
    claimForm.addEventListener('submit', async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/claim', { code: claimForm.code.value }); msg(claimMsg, t('s.claimed', { n: r.properties }), true); claimForm.reset(); } catch (err) { msg(claimMsg, err.message); } });
    const pwMsg = h('p', { role: 'status' });
    const pwForm = h('form', { class: 'form-grid' }, me.has_password ? field({ name: 'current', type: 'password', required: true, label: t('s.current') }) : h('p', { class: 'muted field-wide' }, t('s.no_password')), field({ name: 'next', type: 'password', required: true, label: t('s.new'), hint: t('auth.pw_hint') }), h('div', { class: 'field field-wide' }, h('button', { class: 'btn btn-outline', type: 'submit' }, t('s.change'))));
    pwForm.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/password', Object.fromEntries(new FormData(pwForm).entries())); me.has_password = true; msg(pwMsg, t('s.pw_changed'), true); pwForm.reset(); } catch (err) { msg(pwMsg, err.message); } });
    return h('div', { class: 'page narrow' }, pageHead(t('nav.settings')),
      h('section', { class: 'card more-links' }, h('h2', {}, t('s.more')), h('div', { class: 'chips' }, navItems().filter(([k]) => !['dashboard', 'properties', 'settings'].includes(k)).map(([k, href]) => h('a', { class: 'chip', href }, icon(k), t('nav.' + k))))),
      h('section', { class: 'card' }, h('h2', {}, t('s.language')), langSwitch()),
      h('section', { class: 'card' }, h('h2', {}, t('s.account')), h('dl', { class: 'dl' }, h('dt', {}, t('auth.name')), h('dd', {}, me.name), h('dt', {}, t('auth.email')), h('dd', {}, me.email), h('dt', {}, t('auth.role')), h('dd', {}, t('auth.' + me.role)), h('dt', {}, t('s.signin')), h('dd', {}, [me.google ? 'Google' : null, me.has_password ? t('auth.password') : null].filter(Boolean).join(' + ')))),
      me.role === 'agent' ? h('section', { class: 'card' }, h('h2', {}, t('s.agent_code')), h('p', {}, h('code', { class: 'code big-code', id: 'agent-code' }, me.agent_code)), h('p', { class: 'muted' }, t('s.agent_code_hint'))) : null,
      me.role === 'owner' ? h('section', { class: 'card' }, h('h2', {}, t('s.claim')), h('p', { class: 'muted' }, t('s.claim_hint')), claimForm, claimMsg) : null,
      h('section', { class: 'card' }, h('h2', {}, t('s.password')), pwForm, pwMsg),
      h('button', { class: 'btn btn-danger-outline', type: 'button', id: 'logout', onclick: async () => { try { await api('POST', '/api/logout', {}); } catch { /* ignore */ } me = null; go('#/login'); } }, t('auth.logout')));
  }

  // ---------- router ----------
  const PAGES = { dashboard, properties, property, new: () => propForm(null), edit: propForm, list: listPage, clients, settings };
  async function render() {
    const token = ++renderToken;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    for (const d of document.querySelectorAll('dialog')) d.remove();
    const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
    if (!me) { root.replaceChildren(authPage(page === 'signup' ? 'signup' : 'login', arg)); return; }
    const name = PAGES[page] ? page : 'dashboard';
    const active = name === 'list' ? arg : ['property', 'new', 'edit'].includes(name) ? 'properties' : name;
    if (!root.querySelector('.shell')) root.replaceChildren(shell(active, h('p', { class: 'loading' }, t('loading'))));
    let content;
    try { content = await PAGES[name](arg); } catch (e) { content = h('div', { class: 'page' }, h('section', { class: 'card empty' }, h('h2', {}, e.message), h('a', { class: 'btn btn-outline', href: '#/dashboard' }, t('nav.dashboard')))); }
    if (token !== renderToken) return;
    if (!me) { root.replaceChildren(authPage('login')); return; }
    root.replaceChildren(shell(active, content));
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  (async () => {
    try { config = await api('GET', '/api/config'); } catch { /* keep defaults */ }
    try { me = await api('GET', '/api/me'); } catch { me = null; }
    render();
  })();
})();
