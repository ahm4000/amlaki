'use strict';
// A stand-in for Google's sign-in servers, used only by the automated tests.
// The "code" it accepts is base64url JSON of the identity claims the test wants Google to return.
const http = require('node:http');

function startFakeGoogle(clientId) {
  const info = { tokenRequests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/auth') {
      // Behaves like a user who immediately approves: sends the browser back with a code.
      const who = url.searchParams.get('login_hint_test') || info.nextUser;
      const code = Buffer.from(JSON.stringify({ ...who, nonce: url.searchParams.get('nonce') })).toString('base64url');
      res.writeHead(302, { Location: url.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + encodeURIComponent(url.searchParams.get('state')) });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body));
        info.tokenRequests.push(form);
        let claims;
        try { claims = JSON.parse(Buffer.from(form.code, 'base64url').toString('utf8')); } catch { claims = null; }
        if (!claims || claims.reject) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_grant"}'); }
        const full = { iss: 'https://accounts.google.com', aud: clientId, exp: Math.floor(Date.now() / 1000) + 300, email_verified: true, ...claims };
        const idToken = 'e30.' + Buffer.from(JSON.stringify(full)).toString('base64url') + '.sig';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'x', id_token: idToken }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    ok(Object.assign(info, { origin, authUrl: origin + '/auth', tokenUrl: origin + '/token', close: () => server.close() }));
  }));
}
module.exports = { startFakeGoogle };
