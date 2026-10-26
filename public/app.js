const $ = (s) => document.querySelector(s);
let items = [],
  view = "inventory",
  toastTimer;
const money = (cents) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Request failed.");
  return body;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4000);
}
function error(message) {
  $("#error-banner").textContent = message;
  $("#error-banner").hidden = !message;
}
function render() {
  $("#stat-items").textContent = items.length.toLocaleString();
  $("#stat-units").textContent = items
    .reduce((s, i) => s + i.quantity, 0)
    .toLocaleString();
  $("#stat-value").textContent = money(
    items.reduce((s, i) => s + i.quantity * i.price_cents, 0),
  );
  $("#stat-low").textContent = items.filter(
    (i) => i.quantity <= i.minimum,
  ).length;
  $("#item-count").textContent = items.length;
  const category = $("#category").value;
  const categories = [...new Set(items.map((i) => i.category))].sort();
  $("#category").innerHTML =
    '<option value="">All categories</option>' +
    categories
      .map((c) => `<option value="${escape(c)}">${escape(c)}</option>`)
      .join("");
  $("#category").value = categories.includes(category) ? category : "";
  $("#category-list").innerHTML = categories
    .map((c) => `<option value="${escape(c)}"></option>`)
    .join("");
  const query = $("#search").value.trim().toLowerCase(),
    stock = $("#stock").value;
  const filtered = items.filter(
    (i) =>
      (!category || i.category === category) &&
      [i.name, i.sku, i.location, i.category].some((v) =>
        v.toLowerCase().includes(query),
      ) &&
      (!stock ||
        (stock === "low" && i.quantity <= i.minimum) ||
        (stock === "out" && i.quantity === 0) ||
        (stock === "healthy" && i.quantity > i.minimum)),
  );
  $("#items-body").innerHTML = filtered
    .map(
      (i) =>
        `<tr><td><div class="item-cell"><span class="item-avatar">${escape(i.name.slice(0, 2).toUpperCase())}</span><div><strong>${escape(i.name)}</strong><small>${escape(i.sku)} · ${i.tracking_type === "returnable" ? "Returnable" : "Consumable"}${i.outstanding ? " · " + i.outstanding + " checked out" : ""}</small></div></div></td><td>${escape(i.category)}</td><td>${escape(i.location) || "—"}</td><td><span class="quantity">${i.quantity}</span> <span class="badge ${i.quantity === 0 ? "out" : i.quantity <= i.minimum ? "low" : ""}">${i.quantity === 0 ? "Out of stock" : i.quantity <= i.minimum ? "Low stock" : "In stock"}</span><small>Minimum ${i.minimum}</small></td><td>${money(i.price_cents)}</td><td><div class="actions"><button data-action="adjust" data-id="${i.id}">Stock</button>${i.tracking_type === "returnable" ? `<button data-action="checkout" data-id="${i.id}">Lend</button>` : `<button data-action="consume" data-id="${i.id}">Use</button>`}<button data-action="edit" data-id="${i.id}">Edit</button><button data-action="delete" data-id="${i.id}" aria-label="Delete ${escape(i.name)}">×</button></div></td></tr>`,
    )
    .join("");
  $("#empty").hidden = filtered.length > 0;
  $("#empty-title").textContent = items.length
    ? "No matching items."
    : "Make room for your first item.";
  $("#empty-text").textContent = items.length
    ? "Try another search or clear your filters."
    : "Add what you keep on hand. We’ll help you keep track.";
  $("#empty-add").hidden = items.length > 0;
  $("#results").textContent =
    `Showing ${filtered.length} of ${items.length} items`;
}
async function load() {
  try {
    items = await api("/api/items");
    render();
    error("");
  } catch (e) {
    error(`${e.message} Refresh to try again.`);
  }
}
function openItem(i) {
  const form = $("#item-form");
  form.reset();
  form.querySelector(".form-error").textContent = "";
  $("#item-dialog-title").textContent = i ? "Edit item" : "Add an item";
  form.elements.id.value = i?.id || "";
  form.elements.sku.readOnly = !!i;
  if (i)
    for (const k of [
      "name",
      "sku",
      "category",
      "location",
      "minimum",
      "notes",
      "tracking_type",
    ])
      form.elements[k].value = i[k];
  form.elements.price.value = i ? i.price_cents / 100 : 0;
  $("#quantity-label").hidden = !!i;
  form.elements.quantity.disabled = !!i;
  $("#item-dialog").showModal();
}
async function activity() {
  try {
    const rows = await api("/api/movements");
    $("#activity-body").innerHTML = rows
      .map(
        (m) =>
          `<tr><td><strong>${escape(m.item_name)}</strong><small>${escape(m.sku)}</small></td><td class="${m.delta >= 0 ? "delta-positive" : "delta-negative"}">${m.delta > 0 ? "+" : ""}${m.delta}</td><td>${escape(m.reason)}</td><td>${escape(new Date(m.created_at).toLocaleString())}</td></tr>`,
      )
      .join("");
    $("#activity-empty").hidden = rows.length > 0;
    await loadLoans();
  } catch (e) {
    error(e.message);
  }
}
for (const button of document.querySelectorAll(".nav"))
  button.addEventListener("click", () => {
    view = button.dataset.view;
    document
      .querySelectorAll(".nav")
      .forEach((b) => b.classList.toggle("active", b === button));
    for (const name of ["inventory", "activity", "sheets"])
      $(`#${name}-view`).hidden = view !== name;
    const label = {
      inventory: "Inventory",
      activity: "Stock activity",
      sheets: "Google Sheets",
    }[view];
    $("#page-label").textContent = label;
    $("#page-title").textContent = {
      inventory: "Your inventory, at a glance.",
      activity: "Every move, accounted for.",
      sheets: "One SKU. One source of truth.",
    }[view];
    $("#page-description").textContent = {
      inventory: "Keep the essentials in stock and your next move in sight.",
      activity: "Track event consumption, equipment loans, and returns.",
      sheets: "Discover new SKUs across your spreadsheet tabs.",
    }[view];
    if (view === "activity") activity();
    if (view === "sheets") loadSources();
  });
$("#add-item").onclick = () => openItem();
$("#empty-add").onclick = () => openItem();
for (const s of ["#search", "#category", "#stock"])
  $(s).addEventListener(s === "#search" ? "input" : "change", render);
for (const b of document.querySelectorAll(".close-dialog"))
  b.onclick = () => b.closest("dialog").close();
$("#items-body").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  const i = items.find((i) => i.id === Number(b.dataset.id));
  if (b.dataset.action === "edit") return openItem(i);
  if (["checkout", "consume"].includes(b.dataset.action))
    return openEvent(i, b.dataset.action);
  const action = b.dataset.action,
    f = $(`#${action}-form`);
  f.reset();
  f.elements.id.value = i.id;
  f.querySelector(".form-error").textContent = "";
  $(`#${action}-description`).textContent =
    action === "adjust"
      ? `${i.name} (${i.sku}) · ${i.quantity} available`
      : `${i.name} (${i.sku}) will be removed from your inventory.`;
  $(`#${action}-dialog`).showModal();
});
function submit(selector, handler) {
  $(selector).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target,
      button = f.querySelector("[type=submit]");
    button.disabled = true;
    f.querySelector(".form-error").textContent = "";
    try {
      await handler(f);
      f.closest("dialog").close();
      await load();
      if (view === "activity") await activity();
    } catch (e) {
      f.querySelector(".form-error").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  });
}
submit("#item-form", async (f) => {
  const data = Object.fromEntries(new FormData(f));
  const id = data.id;
  delete data.id;
  data.minimum = Number(data.minimum);
  data.price_cents = Math.round(Number(data.price) * 100);
  delete data.price;
  if (id) delete data.quantity;
  else data.quantity = Number(data.quantity);
  await api("/api/items" + (id ? `/${id}` : ""), {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(data),
  });
  toast(id ? "Item updated." : "Item added to inventory.");
});
submit("#adjust-form", async (f) => {
  await api(`/api/items/${f.elements.id.value}/adjust`, {
    method: "POST",
    body: JSON.stringify({
      delta:
        Number(f.elements.amount.value) * Number(f.elements.direction.value),
      reason: f.elements.reason.value,
    }),
  });
  toast("Stock updated.");
});
submit("#delete-form", async (f) => {
  await api(`/api/items/${f.elements.id.value}`, { method: "DELETE" });
  toast("Item deleted. Stock history retained.");
});
$("#refresh").onclick = activity;
window.addEventListener("unhandledrejection", (e) =>
  error(e.reason?.message || "Something went wrong. Please refresh."),
);
load();

let loans = [],
  pendingCsv = "",
  syncing = false;
function openEvent(i, operation) {
  const f = $("#event-form");
  f.reset();
  f.querySelector(".form-error").textContent = "";
  f.elements.id.value = i.id;
  f.elements.operation.value = operation;
  f.elements.quantity.max = i.quantity;
  f.elements.borrower.required = operation === "checkout";
  $("#borrower-label").hidden = operation !== "checkout";
  $("#event-title").textContent =
    operation === "checkout"
      ? "Check out equipment"
      : "Record event consumption";
  $("#event-description").textContent =
    `${i.name} (${i.sku}) · ${i.quantity} available`;
  $("#event-dialog").showModal();
}
submit("#event-form", async (f) => {
  const b = {
    quantity: Number(f.elements.quantity.value),
    event: f.elements.event.value,
    borrower: f.elements.borrower.value,
  };
  await api(`/api/items/${f.elements.id.value}/${f.elements.operation.value}`, {
    method: "POST",
    body: JSON.stringify(b),
  });
  toast("Event usage recorded.");
});
async function loadLoans() {
  loans = await api("/api/loans");
  $("#loans-body").innerHTML = loans
    .map(
      (l) =>
        `<tr><td><strong>${escape(l.name)}</strong><small>${escape(l.sku)}</small></td><td>${escape(l.event)}<small>${escape(l.borrower)}</small></td><td>${l.quantity - l.returned} of ${l.quantity}</td><td><button class="secondary" data-loan="${l.id}">Return</button></td></tr>`,
    )
    .join("");
  $("#loans-empty").hidden = !!loans.length;
}
$("#loans-body").onclick = (e) => {
  const b = e.target.closest("[data-loan]");
  if (!b) return;
  const l = loans.find((l) => l.id === Number(b.dataset.loan));
  const f = $("#return-form");
  f.reset();
  f.querySelector(".form-error").textContent = "";
  f.elements.id.value = l.id;
  f.elements.quantity.value = l.quantity - l.returned;
  f.elements.quantity.max = l.quantity - l.returned;
  $("#return-description").textContent =
    `${l.name} · ${l.event} · ${l.borrower}`;
  $("#return-dialog").showModal();
};
submit("#return-form", async (f) => {
  await api(`/api/loans/${f.elements.id.value}/return`, {
    method: "POST",
    body: JSON.stringify({ quantity: Number(f.elements.quantity.value) }),
  });
  toast("Equipment returned to available stock.");
});
function showPreview(data, csv) {
  pendingCsv = csv;
  const count = data.rows.filter((r) => r.status === "new").length;
  $("#preview-title").textContent =
    `${count} new SKU${count === 1 ? "" : "s"} found · ${data.rows.length} rows checked`;
  $("#preview-body").innerHTML = data.rows
    .map(
      (r) =>
        `<tr><td>${escape(r.sku)}</td><td>${escape(r.name)}</td><td>${escape(r.tracking_type)}</td><td><span class="badge ${r.status === "conflict" ? "low" : ""}">${{ new: "New SKU", tracked: "Already tracked", conflict: "Needs review" }[r.status]}</span></td></tr>`,
    )
    .join("");
  $("#import-button").disabled = count === 0;
  $("#import-preview").hidden = false;
}
async function loadSources() {
  const sources = await api("/api/sources");
  $("#sources-list").innerHTML = sources.length
    ? sources
        .map(
          (s) =>
            `<li><strong>${escape(s.label)}</strong> · Tab ${escape(s.gid)} <button class="secondary" data-source="${s.id}">Check for SKUs</button> <button class="secondary" data-remove-source="${s.id}">Disconnect</button><span id="source-status-${s.id}"></span></li>`,
        )
        .join("")
    : "<li>No connected tabs yet. You can also upload a CSV.</li>";
}
$("#source-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target,
    b = f.querySelector("button");
  b.disabled = true;
  f.querySelector(".form-error").textContent = "";
  try {
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(f))),
    });
    f.reset();
    await loadSources();
    toast("Tab connected. Check for SKUs to verify access.");
  } catch (e) {
    f.querySelector(".form-error").textContent = e.message;
  } finally {
    b.disabled = false;
  }
};
$("#sources-list").onclick = async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.removeSource) {
      await api(`/api/sources/${b.dataset.removeSource}`, { method: "DELETE" });
      await loadSources();
      toast("Tab disconnected. Inventory items were retained.");
    } else {
      const data = await api(`/api/sources/${b.dataset.source}/preview`);
      showPreview(data, data.csv);
      $("#sync-status").textContent =
        `Last checked ${new Date().toLocaleTimeString()}`;
    }
  } catch (e) {
    error(e.message);
  } finally {
    b.disabled = false;
  }
};
$("#csv-file").onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 1_000_000)
      throw new Error("Upload a CSV smaller than 1 MB.");
    const csv = await file.text();
    const data = await api("/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ csv }),
    });
    showPreview(data, csv);
    error("");
  } catch (e) {
    error(e.message);
  }
};
$("#import-button").onclick = async () => {
  const button = $("#import-button");
  button.disabled = true;
  try {
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ csv: pendingCsv }),
    });
    await load();
    const preview = await api("/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ csv: pendingCsv }),
    });
    showPreview(preview, pendingCsv);
    toast(
      `${result.added} new SKUs added. ${result.skipped} existing SKUs preserved.`,
    );
  } catch (e) {
    error(e.message);
    button.disabled = false;
  }
};
async function checkSheets() {
  if (syncing || document.hidden) return;
  syncing = true;
  try {
    const sources = await api("/api/sources");
    let count = 0,
      failures = 0;
    for (const source of sources) {
      try {
        const data = await api(`/api/sources/${source.id}/preview`),
          added = data.rows.filter((r) => r.status === "new").length;
        count += added;
        const status = $(`#source-status-${source.id}`);
        if (status)
          status.textContent = ` · ${added} new SKU${added === 1 ? "" : "s"}`;
      } catch {
        failures++;
        const status = $(`#source-status-${source.id}`);
        if (status)
          status.textContent =
            " · Check failed — use Check for SKUs for details.";
      }
    }
    if (sources.length)
      $("#sync-status").textContent =
        `Checked ${new Date().toLocaleTimeString()}: ${count} new SKU rows across ${sources.length} tabs.${failures ? ` ${failures} tab checks failed.` : ""}`;
    if (count)
      toast(
        `${count} new SKU rows detected in Google Sheets. Review them in Google Sheets → Check for SKUs.`,
      );
  } catch (e) {
    $("#sync-status").textContent = e.message;
  } finally {
    syncing = false;
  }
}
loadSources()
  .then(checkSheets)
  .catch((e) => error(e.message));
setInterval(checkSheets, 60000);
