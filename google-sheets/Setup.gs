/** Run createInventoryWorkbook once from a standalone Google Apps Script project. */
const SKU_HEADERS = [
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
const SKU_TABS = ["Equipment", "Supplies", "General"];

function createInventoryWorkbook() {
  const properties = PropertiesService.getScriptProperties();
  const existing = properties.getProperty("INVENTORY_SPREADSHEET_ID");
  if (existing) {
    console.log(
      "Existing inventory spreadsheet: " +
        SpreadsheetApp.openById(existing).getUrl(),
    );
    return;
  }
  const book = SpreadsheetApp.create("MLH APAC · SKU Inventory");
  properties.setProperty("INVENTORY_SPREADSHEET_ID", book.getId());
  const instructions = book.getSheets()[0];
  instructions.setName("Read me");
  const lines = [
    ["MLH APAC · SKU Inventory"],
    [
      "Add items in Equipment, Supplies, or General. Each SKU identifies one item across all tabs.",
    ],
    [
      "New valid SKUs are copied to SKU Registry and highlighted green in the source tab.",
    ],
    [
      "Matching SKUs are highlighted blue. Conflicting names or tracking types are highlighted amber.",
    ],
    [
      "Use consumable for items used up at an event; returnable for equipment that comes back.",
    ],
    [
      "quantity is OPENING stock, not the current balance. Use the inventory app for movements and returns.",
    ],
    [
      "Connect SKU Registry to the app for a single deduplicated source, or connect individual source tabs.",
    ],
    [
      "This spreadsheet is PRIVATE by default. Download a tab as CSV to import without sharing it.",
    ],
    [
      "Optional: Share → General access → Anyone with the link → Viewer to enable direct app reading.",
    ],
    [
      "The app checks connected tabs every 60 seconds while open and flags new SKUs for review.",
    ],
    [
      "After import, the app owns live balances. The sheet remains a SKU catalogue; there is no two-way stock sync.",
    ],
    [
      "Costs are in USD. Do not put passwords, customer information, or other secrets in a public sheet.",
    ],
    [
      "SKU Registry is generated from source tabs. Fix conflicts in the source and review Registry metadata manually.",
    ],
  ];
  instructions.getRange(1, 1, lines.length, 1).setValues(lines);
  instructions.setColumnWidth(1, 950);
  instructions.getDataRange().setWrap(true);
  instructions.getRange("A1").setFontSize(18).setFontWeight("bold");
  ["SKU Registry"].concat(SKU_TABS).forEach((name) => {
    const sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, SKU_HEADERS.length).setValues([SKU_HEADERS]);
    sheet
      .getRange(1, 1, 1, SKU_HEADERS.length)
      .setBackground("#164c3b")
      .setFontColor("#ffffff")
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, SKU_HEADERS.length, 150);
    sheet.setColumnWidth(2, 230);
    sheet.setColumnWidth(9, 300);
    sheet
      .getRange("D2:D1000")
      .setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(["consumable", "returnable"], true)
          .setAllowInvalid(false)
          .build(),
      );
    sheet
      .getRange("F2:G1000")
      .setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireFormulaSatisfied("=AND(ISNUMBER(F2),F2>=0,MOD(F2,1)=0)")
          .setAllowInvalid(false)
          .build(),
      );
    sheet.getRange("H2:H1000").setNumberFormat("0.00");
    sheet
      .getRange("A1")
      .setNote(
        "Required. Case-insensitive, unique item identity across the workbook.",
      );
    sheet
      .getRange("F1")
      .setNote(
        "Opening stock only. Record live consumption, loans, and returns in the app.",
      );
  });
  ScriptApp.newTrigger("registerSkuEdits")
    .forSpreadsheet(book)
    .onEdit()
    .create();
  book.setActiveSheet(book.getSheetByName("Equipment"));
  console.log("Created your private spreadsheet: " + book.getUrl());
}

/** Installable edit trigger; supports multirow pastes and does not call external services. */
function registerSkuEdits(event) {
  if (!event || !SKU_TABS.includes(event.range.getSheet().getName())) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const registry = event.source.getSheetByName("SKU Registry");
    const count = Math.max(0, registry.getLastRow() - 1);
    const records = count
      ? registry.getRange(2, 1, count, SKU_HEADERS.length).getValues()
      : [];
    const provenance = count
      ? registry.getRange(2, 1, count, 1).getNotes()
      : [];
    const index = new Map(
      records.map((row, n) => [
        String(row[0]).trim().toLowerCase(),
        { values: row, row: n + 2, source: provenance[n][0] },
      ]),
    );
    const sheet = event.range.getSheet(),
      start = Math.max(2, event.range.getRow()),
      end = event.range.getLastRow();
    if (end < start) return;
    const owner = "Source tab: " + sheet.getSheetId();
    const counts = new Map();
    sheet
      .getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1)
      .getValues()
      .forEach((r) => {
        const key = String(r[0]).trim().toLowerCase();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      });
    const rows = sheet
      .getRange(start, 1, end - start + 1, SKU_HEADERS.length)
      .getValues();
    rows.forEach((row, n) => {
      const sku = String(row[0]).trim(),
        name = String(row[1]).trim(),
        type =
          String(row[3]).trim() ||
          (sheet.getName() === "Equipment" ? "returnable" : "consumable");
      const range = sheet.getRange(start + n, 1, 1, SKU_HEADERS.length);
      const flag = (message) => {
        range.setBackground("#fff0c2");
        range.getCell(1, 1).setNote(message);
      };
      if (!sku) {
        range.setBackground(null);
        range.getCell(1, 1).clearNote();
        return;
      }
      if (counts.get(sku.toLowerCase()) > 1) {
        flag("Duplicate SKU in this tab. Keep one row per SKU.");
        return;
      }
      if (
        !name ||
        !["returnable", "consumable"].includes(type) ||
        sku.length > 80 ||
        name.length > 150
      ) {
        flag(
          "Needs review: add a name and a valid tracking type. SKU max 80 characters; name max 150.",
        );
        return;
      }
      row[0] = sku;
      row[1] = name;
      row[2] = String(row[2]).trim() || sheet.getName();
      row[3] = type;
      row[5] = row[5] === "" ? 0 : Number(row[5]);
      row[6] = row[6] === "" ? 5 : Number(row[6]);
      row[7] = row[7] === "" ? 0 : Number(row[7]);
      if (
        !Number.isSafeInteger(row[5]) ||
        row[5] < 0 ||
        row[5] > 1000000000 ||
        !Number.isSafeInteger(row[6]) ||
        row[6] < 0 ||
        row[6] > 1000000000 ||
        !Number.isFinite(row[7]) ||
        row[7] < 0 ||
        row[7] > 1000000 ||
        Math.abs(row[7] * 100 - Math.round(row[7] * 100)) > 0.00001
      ) {
        flag(
          "Needs review: quantity and minimum must be whole non-negative numbers; unit_cost must be a non-negative USD amount with up to two decimals.",
        );
        return;
      }
      const previous = index.get(sku.toLowerCase());
      if (previous && previous.source !== owner) {
        const conflict =
          String(previous.values[1]).trim() !== name ||
          String(previous.values[3]).trim() !== type;
        range.setBackground(conflict ? "#fff0c2" : "#e5effa");
        range
          .getCell(1, 1)
          .setNote(
            conflict
              ? "SKU conflict: the Registry has a different name or tracking type. Review both records."
              : "This SKU is already registered in another source tab. Existing stock is not changed.",
          );
        return;
      }
      const safeRow = row.slice();
      // Treat spreadsheet text as text, even when it begins with a formula prefix.
      [0, 1, 2, 4, 8].forEach((i) => {
        if (/^[=+\-@]/.test(String(safeRow[i]))) safeRow[i] = "'" + safeRow[i];
      });
      const targetRow = previous ? previous.row : registry.getLastRow() + 1;
      registry
        .getRange(targetRow, 1, 1, SKU_HEADERS.length)
        .setValues([safeRow]);
      registry.getRange(targetRow, 1).setNote(owner);
      index.set(sku.toLowerCase(), {
        values: row,
        row: targetRow,
        source: owner,
      });
      range.setBackground(previous ? "#e5effa" : "#e6f3db");
      range
        .getCell(1, 1)
        .setNote(
          previous
            ? "SKU catalogue updated. Already-imported app balances are never overwritten."
            : "New SKU registered. It will be highlighted for review on the next app sheet check.",
        );
      sheet.getRange(start + n, 4).setValue(type);
    });
  } finally {
    lock.releaseLock();
  }
}
