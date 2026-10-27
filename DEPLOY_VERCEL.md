# Deploy the inventory app to Vercel

The repository includes the Vercel function and routing configuration. A **durable Turso/libSQL database** and an **inventory password** are required for the hosted app. Vercel's temporary filesystem is never used to store inventory.

## 1. Create the hosted database

1. Sign into [Turso](https://turso.tech/) and create a **libSQL-compatible** database for this project.
2. Copy its database URL (`libsql://…turso.io` or its HTTPS equivalent).
3. Generate a **database-specific token with read and write access**. Keep the token private; do not add it to Git or paste it into chat.

The app creates its tables on its first authenticated request. An empty hosted database starts with no inventory. Existing local inventory and its loan/history records are not automatically migrated; back up and migrate the whole database before switching a workspace with real data.

## 2. Import the repository into Vercel

1. Sign into [Vercel](https://vercel.com/new).
2. Import `prabhatnegione-maker/MLH-APAC-Inventory` from GitHub. Grant Vercel access to this repository if asked.
3. Use **Other** as the framework. Keep the repository root as the project root. The checked-in `vercel.json` supplies the build command, output directory, function settings, and routes. Node.js **24.x** is pinned in `package.json`.
4. Before deploying, add these **Production** environment variables:

| Name                 | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| `TURSO_DATABASE_URL` | Your database URL                                      |
| `TURSO_AUTH_TOKEN`   | Your private database read/write token                 |
| `INVENTORY_PASSWORD` | A strong, unique password for this inventory workspace |

Use Vercel's environment-variable editor for the token and password. Never put their values into source files. For preview deployments, use a separate test database and password; do not let preview changes write into real inventory.

5. Click **Deploy**. Vercel will give you the site's HTTPS URL.
6. Open that URL. The sign-in username is **`admin`**, and the password is the `INVENTORY_PASSWORD` you configured.

You do not need to configure `HOST`, `PORT`, `DATABASE_PATH`, or run `npm start` on Vercel. Requests are handled by `api/index.js`, including the UI assets, so authentication covers the page, JavaScript, CSS, API, and CSV downloads. The serverless entry returns HTTP 503 with a setup message when its required configuration is missing; it never falls back to an empty temporary SQLite database.

## 3. Verify the deployment

After signing in:

1. Create a temporary SKU with opening quantity 5.
2. Record consumption for an event, or use a returnable SKU to test checkout and a partial return.
3. Refresh the page and verify the quantity and stock history.
4. Check the same item after a redeployment to verify hosted persistence.
5. Delete the temporary item after returning any outstanding equipment.

You can also run the existing smoke check from a trusted terminal with the deployment URL in `BASE_URL` and your password supplied securely in `INVENTORY_PASSWORD`:

```bash
npm run smoke
```

The smoke script reads the variables already set in your environment. It does not print their values.

Google Sheet CSV reads are performed by the server. A Google Sheet must be readable by anyone with its link for direct reading, or remain private and use CSV upload. Spreadsheet creation still requires running and authorizing the included Google Apps Script in your own Google account.

## CLI deployment from an authorised machine

If you prefer the CLI, sign in and link the existing project before deploying:

```bash
npx vercel login
npx vercel link
npx vercel deploy --prod
```

Set the three Production variables in the Vercel dashboard first. Do not pass secret values as command-line arguments. Vercel project files and pulled environment files are ignored by Git.

## Troubleshooting

- **HTTP 503 with the setup message:** check the three variable names and redeploy after changing values.
- **HTTP 401:** sign in as `admin` with the configured inventory password. Protected health/API endpoints also require authentication.
- **HTTP 500 after sign-in:** check the database token, write access, expiry, and the database's libSQL compatibility. The database must be reachable from Vercel.
- **A preview returns 503:** add separate Preview database credentials and an inventory password if you want functional preview environments.
- **Changes appear on one deployment but not another:** verify they use the intended database. A local SQLite file and a hosted Turso database are separate inventories.
- **Imports or Google checks time out:** try a smaller CSV or sheet tab, and inspect Vercel function logs. Bulk inserts run as one atomic libSQL batch; live database latency and function limits still apply.

Local tests exercise the libSQL adapter with the real SDK against a temporary local database, plus local SQLite and browser workflows. They do not establish that a particular Turso account or Vercel deployment works. A live deployment must pass the checks above after its credentials are configured.
