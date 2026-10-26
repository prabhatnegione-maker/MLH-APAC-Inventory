import { createApp } from "./server.js";
const server = createApp();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { "Content-Type": "application/json" };
if (process.env.INVENTORY_PASSWORD)
  headers.Authorization = `Basic ${Buffer.from(`admin:${process.env.INVENTORY_PASSWORD}`).toString("base64")}`;
try {
  const existing = await (await fetch(base + "/api/items", { headers })).json();
  if (existing.length)
    console.log("Inventory already contains items; no demo data added.");
  else {
    const samples = [
      [
        "USB-C adapters",
        "TECH-001",
        "Equipment",
        "Shelf A",
        24,
        5,
        1599,
        "returnable",
      ],
      [
        "Event lanyards",
        "EVT-001",
        "Event supplies",
        "Storage B",
        150,
        40,
        125,
        "consumable",
      ],
      [
        "Wireless microphones",
        "AV-001",
        "Equipment",
        "AV cabinet",
        8,
        2,
        8999,
        "returnable",
      ],
      [
        "A5 notebooks",
        "OFF-001",
        "Supplies",
        "Shelf C",
        4,
        10,
        350,
        "consumable",
      ],
      [
        "Power strips",
        "TECH-002",
        "Equipment",
        "Shelf A",
        0,
        5,
        1899,
        "returnable",
      ],
      [
        "Sticker packs",
        "EVT-002",
        "Event supplies",
        "Storage B",
        90,
        25,
        200,
        "consumable",
      ],
    ];
    for (const [
      name,
      sku,
      category,
      location,
      quantity,
      minimum,
      price_cents,
      tracking_type,
    ] of samples) {
      const r = await fetch(base + "/api/items", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          sku,
          category,
          location,
          quantity,
          minimum,
          price_cents,
          tracking_type,
        }),
      });
      if (!r.ok) throw Error(await r.text());
    }
    console.log("Added 6 clearly identified demo items.");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
