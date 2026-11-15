# Amlaki: property management website

A multi-user website for property owners and real estate agents in the UAE: properties, rent, tenants, maintenance, expenses, documents, reminders, a map, and English/Arabic.

It has no external packages. It needs only Node.js 22.13 or newer.

## Run it

```
node server.js
```

Then open http://localhost:3000. The database and uploaded files are created in the `data/` folder. Back that folder up regularly; it holds everything.

## Settings (environment variables)

| Name | What it does | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `DATA_DIR` | Folder for the database and uploads | `./data` |
| `TRUST_PROXY` | Set to `1` when the site runs behind a hosting provider's proxy or load balancer. Needed for correct login rate limits and secure cookies. | off |
| `COOKIE_SECURE` | Set to `1` to always mark the login cookie as HTTPS-only | off |
| `APP_TZ` | Time zone used for "today" | `Asia/Dubai` |
| `MAX_USER_STORAGE_MB` | Upload allowance per user | `1024` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turn on "Continue with Google". See `GOOGLE-LOGIN-SETUP.md`. | off |
| `PUBLIC_URL` | The site's public address, used for the Google sign-in return address | taken from the request |

## Putting it online

For Tasjeel hosting, follow `INSTALL-TASJEEL.md`. On cPanel hosting the startup file is `app.js`.


1. Use a host that runs Node.js 22.13+ and gives you a **persistent disk** (the `data/` folder must survive restarts).
2. Serve it over **HTTPS** only, and set `TRUST_PROXY=1` (most hosts put a proxy in front).
3. Point `DATA_DIR` at the persistent disk and schedule backups of it.
4. Run one copy of the server only. The login rate limits are kept in memory and the database is a single file.

## How the roles work

- **Owner**: full control of their own properties. Can assign one agent to a property by entering the agent's 8-character code (shown in the agent's Settings), and can remove the agent at any time.
- **Agent**: registers properties for owners (choosing or adding an owner each time), and can view and edit only properties they registered or were assigned. An agent can delete only what they added. They cannot delete anything the owner added, and cannot delete a property once the owner has records on it.
- **Linking**: an agent can create a one-time link code for an owner. When the owner enters it in Settings, the properties the agent registered for them appear in the owner's account, under the owner's control.
- Anyone else gets "not found" for a property, including when typing its address directly. All rules are enforced on the server.

## Location from Google Maps

The Add property form accepts a pasted full Google Maps link, a short share link (`maps.app.goo.gl`, `goo.gl/maps`), plain coordinates, or a pin link. Short links are resolved on the server, which will only contact Google Maps hostnames. If nothing can be read, tap the map to place the pin.

The embedded map uses OpenStreetMap tiles, and every property has an "Open in Google Maps" link. An embedded Google Map (which needs a paid Google API key) is not included.

## Tests

```
node test/api.test.js
```

This starts the server on a temporary database and runs 217 checks: sign-up and login, Google sign-in (against a stand-in Google server), permissions for two owners and two agents, calculations against hand-calculated figures, reminders, uploads, location parsing, and security headers.

The browser test drives the pages in Chrome at computer and iPhone sizes (87 checks). It needs Playwright, which is not shipped with the site:

```
PLAYWRIGHT=/path/to/node_modules/playwright CHROME=/usr/bin/google-chrome node test/ui.test.js
```

## Security measures

- Google sign-in uses the standard authorization-code flow with a one-time state and nonce, and checks who the token was issued by and for.
- Passwords hashed with scrypt and a per-user salt; sessions are random tokens stored hashed, in an HttpOnly, SameSite=Strict cookie; changing the password logs out other devices.
- Login, sign-up, code entry, uploads and location lookups are rate limited.
- Every write needs a custom header and a matching Origin, which blocks cross-site request forgery.
- All database queries use parameters. All page content is inserted as text, never as HTML. A strict Content-Security-Policy forbids inline scripts and framing.
- Uploads are checked by content (JPG, PNG, WebP, PDF only), limited to 10 MB, stored outside the public folder under random names, and served only to users with access.

## Known limits

- No email is sent: there is no email verification, no "forgot password", and reminders appear only inside the site (dashboard and bell).
- No audit log of who changed what. An assigned agent can edit (but not delete) records the owner entered.
- No account deletion or data export screen.
- Built for small to medium use on one server.
- Uses Node's built-in SQLite module, which Node still labels experimental.
