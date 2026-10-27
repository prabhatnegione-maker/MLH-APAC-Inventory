import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createApp } from "../server.js";
import { openDatabase } from "../database.js";
import { createVercelHandler } from "../api/index.js";

const auth = {
  Authorization: `Basic ${Buffer.from("admin:hosting-test-password").toString("base64")}`,
};
async function service(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return `http://127.0.0.1:${s.address().port}`;
}
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "inventory-hosting-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function request(base, path, method = "GET", body, headers = auth) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (response.headers.get("content-type") || "").includes("json")
      ? await response.json()
      : await response.text(),
  };
}

test("serverless refuses an ephemeral database or missing access password", () => {
  assert.throws(
    () =>
      createApp({
        hosted: true,
        databaseUrl: "",
        databaseToken: "",
        password: "",
      }),
    /Vercel requires/,
  );
  assert.throws(
    () =>
      createApp({
        hosted: true,
        databaseUrl: "libsql://example.turso.io",
        databaseToken: "test",
        password: "",
      }),
    /Vercel requires/,
  );
});
test("serverless entry returns an actionable setup error without leaking exceptions", async (t) => {
  const handler = createVercelHandler(() => {
    throw new Error("secret-value-must-not-be-visible");
  });
  const base = await service(t, handler),
    r = await request(base, "/api/items");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Configure TURSO_DATABASE_URL/);
  assert.doesNotMatch(JSON.stringify(r), /secret-value/);
});
test("hosted routes protect UI and API and persist data across fresh handler instances", async (t) => {
  const dir = folder(t),
    url = `file:${join(dir, "hosted.db")}`,
    apps = [];
  const factory = () => {
    const app = createApp({
      hosted: true,
      databaseClient: createClient({ url }),
      databaseUrl: "libsql://example.turso.io",
      databaseToken: "test",
      password: "hosting-test-password",
    });
    apps.push(app);
    return app;
  };
  t.after(() => apps.forEach((app) => app.emit("close")));
  const first = await service(t, createVercelHandler(factory));
  for (const path of [
    "/",
    "/app.js",
    "/style.css",
    "/api/items",
    "/api/export",
  ])
    assert.equal(
      (await request(first, path, "GET", undefined, {})).status,
      401,
    );
  assert.equal((await request(first, "/")).status, 200);
  const created = await request(first, "/api/items", "POST", {
    sku: "REMOTE-1",
    name: "Equipment",
    tracking_type: "returnable",
    quantity: 6,
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const loan = await request(first, `/api/items/${id}/checkout`, "POST", {
    quantity: 4,
    event: "APAC event",
    borrower: "AV team",
  });
  assert.equal(loan.status, 200);
  const second = await service(t, createVercelHandler(factory));
  const items = await request(second, "/api/items");
  assert.equal(items.body[0].quantity, 2);
  assert.equal(items.body[0].outstanding, 4);
  const loans = await request(second, "/api/loans");
  assert.equal(loans.body[0].quantity, 4);
  const returned = await request(
    second,
    `/api/loans/${loans.body[0].id}/return`,
    "POST",
    { quantity: 2 },
  );
  assert.equal(returned.body.quantity, 4);
  assert.equal((await request(first, "/api/items")).body[0].quantity, 4);
  const csv =
    "sku,name,tracking_type,quantity\nREMOTE-1,Equipment,returnable,999\nNEW-1,Notebook,consumable,10";
  assert.equal(
    (await request(second, "/api/import", "POST", { csv })).body.added,
    1,
  );
  assert.equal(
    (await request(first, "/api/import", "POST", { csv })).body.added,
    0,
  );
  assert.equal(
    (await request(first, "/api/items")).body.find((i) => i.sku === "REMOTE-1")
      .quantity,
    4,
  );
  assert.equal(
    (await request(first, "/api/movements")).body.filter(
      (m) => m.sku === "NEW-1",
    ).length,
    1,
  );
});
test("concurrent stock requests cannot oversell local or libSQL inventory", async (t) => {
  for (const kind of ["local", "libsql"]) {
    const client =
      kind === "libsql"
        ? createClient({ url: `file:${join(folder(t), "concurrent.db")}` })
        : undefined;
    const app = createApp({
      dbPath: ":memory:",
      databaseUrl: "",
      databaseToken: "",
      hosted: false,
      databaseClient: client,
      password: "hosting-test-password",
    });
    const base = await service(t, app.handler);
    t.after(() => app.emit("close"));
    const created = await request(base, "/api/items", "POST", {
      sku: "ONE",
      name: "One last item",
      quantity: 1,
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        request(base, `/api/items/${created.body.id}/consume`, "POST", {
          quantity: 1,
          event: "Concurrent event",
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    assert.equal((await request(base, "/api/items")).body[0].quantity, 0);
    assert.equal((await request(base, "/api/movements")).body.length, 2);
  }
});
test("libSQL transaction rolls back both stock and history after a failed operation", async (t) => {
  const client = createClient({
    url: `file:${join(folder(t), "rollback.db")}`,
  });
  const db = openDatabase({ client });
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE test_items(id INTEGER PRIMARY KEY,quantity INTEGER CHECK(quantity>=0)); INSERT INTO test_items VALUES(1,4);",
  );
  await assert.rejects(
    db.transaction(async () => {
      await db
        .prepare("UPDATE test_items SET quantity=quantity-2 WHERE id=1")
        .run();
      await db.prepare("UPDATE test_items SET quantity=-1 WHERE id=1").run();
    }),
  );
  assert.equal(
    (await db.prepare("SELECT quantity FROM test_items WHERE id=1").get())
      .quantity,
    4,
  );
});
test("secure remote URL validation rejects local files and credential-bearing URLs", () => {
  for (const url of [
    "file:/tmp/db",
    "http://example.turso.io",
    "https://user:pass@example.turso.io",
    "https://example.turso.io/db?token=secret",
  ])
    assert.throws(() => openDatabase({ url, authToken: "test" }));
  for (const url of ["libsql://example.turso.io", "https://example.turso.io"]) {
    const db = openDatabase({ url, authToken: "test" });
    db.close();
  }
});
test("Vercel routes every asset through authentication and bundles UI files", () => {
  const config = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url)),
  );
  assert.deepEqual(config.routes, [{ src: "/(.*)", dest: "/api/index.js" }]);
  assert.equal(config.functions["api/index.js"].includeFiles, "public/**");
});
