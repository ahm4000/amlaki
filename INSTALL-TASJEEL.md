# Installing the website on Tasjeel hosting

The website needs **Node.js version 22.13 or newer**. It does not need PHP, MySQL or any extra packages.

These steps were written from how cPanel hosting normally works. They have not been tried on a Tasjeel account, so confirm step 1 with Tasjeel before paying for a plan.

## Step 1: Confirm your plan can run it

Send this to Tasjeel support:

> I want to host a Node.js web application. Does my hosting plan include "Setup Node.js App" in cPanel, with Node.js version 22.13 or newer? If not, which of your plans or cloud servers supports it?

- If they say **yes**, follow Route A.
- If they say **no**, you need their managed cloud server. Follow Route B.

## Route A: cPanel hosting with "Setup Node.js App"

1. **Upload the files outside the public folder.**
   - Open cPanel, then File Manager.
   - Stay in your home folder (the one that contains `public_html`). Do not go inside `public_html`.
   - Upload `amlaki-website.zip` and extract it. You should now have a folder named `amlaki` next to `public_html`.
   - Create one more empty folder next to it named `amlaki-data`. The database and uploaded files will be stored there.
   - Putting these inside `public_html` would let visitors download the database, so keep them outside.

2. **Create the application.**
   - In cPanel, open "Setup Node.js App" and choose "Create Application".
   - Node.js version: 22 or newer.
   - Application mode: Production.
   - Application root: `amlaki`
   - Application URL: your domain, or a subdomain such as `app.yourdomain.ae`.
   - Application startup file: `app.js`

3. **Add three settings** under "Environment variables" (replace USERNAME with your cPanel username, shown at the top of File Manager):

   | Name | Value |
   |---|---|
   | `DATA_DIR` | `/home/USERNAME/amlaki-data` |
   | `TRUST_PROXY` | `1` |
   | `COOKIE_SECURE` | `1` |

4. **Start it.** Click Create, then Start App. You do not need "Run NPM Install"; the site has no packages to install.

5. **Turn on HTTPS.**
   - In cPanel, open "SSL/TLS Status" and run AutoSSL for the domain.
   - In "Domains", switch on "Force HTTPS Redirect" for the domain.
   - Login will not work over plain http once `COOKIE_SECURE` is set, so do this before testing.

6. **Open the site** at your domain, create your account, and add a property to check that saving and photo upload work.

7. **Back up.** Download a copy of the `amlaki-data` folder regularly (File Manager, select the folder, Compress, then Download). It holds every account, record, photo and document.

### If the site shows an error
- Check the Node.js version in "Setup Node.js App" is 22.13 or newer.
- Check the three settings in step 3 are spelled exactly as shown.
- Open `stderr.log` inside the `amlaki` folder; it shows the reason.
- Click "Restart" after any change.

### Updating the site later
Upload the new files into the `amlaki` folder (replace the old ones), then click "Restart" in "Setup Node.js App". Your data in `amlaki-data` is not touched.

## Route B: Tasjeel managed cloud server

Tasjeel manages these servers for you, so send them the zip file and this request:

> Please host the attached Node.js application on my cloud server:
> 1. Install Node.js 22.13 or newer.
> 2. Extract the zip to a folder outside the web root and run `node app.js` as a service that restarts automatically.
> 3. Set these environment variables: `PORT=3000`, `DATA_DIR=` a folder on persistent storage, `TRUST_PROXY=1`, `COOKIE_SECURE=1`.
> 4. Put a reverse proxy with an HTTPS certificate in front of it, forwarding my domain to port 3000 and passing the `X-Forwarded-For` and `X-Forwarded-Proto` headers.
> 5. Include the `DATA_DIR` folder in daily backups.
> 6. Run only one copy of the application.

## After installation
- Anyone who knows the address can create an account. Share the address only with the owners and agents you want to use it.
- There is no "forgot password" email. Keep your password safe.
