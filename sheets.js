export const sheetHeaders = [
  "sku",
  "name",
  "category",
  "tracking_type",
  "location",
  "quantity",
  "minimum",
  "unit_cost",
  "notes",
];
export function parseSheet(csv) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 1_000_000)
    throw fail("CSV must be text smaller than 1 MB.");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  csv = csv.replace(/^\uFEFF/, "");
  for (let n = 0; n < csv.length; n++) {
    const c = csv[n];
    if (quoted) {
      if (c === '"') {
        if (csv[n + 1] === '"') {
          field += '"';
          n++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw fail("Invalid CSV quoting.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && csv[n + 1] === "\n") n++;
        rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw fail("Unexpected content after a quoted CSV field.");
      field += c;
    }
  }
  if (quoted) throw fail("Unclosed CSV quote.");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  const nonempty = rows.filter((r) => r.some((c) => c.trim()));
  if (nonempty.length < 1) throw fail("CSV is empty.");
  if (nonempty.length > 5001) throw fail("Import at most 5000 rows at a time.");
  const headers = nonempty
    .shift()
    .map((h) => h.trim().toLowerCase().replaceAll(" ", "_"));
  if (new Set(headers).size !== headers.length)
    throw fail("Duplicate column headers.");
  if (!headers.includes("sku") || !headers.includes("name"))
    throw fail(
      "The sheet needs sku and name columns. Download the template for the full format.",
    );
  const seen = new Set();
  return nonempty.map((r, index) => {
    if (r.length !== headers.length)
      throw fail(`Row ${index + 2}: column count does not match the header.`);
    const obj = Object.fromEntries(headers.map((h, n) => [h, r[n].trim()]));
    if (!obj.sku || !obj.name)
      throw fail(`Row ${index + 2}: SKU and name are required.`);
    const key = obj.sku.toLowerCase();
    if (seen.has(key))
      throw fail(`Row ${index + 2}: duplicate SKU ${obj.sku}.`);
    seen.add(key);
    const number = (value, fallback, label) => {
      const n = value ? Number(value) : fallback;
      if (!Number.isFinite(n) || n < 0)
        throw fail(`Row ${index + 2}: invalid ${label}.`);
      return n;
    };
    const cost = number(obj.unit_cost, 0, "unit cost");
    if (Math.abs(cost * 100 - Math.round(cost * 100)) > 0.00001)
      throw fail(
        `Row ${index + 2}: unit cost must have at most two decimal places.`,
      );
    return {
      sku: obj.sku,
      name: obj.name,
      category: obj.category || "General",
      tracking_type: obj.tracking_type || "consumable",
      location: obj.location || "",
      quantity: number(obj.quantity, 0, "quantity"),
      minimum: number(obj.minimum, 5, "minimum"),
      price_cents: Math.round(cost * 100),
      notes: obj.notes || "",
    };
  });
}
export function sheetSource(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Enter a Google Sheets URL."), {
      status: 400,
    });
  }
  const match = url.pathname.match(
    /^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw Object.assign(
      new Error("Use an https://docs.google.com/spreadsheets/d/... URL."),
      { status: 400 },
    );
  const gid =
    new URLSearchParams(url.hash.slice(1)).get("gid") ||
    url.searchParams.get("gid") ||
    "0";
  if (!/^\d{1,20}$/.test(gid))
    throw Object.assign(new Error("Invalid sheet tab ID."), { status: 400 });
  return { spreadsheet_id: match[1], gid };
}
export async function downloadSheet(source, fetcher = fetch) {
  const url = `https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/gviz/tq?tqx=out:csv&gid=${source.gid}`;
  let response;
  try {
    response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "text/csv" },
    });
  } catch {
    throw Object.assign(
      new Error(
        "Could not read this sheet. Check network access and make this sheet readable by anyone with its link, or upload a CSV for a private sheet.",
      ),
      { status: 502 },
    );
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("csv"))
    throw Object.assign(
      new Error(
        "Google did not return a readable CSV. Check sharing permissions and the tab URL. Private sheets can be imported by CSV upload.",
      ),
      { status: 502 },
    );
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1_000_000)
      throw Object.assign(new Error("Sheet exceeds the 1 MB import limit."), {
        status: 413,
      });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
