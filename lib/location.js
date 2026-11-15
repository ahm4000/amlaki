'use strict';
// Turns pasted text (coordinates, a Google Maps link, or a short share link) into latitude/longitude.
// Short links are resolved by following redirects, but ONLY to Google Maps hostnames (SSRF guard).

const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
const GOOGLE_RE = /^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const SEP = '\\s*(?:,|;)\\s*\\+?\\s*';

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function allowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!(SHORT_HOSTS.has(host) || GOOGLE_RE.test(host))) return null;
  if (host === 'goo.gl' && !u.pathname.startsWith('/maps')) return null;
  u.protocol = 'https:';
  return u;
}

function dms(text) {
  // 25°47'20.8"N 55°56'35.5"E
  const re = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]\s*([NSns])[\s,+]+(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]\s*([EWew])/;
  const m = re.exec(text);
  if (!m) return null;
  const lat = (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (/s/i.test(m[4]) ? -1 : 1);
  const lng = (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (/w/i.test(m[8]) ? -1 : 1);
  return valid(lat, lng) ? { lat, lng } : null;
}

const URL_PATTERNS = [
  new RegExp('!3d' + NUM + '!4d' + NUM),                                                         // dropped pin / place
  new RegExp('[?&](?:q|query|ll|sll|destination|daddr|center)=(?:loc:)?' + NUM + SEP + NUM, 'i'), // ?q=lat,lng
  new RegExp('/(?:place|search|dir)/' + NUM + SEP + NUM),                                        // /place/lat,lng
  new RegExp('@' + NUM + ',' + NUM),                                                             // map centre
];
const PLAIN = new RegExp('^\\s*\\(?\\s*' + NUM + '\\s*(?:,|;|\\s)\\s*' + NUM + '\\s*\\)?\\s*$');

function parseCoords(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim().slice(0, 4000);
  if (!text) return null;
  const variants = [text];
  try { const d = decodeURIComponent(text); if (d !== text) variants.push(d); } catch { /* keep raw */ }
  for (const v of variants) {
    const p = PLAIN.exec(v);
    if (p) { const lat = Number(p[1]), lng = Number(p[2]); if (valid(lat, lng)) return { lat, lng }; }
    const d = dms(v);
    if (d) return d;
  }
  if (!/https?:\/\//i.test(text)) return null;
  for (const re of URL_PATTERNS) {
    for (const v of variants) {
      const m = re.exec(v);
      if (m) { const lat = Number(m[1]), lng = Number(m[2]); if (valid(lat, lng)) return { lat, lng }; }
    }
  }
  return null;
}

async function readLimited(res, limit) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, limit);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    n += value.length;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

class LocationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function resolveLocation(input, fetchImpl = fetch) {
  const direct = parseCoords(input);
  if (direct) return { ...direct, source: 'direct' };
  const m = /https?:\/\/[^\s<>"']+/i.exec(String(input || ''));
  if (!m) throw new LocationError('not_recognized');
  let url = allowedUrl(m[0]);
  if (!url) throw new LocationError('host_not_allowed');
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetchImpl(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; AmlakiLocationResolver/1.0)', 'accept-language': 'en' },
      });
    } catch { throw new LocationError('resolve_failed'); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      let next;
      try { next = new URL(loc, url); } catch { break; }
      const c = parseCoords(next.href);        // read coordinates from the address itself, without fetching it
      if (c) return { ...c, source: 'link' };
      url = allowedUrl(next.href);
      if (!url) throw new LocationError('no_coordinates');
      continue;
    }
    if (res.status === 200) {
      const body = await readLimited(res, 300 * 1024);
      const pats = [
        new RegExp('@' + NUM + ',' + NUM),
        new RegExp('center=' + NUM + '(?:%2C|,)' + NUM),
        new RegExp('\\[null,null,' + NUM + ',' + NUM + '\\]'),
      ];
      for (const re of pats) {
        const b = re.exec(body);
        if (b) { const lat = Number(b[1]), lng = Number(b[2]); if (valid(lat, lng)) return { lat, lng, source: 'page' }; }
      }
    }
    break;
  }
  throw new LocationError('no_coordinates');
}

module.exports = { parseCoords, resolveLocation, allowedUrl, LocationError };
