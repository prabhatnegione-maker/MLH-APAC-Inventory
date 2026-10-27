import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { parseSheet, sheetSource } from "../sheets.js";

async function fixture(t, options = {}) {
  const server = createApp({
    dbPath: ":memory:",
    databaseUrl: "",
    databaseToken: "",
    hosted: false,
    password: "",
    ...options,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = "GET", data, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const type = r.headers.get("content-type") || "";
    return {
      status: r.status,
      data: type.includes("json") ? await r.json() : await r.text(),
      headers: r.headers,
    };
  };
  return { request, base };
}
const sample = (overrides = {}) => ({
  name: "USB-C adapter",
  sku: "TECH-001",
  quantity: 10,
  minimum: 2,
  price_cents: 1599,
  tracking_type: "returnable",
  ...overrides,
});

test("item lifecycle keeps SKU identity and stock audit history", async (t) => {
  const { request: r } = await fixture(t);
  assert.equal((await r("/api/health")).data.status, "ok");
  const create = await r("/api/items", "POST", sample());
  assert.equal(create.status, 201);
  const id = create.data.id;
  assert.equal(
    (await r("/api/items", "POST", sample({ sku: "tech-001" }))).status,
    409,
  );
  assert.equal(
    (
      await r(
        `/api/items/${id}`,
        "PUT",
        sample({ sku: "OTHER", quantity: undefined }),
      )
    ).status,
    400,
  );
  const changed = await r(`/api/items/${id}/adjust`, "POST", {
    delta: -3,
    reason: "Stock count correction",
  });
  assert.equal(changed.data.quantity, 7);
  assert.equal(
    (
      await r(`/api/items/${id}/adjust`, "POST", {
        delta: -8,
        reason: "Invalid",
      })
    ).status,
    400,
  );
  const updated = await r(
    `/api/items/${id}`,
    "PUT",
    sample({ quantity: undefined, name: "USB-C adapter, revised" }),
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.data.quantity, 7);
  assert.equal((await r(`/api/items/${id}`, "DELETE")).status, 200);
  assert.equal((await r("/api/items")).data.length, 0);
  const history = (await r("/api/movements")).data;
  assert.equal(history.length, 3);
  assert.equal(history[0].reason, "Item deleted");
  assert.equal(history[0].item_id, null);
  assert.equal((await r(`/api/items/${id}`, "DELETE")).status, 404);
});
test("checkout and partial returns preserve available stock and reject duplicate returns", async (t) => {
  const { request: r } = await fixture(t);
  const id = (await r("/api/items", "POST", sample())).data.id;
  assert.equal(
    (
      await r(`/api/items/${id}/checkout`, "POST", {
        quantity: 4,
        event: "Hackathon",
        borrower: "AV team",
      })
    ).data.quantity,
    6,
  );
  let loans = (await r("/api/loans")).data;
  assert.equal(loans.length, 1);
  const loan = loans[0].id;
  assert.equal((await r("/api/items")).data[0].outstanding, 4);
  assert.equal((await r(`/api/items/${id}`, "DELETE")).status, 400);
  assert.equal(
    (
      await r(
        `/api/items/${id}`,
        "PUT",
        sample({ quantity: undefined, tracking_type: "consumable" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await r(`/api/loans/${loan}/return`, "POST", { quantity: 2 })).data
      .quantity,
    8,
  );
  assert.equal((await r("/api/loans")).data[0].returned, 2);
  assert.equal(
    (await r(`/api/loans/${loan}/return`, "POST", { quantity: 3 })).status,
    400,
  );
  assert.equal(
    (await r(`/api/loans/${loan}/return`, "POST", { quantity: 2 })).data
      .quantity,
    10,
  );
  assert.equal((await r("/api/loans")).data.length, 0);
  assert.equal(
    (await r(`/api/loans/${loan}/return`, "POST", { quantity: 1 })).status,
    400,
  );
  assert.equal((await r(`/api/items/${id}`, "DELETE")).status, 200);
});
test("event consumption is restricted to consumables and cannot exceed stock", async (t) => {
  const { request: r } = await fixture(t);
  const id = (
    await r("/api/items", "POST", sample({ tracking_type: "consumable" }))
  ).data.id;
  assert.equal(
    (
      await r(`/api/items/${id}/checkout`, "POST", {
        quantity: 1,
        event: "Meetup",
        borrower: "Staff",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await r(`/api/items/${id}/consume`, "POST", {
        quantity: 3,
        event: "Meetup",
      })
    ).data.quantity,
    7,
  );
  assert.equal(
    (
      await r(`/api/items/${id}/consume`, "POST", {
        quantity: 8,
        event: "Meetup",
      })
    ).status,
    400,
  );
  assert.equal((await r("/api/movements")).data[0].reason, "Consumed · Meetup");
  assert.equal((await r("/api/items")).data[0].quantity, 7);
});
test("invalid payloads, unsafe origins, and path traversal are rejected", async (t) => {
  const { request: r, base } = await fixture(t);
  for (const overrides of [
    { quantity: -1 },
    { quantity: 1.5 },
    { sku: "" },
    { name: " " },
    { price_cents: NaN },
    { tracking_type: "other" },
    { notes: "x".repeat(2001) },
  ])
    assert.equal(
      (await r("/api/items", "POST", sample(overrides))).status,
      400,
    );
  assert.equal(
    (
      await r("/api/items", "POST", sample(), {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await r("/api/items", "POST", sample(), {
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{bad",
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(base + "/api/items", { method: "POST", body: "{}" })).status,
    415,
  );
  assert.equal((await r("/server.js")).status, 404);
  assert.equal((await r("/.git/config")).status, 404);
  const page = await r("/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
});
test("optional password protects every endpoint", async (t) => {
  const { request: r } = await fixture(t, { password: "test-password" });
  assert.equal((await r("/")).status, 401);
  assert.equal((await r("/api/items")).status, 401);
  assert.equal(
    (
      await r("/api/items", "GET", undefined, {
        Authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
      })
    ).status,
    200,
  );
});
test("CSV preview flags new, tracked and conflicting SKUs; import is idempotent", async (t) => {
  const { request: r } = await fixture(t);
  await r("/api/items", "POST", sample());
  const csv =
    'sku,name,tracking_type,quantity\r\ntech-001,USB-C adapter,returnable,999\r\nSUP-001,"Notebook, A5",consumable,20\r\n';
  const preview = (await r("/api/import/preview", "POST", { csv })).data.rows;
  assert.deepEqual(
    preview.map((x) => x.status),
    ["tracked", "new"],
  );
  assert.equal((await r("/api/import", "POST", { csv })).data.added, 1);
  assert.equal((await r("/api/import", "POST", { csv })).data.added, 0);
  assert.equal(
    (await r("/api/items")).data.find((i) => i.sku === "TECH-001").quantity,
    10,
  );
  const conflict = "sku,name,tracking_type\nTECH-001,Different,consumable";
  assert.equal(
    (await r("/api/import/preview", "POST", { csv: conflict })).data.rows[0]
      .status,
    "conflict",
  );
  assert.equal(
    (await r("/api/import", "POST", { csv: conflict })).data.skipped,
    1,
  );
  assert.equal((await r("/api/template")).status, 200);
});
test("invalid import cannot partially create inventory", async (t) => {
  const { request: r } = await fixture(t);
  for (const csv of [
    "sku,name,quantity\nA,Valid,1\nB,Invalid,-1",
    "sku,name\nA,First\na,Second",
    "sku,name,quantity\nA,Valid,1.5",
    "sku,name,unit_cost\nA,Valid,1.234",
  ])
    assert.equal((await r("/api/import", "POST", { csv })).status, 400);
  assert.equal((await r("/api/items")).data.length, 0);
});
test("CSV handles quoted multiline text and escapes spreadsheet formulas on export", async (t) => {
  assert.equal(
    parseSheet('sku,name,notes\r\nA,"A, thing","two\nlines and ""quotes"""')[0]
      .notes,
    'two\nlines and "quotes"',
  );
  assert.throws(() => parseSheet('sku,name\nA,"bad'), /Unclosed/);
  assert.throws(() => parseSheet('sku,name\nA,"name"evil'), /Unexpected/);
  const { request: r } = await fixture(t);
  await r("/api/items", "POST", sample({ name: '=HYPERLINK("bad")' }));
  const csv = await r("/api/export");
  assert.match(csv.data, /'=HYPERLINK/);
  assert.match(csv.headers.get("content-type"), /csv/);
});
test("Google source URLs reject alternate hosts and credentials", () => {
  assert.deepEqual(
    sheetSource(
      "https://docs.google.com/spreadsheets/d/abcDEF123456/edit#gid=42",
    ),
    { spreadsheet_id: "abcDEF123456", gid: "42" },
  );
  for (const url of [
    "http://docs.google.com/spreadsheets/d/abcDEF123456/edit",
    "https://evil.example/spreadsheets/d/abcDEF123456/edit",
    "https://user:pass@docs.google.com/spreadsheets/d/abcDEF123456/edit",
    "https://docs.google.com/spreadsheets/d/abcDEF123456/edit#gid=hello",
  ])
    assert.throws(() => sheetSource(url));
});
test("Google tab preview fetches only fixed Google endpoint and handles access denial", async (t) => {
  let calls = 0;
  const { request: r } = await fixture(t, {
    fetcher: async (url, options) => {
      assert.match(
        url,
        /^https:\/\/docs.google.com\/spreadsheets\/d\/abcDEF123456\/gviz\/tq/,
      );
      assert.equal(options.redirect, "error");
      calls++;
      return calls === 1
        ? new Response("sku,name\nEQ-1,Microphone", {
            headers: { "Content-Type": "text/csv" },
          })
        : new Response("Login required", { status: 403 });
    },
  });
  const data = {
    url: "https://docs.google.com/spreadsheets/d/abcDEF123456/edit#gid=42",
    label: "Equipment",
  };
  const id = (await r("/api/sources", "POST", data)).data.id;
  assert.equal((await r("/api/sources", "POST", data)).status, 409);
  assert.equal(
    (await r(`/api/sources/${id}/preview`)).data.rows[0].status,
    "new",
  );
  assert.equal((await r(`/api/sources/${id}/preview`)).status, 502);
  assert.equal((await r("/api/sources")).data.length, 1);
  assert.equal((await r(`/api/sources/${id}`, "DELETE")).status, 200);
});
test("stock survives an application restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "inventory-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.db");
  const server = createApp({
    dbPath,
    password: "",
    databaseUrl: "",
    databaseToken: "",
    hosted: false,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/items`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample()),
    },
  );
  assert.equal(response.status, 201);
  await response.json();
  await new Promise((r) => server.close(r));
  const { request: r } = await fixture(t, { dbPath });
  assert.equal((await r("/api/items")).data[0].quantity, 10);
});
