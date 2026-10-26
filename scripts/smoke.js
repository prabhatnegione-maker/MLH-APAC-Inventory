const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const headers = {};
if (process.env.INVENTORY_PASSWORD)
  headers.Authorization = `Basic ${Buffer.from(`admin:${process.env.INVENTORY_PASSWORD}`).toString("base64")}`;
for (const path of ["/api/health", "/api/items"]) {
  const response = await fetch(base + path, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const data = await response.json();
  if (path === "/api/health" && data.status !== "ok")
    throw new Error("Unexpected health response");
  if (path === "/api/items" && !Array.isArray(data))
    throw new Error("Unexpected inventory response");
  console.log(
    `${path}: OK${Array.isArray(data) ? ` (${data.length} items)` : ""}`,
  );
}
