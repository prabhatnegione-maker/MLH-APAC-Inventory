import { chromium } from "playwright";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { createApp } from "../server.js";

const server = createApp({
  dbPath: ":memory:",
  databaseUrl: "",
  databaseToken: "",
  hosted: false,
  password: "",
  fetcher: async () =>
    new Response(
      "sku,name,tracking_type,quantity\nSHEET-001,Sheet item,consumable,12",
      { headers: { "Content-Type": "text/csv" } },
    ),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#empty-add").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Add your first item" }).click();
  await page
    .getByLabel("Item name", { exact: true })
    .fill("Wireless microphone");
  await page.getByLabel("SKU", { exact: true }).fill("EQ-001");
  await page.getByLabel("Category", { exact: true }).fill("Equipment");
  await page
    .getByLabel("Tracking type", { exact: true })
    .selectOption("returnable");
  await page.getByLabel("Opening quantity").fill("10");
  await page.getByLabel("Unit cost (USD)").fill("89.99");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.locator("#item-dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Lend", exact: true }).click();
  await page.getByLabel("Event", { exact: true }).fill("APAC meetup");
  await page.getByLabel("Borrower / responsible person").fill("AV team");
  await page.locator("#event-form [name=quantity]").fill("4");
  await page.getByRole("button", { name: "Record usage" }).click();
  await page.locator("#event-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector("#stat-units").textContent === "6",
  );
  await page
    .getByRole("button", { name: "Stock activity", exact: true })
    .click();
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.getByLabel("Quantity returned").fill("2");
  await page.getByRole("button", { name: "Record return" }).click();
  await page.locator("#return-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector("#stat-units").textContent === "8",
  );
  assert.match(await page.locator("#loans-body").innerText(), /2 of 4/);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page
    .getByRole("button", { name: "Add item", exact: false })
    .first()
    .click();
  await page.getByLabel("Item name", { exact: true }).fill("Event lanyards");
  await page.getByLabel("SKU", { exact: true }).fill("SUP-001");
  await page.getByLabel("Opening quantity").fill("20");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await page.locator("#item-dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await page.getByLabel("Event", { exact: true }).fill("APAC meetup");
  await page.locator("#event-form [name=quantity]").fill("5");
  await page.getByRole("button", { name: "Record usage" }).click();
  await page.locator("#event-dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("searchbox", { name: "Search inventory" })
    .fill("lanyard");
  assert.equal(await page.locator("#items-body tr").count(), 1);
  assert.match(await page.locator("#items-body").innerText(), /15/);
  await page.getByRole("searchbox", { name: "Search inventory" }).fill("");
  await page
    .getByRole("button", { name: "Google Sheets", exact: true })
    .click();
  const csv =
    "sku,name,tracking_type,quantity\nSUP-001,Event lanyards,consumable,999\nNEW-001,Notebook,consumable,5";
  await page.locator("#csv-file").setInputFiles({
    name: "inventory.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.locator("#import-preview").waitFor({ state: "visible" });
  assert.match(await page.locator("#preview-title").innerText(), /1 new SKU/);
  await page.getByRole("button", { name: "Add new SKUs", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#stat-items").textContent === "3",
  );
  await page.getByLabel("Tab label").fill("General");
  await page
    .getByLabel("Google Sheet tab link")
    .fill("https://docs.google.com/spreadsheets/d/abcDEF123456/edit#gid=0");
  await page.getByRole("button", { name: "Connect tab" }).click();
  await page.getByRole("button", { name: "Check for SKUs" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#preview-body").textContent.includes("SHEET-001"),
  );
  await page.getByRole("button", { name: "Add new SKUs", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#stat-items").textContent === "4",
  );
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.screenshot({ path: "/tmp/inventory-desktop.png", fullPage: true });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#stat-items").textContent === "4",
  );
  const items = await (await fetch(base + "/api/items")).json();
  assert.equal(items.find((i) => i.sku === "SUP-001").quantity, 15);
  assert.equal(items.find((i) => i.sku === "EQ-001").quantity, 8);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/inventory-mobile.png", fullPage: true });
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("body *")]
      .filter(
        (e) =>
          e.getBoundingClientRect().right > innerWidth + 1 &&
          getComputedStyle(e).position !== "absolute",
      )
      .map((e) => ({
        tag: e.tagName,
        id: e.id,
        class: e.className,
        right: e.getBoundingClientRect().right,
      }))
      .slice(0, 20),
  }));
  assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
  await page.screenshot({ path: "/tmp/inventory-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: item creation, event consumption, checkout, partial return, search, CSV import, Google tab preview (mocked), reload, and mobile layout.",
  );
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
