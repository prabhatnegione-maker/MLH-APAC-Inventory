import http from "node:http";
import { openDatabase } from "./database.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  parseSheet,
  sheetHeaders,
  sheetSource,
  downloadSheet,
} from "./sheets.js";
const root = dirname(fileURLToPath(import.meta.url));
export function createApp({
  dbPath = process.env.DATABASE_PATH || join(root, "data", "inventory.db"),
  password = process.env.INVENTORY_PASSWORD || "",
  fetcher = fetch,
  databaseUrl = process.env.TURSO_DATABASE_URL,
  databaseToken = process.env.TURSO_AUTH_TOKEN,
  databaseClient,
  hosted = process.env.VERCEL === "1",
} = {}) {
  if (hosted && (!databaseUrl || !databaseToken || !password))
    throw new Error(
      "Vercel requires TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and INVENTORY_PASSWORD.",
    );
  const db = openDatabase({
    dbPath,
    url: databaseUrl,
    authToken: databaseToken,
    client: databaseClient,
  });
  const ready = (async () => {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
      category TEXT NOT NULL DEFAULT 'General', location TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      minimum INTEGER NOT NULL DEFAULT 5 CHECK(minimum >= 0),
      price_cents INTEGER NOT NULL DEFAULT 0 CHECK(price_cents >= 0),
      tracking_type TEXT NOT NULL DEFAULT 'consumable' CHECK(tracking_type IN ('consumable','returnable')),
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL, sku TEXT NOT NULL, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE INDEX IF NOT EXISTS movements_item ON movements(item_id, id);
    CREATE TABLE IF NOT EXISTS loans (id INTEGER PRIMARY KEY,item_id INTEGER NOT NULL REFERENCES items(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),returned INTEGER NOT NULL DEFAULT 0 CHECK(returned>=0 AND returned<=quantity),
      event TEXT NOT NULL,borrower TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS sheet_sources(id INTEGER PRIMARY KEY,label TEXT NOT NULL,spreadsheet_id TEXT NOT NULL,gid TEXT NOT NULL,
      UNIQUE(spreadsheet_id,gid));`);
    // Preserve databases created by the initial prototype.
    if (
      !(await db.prepare("PRAGMA table_info(items)").all()).some(
        (c) => c.name === "tracking_type",
      )
    )
      await db.exec(
        "ALTER TABLE items ADD COLUMN tracking_type TEXT NOT NULL DEFAULT 'consumable' CHECK(tracking_type IN ('consumable','returnable'))",
      );
  })();
  ready.catch(() => {});
  const all = async () =>
    await db
      .prepare(
        `SELECT i.*,COALESCE((SELECT SUM(quantity-returned) FROM loans WHERE item_id=i.id),0) AS outstanding FROM items i ORDER BY name COLLATE NOCASE`,
      )
      .all();
  const fail = (message, status = 400) =>
    Object.assign(new Error(message), {
      status,
    });
  const integer = (value, name, max = 1_000_000_000) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max)
      throw fail(`${name} must be a whole number between 0 and ${max}.`);
    return value;
  };
  const string = (value, name, max, required = false) => {
    if (
      typeof value !== "string" ||
      value.length > max ||
      (required && !value.trim())
    )
      throw fail(`${name} is required and must be at most ${max} characters.`);
    return value.trim();
  };
  const fields = (b) => ({
    name: string(b.name, "Name", 150, true),
    sku: string(b.sku, "SKU", 80, true),
    category: string(b.category ?? "General", "Category", 80, true),
    location: string(b.location ?? "", "Location", 150),
    minimum: integer(b.minimum === undefined ? 5 : b.minimum, "Minimum stock"),
    price_cents: integer(
      b.price_cents === undefined ? 0 : b.price_cents,
      "Unit price",
      100_000_000,
    ),
    notes: string(b.notes ?? "", "Notes", 2000),
    tracking_type: ["consumable", "returnable"].includes(
      b.tracking_type ?? "consumable",
    )
      ? (b.tracking_type ?? "consumable")
      : (() => {
          throw fail("Tracking type must be consumable or returnable.");
        })(),
  });
  const item = async (id) => {
    const result = await db.prepare("SELECT * FROM items WHERE id=?").get(id);
    if (!result) throw fail("Item not found.", 404);
    return result;
  };
  const movement = async (i, delta, reason) =>
    await db
      .prepare(
        "INSERT INTO movements(item_id,item_name,sku,delta,reason) VALUES(?,?,?,?,?)",
      )
      .run(i.id, i.name, i.sku, delta, reason);
  const transaction = (fn) => db.transaction(fn);
  const json = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body));
  };
  const body = async (req, limit = 16384) => {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw fail("Use application/json.", 415);
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw fail("Request too large.", 413);
      chunks.push(chunk);
    }
    try {
      const b = JSON.parse(Buffer.concat(chunks).toString());
      if (!b || Array.isArray(b) || typeof b !== "object") throw 0;
      return b;
    } catch {
      throw fail("Invalid JSON object.");
    }
  };
  const insert = async (f, quantity) => {
    const r = await db
      .prepare(
        "INSERT INTO items(name,sku,category,location,minimum,price_cents,notes,tracking_type,quantity) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        f.name,
        f.sku,
        f.category,
        f.location,
        f.minimum,
        f.price_cents,
        f.notes,
        f.tracking_type,
        quantity,
      );
    const i = await item(Number(r.lastInsertRowid));
    if (quantity) await movement(i, quantity, "Opening stock");
    return i;
  };
  const preview = async (csv) => {
    const existingItems = new Map(
      (await all()).map((i) => [i.sku.toLowerCase(), i]),
    );
    return parseSheet(csv).map((row) => {
      fields(row);
      integer(row.quantity, "Quantity");
      const existing = existingItems.get(row.sku.toLowerCase());
      return {
        ...row,
        status: !existing
          ? "new"
          : existing.name !== row.name ||
              existing.tracking_type !== row.tracking_type
            ? "conflict"
            : "tracked",
        current_quantity: existing?.quantity,
      };
    });
  };
  const files = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const handler = async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (password) {
        const expected = Buffer.from(
          `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
        );
        const actual = Buffer.from(req.headers.authorization || "");
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Inventory", charset="UTF-8"',
          );
          return json(res, 401, {
            error: "Authentication required.",
          });
        }
      }
      await ready;
      const url = new URL(req.url, "http://localhost");
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw fail("Cross-site requests are not allowed.", 403);
        if (
          req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host
        )
          throw fail("Origin mismatch.", 403);
      }
      if (req.method === "GET" && url.pathname === "/api/health")
        return json(res, 200, {
          status: "ok",
        });
      if (req.method === "GET" && url.pathname === "/api/items")
        return json(res, 200, await all());
      if (req.method === "GET" && url.pathname === "/api/movements")
        return json(
          res,
          200,
          await db
            .prepare("SELECT * FROM movements ORDER BY id DESC LIMIT 100")
            .all(),
        );
      if (req.method === "GET" && url.pathname === "/api/loans")
        return json(
          res,
          200,
          await db
            .prepare(
              "SELECT l.*,i.name,i.sku FROM loans l JOIN items i ON i.id=l.item_id WHERE l.returned<l.quantity ORDER BY l.id DESC",
            )
            .all(),
        );
      if (req.method === "GET" && url.pathname === "/api/template") {
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="sku-template.csv"',
        });
        return res.end(sheetHeaders.join(",") + "\r\n");
      }
      if (
        req.method === "POST" &&
        ["/api/import/preview", "/api/import"].includes(url.pathname)
      ) {
        const b = await body(req, 2_000_000),
          rows = await preview(b.csv);
        if (url.pathname.endsWith("/preview"))
          return json(res, 200, {
            rows,
          });
        const statements = [];
        for (const row of rows.filter((r) => r.status === "new")) {
          const f = fields(row);
          statements.push({
            sql: "INSERT INTO items(name,sku,category,location,minimum,price_cents,notes,tracking_type,quantity) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO NOTHING",
            args: [
              f.name,
              f.sku,
              f.category,
              f.location,
              f.minimum,
              f.price_cents,
              f.notes,
              f.tracking_type,
              row.quantity,
            ],
          });
          statements.push({
            sql: "INSERT INTO movements(item_id,item_name,sku,delta,reason) SELECT id,name,sku,quantity,'Opening stock' FROM items WHERE sku=? AND changes()>0 AND quantity>0",
            args: [f.sku],
          });
        }
        const results = statements.length ? await db.batch(statements) : [];
        const added = results.reduce(
          (sum, r, index) =>
            sum + (index % 2 === 0 ? Number(r.rowsAffected) : 0),
          0,
        );
        return json(res, 200, {
          added,
          skipped: rows.length - added,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/sources")
        return json(
          res,
          200,
          await db.prepare("SELECT * FROM sheet_sources ORDER BY id").all(),
        );
      if (req.method === "POST" && url.pathname === "/api/sources") {
        const b = await body(req),
          source = sheetSource(b.url),
          label = string(b.label, "Tab label", 80, true);
        const existing = await db
          .prepare(
            "SELECT id FROM sheet_sources WHERE spreadsheet_id=? AND gid=?",
          )
          .get(source.spreadsheet_id, source.gid);
        if (existing) throw fail("This sheet tab is already connected.", 409);
        const r = await db
          .prepare(
            "INSERT INTO sheet_sources(label,spreadsheet_id,gid) VALUES(?,?,?)",
          )
          .run(label, source.spreadsheet_id, source.gid);
        return json(res, 201, {
          id: Number(r.lastInsertRowid),
        });
      }
      const sourceMatch = url.pathname.match(
        /^\/api\/sources\/(\d+)(\/preview)?$/,
      );
      if (sourceMatch) {
        const source = await db
          .prepare("SELECT * FROM sheet_sources WHERE id=?")
          .get(Number(sourceMatch[1]));
        if (!source) throw fail("Sheet source not found.", 404);
        if (req.method === "DELETE" && !sourceMatch[2]) {
          await db
            .prepare("DELETE FROM sheet_sources WHERE id=?")
            .run(source.id);
          return json(res, 200, {
            ok: true,
          });
        }
        if (req.method === "GET" && sourceMatch[2]) {
          const csv = await downloadSheet(source, fetcher);
          return json(res, 200, {
            csv,
            rows: await preview(csv),
          });
        }
      }
      const returnMatch = url.pathname.match(/^\/api\/loans\/(\d+)\/return$/);
      if (req.method === "POST" && returnMatch) {
        const b = await body(req),
          count = integer(b.quantity, "Quantity");
        if (!count) throw fail("Return at least one unit.");
        const result = await transaction(async () => {
          const loan = await db
            .prepare("SELECT * FROM loans WHERE id=?")
            .get(Number(returnMatch[1]));
          if (!loan) throw fail("Loan not found.", 404);
          if (count > loan.quantity - loan.returned)
            throw fail("Cannot return more than the outstanding loan.");
          const i = await item(loan.item_id);
          integer(i.quantity + count, "Resulting quantity");
          await db
            .prepare("UPDATE loans SET returned=returned+? WHERE id=?")
            .run(count, loan.id);
          await db
            .prepare(
              "UPDATE items SET quantity=quantity+?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            )
            .run(count, i.id);
          await movement(
            i,
            count,
            `Returned · ${loan.event} · ${loan.borrower}`,
          );
          return await item(i.id);
        });
        return json(res, 200, result);
      }
      const eventMatch = url.pathname.match(
        /^\/api\/items\/(\d+)\/(consume|checkout)$/,
      );
      if (req.method === "POST" && eventMatch) {
        const b = await body(req),
          count = integer(b.quantity, "Quantity");
        if (!count) throw fail("Use at least one unit.");
        const event = string(b.event, "Event", 150, true),
          isLoan = eventMatch[2] === "checkout",
          borrower = isLoan ? string(b.borrower, "Borrower", 150, true) : "";
        const result = await transaction(async () => {
          const i = await item(Number(eventMatch[1]));
          if (i.tracking_type !== (isLoan ? "returnable" : "consumable"))
            throw fail(
              isLoan
                ? "Only returnable equipment can be checked out."
                : "Use checkout for returnable equipment.",
            );
          if (count > i.quantity) throw fail("Not enough available stock.");
          await db
            .prepare(
              "UPDATE items SET quantity=quantity-?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            )
            .run(count, i.id);
          if (isLoan)
            await db
              .prepare(
                "INSERT INTO loans(item_id,quantity,event,borrower) VALUES(?,?,?,?)",
              )
              .run(i.id, count, event, borrower);
          await movement(
            i,
            -count,
            `${isLoan ? "Checked out" : "Consumed"} · ${event}${isLoan ? " · " + borrower : ""}`,
          );
          return await item(i.id);
        });
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        const cell = (v) =>
          `"${String(typeof v === "string" && /^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
        const keys = sheetHeaders;
        const csv = [
          keys.join(","),
          ...(await all()).map((i) =>
            keys
              .map((k) =>
                cell(
                  k === "unit_cost" ? (i.price_cents / 100).toFixed(2) : i[k],
                ),
              )
              .join(","),
          ),
        ].join("\r\n");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="inventory.csv"',
        });
        return res.end(csv);
      }
      if (req.method === "POST" && url.pathname === "/api/items") {
        const b = await body(req),
          f = fields(b),
          quantity = integer(
            b.quantity === undefined ? 0 : b.quantity,
            "Quantity",
          );
        const result = await transaction(async () => {
          return await insert(f, quantity);
        });
        return json(res, 201, result);
      }
      const match = url.pathname.match(/^\/api\/items\/(\d+)(\/adjust)?$/);
      if (match) {
        const id = Number(match[1]);
        await item(id);
        if (req.method === "POST" && match[2]) {
          const b = await body(req);
          if (
            !Number.isSafeInteger(b.delta) ||
            !b.delta ||
            Math.abs(b.delta) > 1_000_000_000
          )
            throw fail(
              "Stock change must be a nonzero whole number up to 1000000000.",
            );
          const reason = string(b.reason, "Reason", 300, true);
          const result = await transaction(async () => {
            const i = await item(id),
              quantity = i.quantity + b.delta;
            integer(quantity, "Resulting quantity");
            await db
              .prepare(
                "UPDATE items SET quantity=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
              )
              .run(quantity, id);
            await movement(i, b.delta, reason);
            return await item(id);
          });
          return json(res, 200, result);
        }
        if (req.method === "PUT" && !match[2]) {
          const b = await body(req);
          if ("quantity" in b)
            throw fail("Use stock adjustments to change quantity.");
          const f = fields(b);
          const updated = await transaction(async () => {
            const previous = await item(id);
            if (f.sku.toLowerCase() !== previous.sku.toLowerCase())
              throw fail(
                "SKU is the permanent item identity. Create a new item for a different SKU.",
              );
            const outstanding = (
              await db
                .prepare(
                  "SELECT COUNT(*) AS count FROM loans WHERE item_id=? AND returned<quantity",
                )
                .get(id)
            ).count;
            if (outstanding && f.tracking_type !== previous.tracking_type)
              throw fail(
                "Return outstanding loans before changing tracking type.",
              );
            await db
              .prepare(
                "UPDATE items SET name=?,sku=?,category=?,location=?,minimum=?,price_cents=?,notes=?,tracking_type=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
              )
              .run(
                f.name,
                f.sku,
                f.category,
                f.location,
                f.minimum,
                f.price_cents,
                f.notes,
                f.tracking_type,
                id,
              );
            return await item(id);
          });
          return json(res, 200, updated);
        }
        if (req.method === "DELETE" && !match[2]) {
          await transaction(async () => {
            if (
              (
                await db
                  .prepare(
                    "SELECT COUNT(*) AS count FROM loans WHERE item_id=? AND returned<quantity",
                  )
                  .get(id)
              ).count
            )
              throw fail("Return outstanding loans before deleting this item.");
            const i = await item(id);
            await movement(i, -i.quantity, "Item deleted");
            await db.prepare("DELETE FROM loans WHERE item_id=?").run(id);
            await db.prepare("DELETE FROM items WHERE id=?").run(id);
          });
          return json(res, 200, {
            ok: true,
          });
        }
      }
      if (["GET", "HEAD"].includes(req.method) && files[url.pathname]) {
        const [file, type] = files[url.pathname];
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
        });
        return res.end(
          req.method === "HEAD"
            ? undefined
            : readFileSync(join(root, "public", file)),
        );
      }
      json(res, 404, {
        error: "Not found.",
      });
    } catch (error) {
      const duplicate = String(error.message).includes(
        "UNIQUE constraint failed",
      );
      const status = duplicate ? 409 : error.status || 500;
      if (status === 500)
        console.error("Inventory request failed:", error.code || error.name);
      json(res, status, {
        error: duplicate
          ? "This SKU already exists."
          : status === 500
            ? "Unexpected server error."
            : error.message,
      });
    }
  };
  const server = http.createServer(handler);
  server.handler = handler;
  server.on("close", () => {
    ready.then(
      () => db.close(),
      () => db.close(),
    );
  });
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const host = process.env.HOST || "127.0.0.1",
    port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.listen(port, host, () =>
    console.log(`Inventory listening on ${host}:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
