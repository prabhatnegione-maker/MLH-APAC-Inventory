# MLH APAC Inventory

A SKU-first inventory workspace for products, supplies, consumables, and returnable equipment. Built with Node.js 24, SQLite, and a responsive browser interface. The application has no runtime package dependencies; Playwright is used only for browser tests.

## Run locally

```bash
npm ci --ignore-scripts
npm start
```

Open `http://127.0.0.1:3000` in your own local browser. The database is created automatically in `data/inventory.db`. The initial inventory is empty. To add **optional sample data** to an empty database, run `npm run seed`; running it again leaves existing inventory unchanged.

For development use `npm run dev`. Node.js 24 or newer is required for the built-in SQLite driver. No database service, Docker, cloud account, or API key is required for local inventory management.

## Inventory workflow

- **SKU is the identity.** SKUs are unique, matched without case sensitivity, and cannot be changed after creation. Categories and storage locations are flexible.
- **Consumables:** use **Use** to record quantities consumed at a named event.
- **Returnable equipment:** use **Lend** with an event and borrower. Record full or partial returns from **Stock activity → Outstanding equipment**. Checked-out equipment is separate from available stock.
- **Stock corrections and restocking:** use **Stock** and give a reason. Negative balances are rejected. Item editing never silently replaces the quantity.
- **History:** the latest 100 stock movements show opening stock, event usage, loans, returns, corrections, and deletions. All records are retained in SQLite. Items with outstanding loans cannot be deleted or changed to consumables.
- **Overview:** available units, available stock value, and low-stock warnings. Costs currently use USD; there is no currency conversion.
- **Export:** download the current inventory as CSV, including all item notes. Formula-like text is escaped for spreadsheet safety.

This is a shared inventory workspace. It does not implement individual user accounts, role permissions, reservations, barcode scanning, or automatic two-way stock synchronisation.

## Create the Google Sheet

The repository includes a Google Apps Script that creates the workbook **in the Google account that runs it**. No spreadsheet has been created merely by installing this app.

1. Sign into your Google account and open [Google Apps Script](https://script.google.com/).
2. Create a new project and replace the editor contents with [`google-sheets/Setup.gs`](google-sheets/Setup.gs).
3. Select `createInventoryWorkbook`, click **Run**, and review Google's requested spreadsheet and trigger permissions.
4. Find the spreadsheet link in the execution log. Run this function again to retrieve the same workbook link instead of making duplicates.

The script creates **Equipment**, **Supplies**, **General**, **SKU Registry**, and **Read me** tabs. It installs an edit trigger for the source tabs. New valid SKUs are copied to the registry and highlighted green; matching existing SKUs are blue, and conflicting names or tracking types are amber. All three source tabs share one SKU registry. Edits in the original source tab update that SKU’s catalogue row, including opening quantity as you finish entering it. A matching SKU in another tab does not overwrite the original record. Editing a source SKU creates a different identity; it does not delete the old registry entry. The trigger runs on human edits and multirow pastes; Google API edits and formula recalculations do not fire edit triggers.

The Apps Script uses Google-provided services and must be authorised and tested in your Google account. It is not executed by the Node.js tests. The spreadsheet is private by default, and the script never changes its sharing permissions.

## Connect Google Sheet tabs

Use **Google Sheets** in the app navigation.

For a private sheet, download its tab as CSV and upload it in the app. You can also use [`google-sheets/sku-template.csv`](google-sheets/sku-template.csv) without running the Apps Script. [`example-items.csv`](google-sheets/example-items.csv) contains two clearly marked demonstration rows.

For direct reading, optionally share the workbook with **Anyone with the link → Viewer**. Connect the **SKU Registry** tab URL to get one deduplicated source, or connect individual tabs by their `gid` links. The app reads CSV from `docs.google.com`, so this host must be allowed by the environment's network policy. Sheets containing sensitive information should remain private and use CSV upload.

Connected tabs are checked every 60 seconds **while a visible browser workspace is open**. The app flags new SKU rows and offers **Check for SKUs → Add new SKUs** for review and import. The app does not run a background scheduler when the browser is closed. Checks from multiple tabs can report the same new SKU more than once; database uniqueness prevents duplicate inventory items.

Imports add only new SKUs. Existing SKU balances and metadata are preserved. A name or tracking-type mismatch is highlighted for review. A spreadsheet's `quantity` column is **opening stock**, so repeatedly importing it never resets current balances. Once imported, record consumption, restocks, loans, and returns in the app. The sheet is a SKU catalogue, not a live mirror of the app database. Direct private-sheet OAuth access and writes back to Google Sheets are not implemented.

### Sheet columns

| Column          | Meaning                                               |
| --------------- | ----------------------------------------------------- |
| `sku`           | Required, unique item identity, up to 80 characters   |
| `name`          | Required, up to 150 characters                        |
| `category`      | Optional, defaults to General                         |
| `tracking_type` | `consumable` or `returnable`; defaults to consumable  |
| `location`      | Optional storage location                             |
| `quantity`      | Initial available stock, whole number, defaults to 0  |
| `minimum`       | Low-stock threshold, whole number, defaults to 5      |
| `unit_cost`     | USD per unit, up to two decimal places, defaults to 0 |
| `notes`         | Optional, up to 2,000 characters                      |

CSV import supports quoted commas, quoted multiline notes, and UTF-8 BOMs. Files must be below 1 MB and have at most 5,000 data rows. Duplicate SKUs within one uploaded file are rejected. Every row is validated before any items are created.

## Configuration and access

| Variable             | Default                        | Purpose                                                                      |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`                    | Bind address                                                                 |
| `PORT`               | `3000`                         | HTTP port                                                                    |
| `DATABASE_PATH`      | `data/inventory.db`            | SQLite file path, relative to the process working directory if customised    |
| `INVENTORY_PASSWORD` | unset                          | Optional shared password; HTTP Basic username is `admin`                     |
| `BASE_URL`           | `http://127.0.0.1:3000`        | Target for `npm run smoke`                                                   |
| `CHROMIUM_PATH`      | `/usr/bin/chromium` if present | Browser executable for tests; otherwise uses Playwright's installed Chromium |

By default, the app binds only to loopback and has no authentication. For access from other machines, configure `INVENTORY_PASSWORD` securely, set `HOST` as needed, and put the app behind a trusted HTTPS reverse proxy. HTTP Basic authentication requires HTTPS on shared networks. The optional password protects the UI, API, and CSV exports. Avoid exposing an unauthenticated instance publicly.

The server applies a same-origin content policy, escapes user data in the UI, validates mutations, rejects cross-site browser writes, and accepts only fixed Google Sheets CSV destinations. These protections do not replace HTTPS, authentication, or deployment access controls.

### Backups

`data/` is ignored by Git. Stop the server before copying `data/inventory.db` for a simple consistent backup, or use SQLite's supported online backup tooling. Do not copy just the main database file while writes are active in WAL mode. Restore backups with the server stopped. Environment snapshots should not be your only backup for real inventory.

## Validation

```bash
npm run check
npm test
npm run test:browser
```

If Chromium is not installed, run `npx playwright install chromium` first (or `npx playwright install --with-deps chromium` on a suitable Linux host). Browser tests use a temporary in-memory inventory and check item creation, consumption, loans, partial returns, search, imports, reloads, and a mobile viewport. Google CSV responses are mocked in automated tests; a real sheet still requires a workbook and access verification. Temporary browser screenshots are saved in `/tmp/inventory-desktop.png` and `/tmp/inventory-mobile.png`.

With a running application, `npm run smoke` checks the health and inventory endpoints. GitHub Actions runs syntax, API, and browser checks on pushes and pull requests.

## Project layout

```text
server.js                HTTP API, transactions, SQLite persistence
sheets.js                CSV parser and restricted Google CSV reader
public/                  Responsive interface and browser interactions
google-sheets/           Workbook creator and CSV templates
test/                    API, security, import, and persistence tests
scripts/                 Browser workflow and running-service checks
```
