# Turning on Google sign-in

The "Continue with Google" button appears only after you give the website two values from Google. Until then the site works with email and password only.

These steps were written from how Google Cloud normally works and have not been run on your Google account, so a label may differ slightly.

## Step 1: Create the Google credentials

1. Go to https://console.cloud.google.com and sign in with your Google account.
2. Create a new project (any name, for example "Amlaki").
3. Open "APIs & Services", then "OAuth consent screen" (it may be called "Google Auth Platform").
   - User type: External.
   - Fill in the app name, your support email and your contact email.
   - Add your website address under authorised domains if it asks.
   - Publish the app (set it to "In production"). While it is in "Testing", only the test users you list can sign in.
4. Open "Credentials" (or "Clients"), choose "Create credentials", then "OAuth client ID".
   - Application type: Web application.
   - Authorised redirect URIs: add your website address followed by `/auth/google/callback`.
     Example: `https://amlaki-production.up.railway.app/auth/google/callback`
   - The address must match exactly, including `https://`.
5. Google shows a **Client ID** and a **Client secret**. Copy both. Keep the secret private.

## Step 2: Give them to the website (Railway)

In Railway, click the `amlaki` box, open the Variables tab, and add:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from Google |
| `GOOGLE_CLIENT_SECRET` | the Client secret from Google |
| `PUBLIC_URL` | your website address, for example `https://amlaki-production.up.railway.app` |

Click Deploy. When it finishes, the login page shows "Continue with Google".

On other hosting, add the same three settings wherever that host keeps environment variables.

## How it behaves

- **New user:** on the "Create account" page they choose owner or agent, then click "Continue with Google". If they click it on the login page first, the site sends them to choose a role.
- **Returning user:** one click on "Continue with Google".
- **Existing email-and-password account with the same email:** the first Google sign-in links to that account and keeps all its data. For safety the old password stops working and other devices are logged out. A new password can be set in Settings.
- **Google account without a verified email:** refused.

## If it does not work

- "redirect_uri_mismatch" from Google: the redirect address in step 1.4 does not exactly match `PUBLIC_URL` + `/auth/google/callback`.
- "Access blocked" from Google: the consent screen is still in "Testing".
- No Google button on the login page: one of the variables is missing or misspelled, or the site was not redeployed.
