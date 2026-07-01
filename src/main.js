const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const WINDOW = getCurrentWindow();

// "sidebar" width is fixed on purpose (orb 250 + gap 12 + sidebar column 200 + app padding).
// Bubbles inside the sidebar are capped at 100% of that fixed column (see style.css),
// so the window never needs to be measured/resized based on text content — this avoids
// the previous bug where long drug names got clipped past the left edge of the window.
const SIZES = {
  collapsed: { width: 250, height: 288 },
  sidebar: { width: 500, height: 320 },
};

const WINDOW_LAYOUT_PADDING_Y = 24;

const ORB_STATES = ["state-idle", "state-thinking", "state-success", "state-error"];

const $ = (id) => document.getElementById(id);

const orb = $("orb");
const drugSidebar = $("drug-sidebar");
const drugList = $("drug-list");
const manualEntryRow = $("manual-entry-row");
const manualNameInput = $("manual-name-input");
const sidebarLookupDetail = $("sidebar-lookup-detail");
const profileBadge = $("profile-badge");
const scanFallback = $("scan-fallback");
const orbScanDisplay = $("orb-scan-display");
const orbHookBuffer = $("orb-hook-buffer");

let lastHookBuffer = "";
let lastAcceptedBarcode = "";
let pendingManualBarcode = "";

const MANUAL_ENTRY_BARCODE = "manual-entry";

/** @type {Array<{id:string,barcode:string,found:boolean,productName:string,activeIngredient:string,atcCode:string,recommendation:string|null,errorMessage:string|null,status:string}>} */
let scannedDrugs = [];
let activeDrugId = null;
let sidebarOpen = false;
let processing = false;
let lookupInFlight = false;

const RECOMMENDATION_TIMEOUT_MS = 35000;

const GREEK_LAYOUT_DIGIT_MAP_DEFAULT = Object.freeze({
  c: "0", C: "0", o: "0", O: "0", "ο": "0", "Ο": "0",
  g: "6", G: "6", b: "8", B: "8",
  q: "1", Q: "1", l: "1", L: "1", I: "1", i: "1",
  z: "2", Z: "2", e: "3", E: "3",
  a: "4", A: "4", s: "5", S: "5",
  t: "7", T: "7", y: "9", Y: "9",
});

const GREEK_LAYOUT_DIGIT_MAP_OVERRIDE = Object.freeze({});

const GREEK_LAYOUT_DIGIT_MAP = Object.freeze({
  ...GREEK_LAYOUT_DIGIT_MAP_DEFAULT,
  ...GREEK_LAYOUT_DIGIT_MAP_OVERRIDE,
});

const INVALID_SCAN_FORMAT_MESSAGE = "Μη έγκυρη μορφή barcode.";
const NETWORK_ERROR_MESSAGE =
  "Αποτυχία σύνδεσης με Supabase. Ελέγξτε δίκτυο ή firewall και δοκιμάστε ξανά.";
const PRODUCT_NOT_FOUND_MESSAGE = "Το προϊόν δεν βρέθηκε στη βάση δεδομένων.";

function buildUiError(errorMessage, rawResponse = "") {
  return {
    success: false,
    error_message: errorMessage || "Σφάλμα",
    raw_response: rawResponse || "",
  };
}

// Strip dosage + packaging tail so only the drug name remains, e.g.
//   "VARESTA F.C.TAB 5MG/TAB BT X 28 TABS ΣΕ BLISTER PVC/PVDC//ALU" -> "VARESTA F.C.TAB"
//   "LENVATINIB/ELPEN CAPS 4MG/CAP BT X 30 CAPS ΣΕ BLISTER OPA/A"   -> "LENVATINIB/ELPEN CAPS"
//   "AUGMENTIN F.C.TAB (875+125)MG/TAB BTx12"                        -> "AUGMENTIN F.C.TAB"
function shortDisplayName(fullName) {
  const raw = String(fullName ?? "").trim();
  if (!raw) return "—";

  // Markers where the packaging/dosage part begins.
  const cutMarkers = [
    /\(?\d[\d.,+\s]*\)?\s*(MG|MCG|ML|G|IU|%)\b/i, // dosage: 5MG, 4MG/CAP, (875+125)MG
    /\bBT\s*X?\b/i,                                // packaging: BT X 30, BTx12
    /\bΣΕ\b/,                                      // Greek "in" (ΣΕ BLISTER ...)
    /\bBLISTER\b/i,
    /\(/,                                          // any parenthesis group
  ];

  let cutIdx = raw.length;
  for (const marker of cutMarkers) {
    const m = raw.match(marker);
    if (m && m.index !== undefined && m.index > 0 && m.index < cutIdx) {
      cutIdx = m.index;
    }
  }

  let name = raw.slice(0, cutIdx).trim();
  name = name.replace(/[\s,\-–/]+$/, "").trim();
  if (!name) name = raw.trim();

  if (name.length <= 60) return name;
  return `${name.slice(0, 59)}…`;
}

function createDrugId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `drug-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function findDrugByBarcode(barcode) {
  return scannedDrugs.find((d) => d.barcode === barcode) ?? null;
}

function findDrugById(id) {
  return scannedDrugs.find((d) => d.id === id) ?? null;
}

function sanitizeBarcodeInput(rawValue) {
  return String(rawValue ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s/g, "")
    .trim();
}

function mapGreekLayoutToDigits(value) {
  return Array.from(value).map((char) => GREEK_LAYOUT_DIGIT_MAP[char] ?? char).join("");
}

const ASCII_TRIPLET_MIN_LEN = 101;
const ASCII_TRIPLET_PRIMARY_RATIO = 0.5;
const GS1_FNC1_ASCII_CODE = 29;

function isValidAsciiTripletCode(code) {
  return Number.isInteger(code) && (code === GS1_FNC1_ASCII_CODE || (code >= 32 && code <= 126));
}

function looksLikeAsciiTripletEncoded(value) {
  const digitsOnly = String(value).replace(/\D/g, "");
  if (digitsOnly.length < ASCII_TRIPLET_MIN_LEN || digitsOnly.length % 3 !== 0) {
    return false;
  }
  if (!/^\d+$/.test(digitsOnly)) {
    return false;
  }

  const triplets = digitsOnly.match(/.{3}/g);
  if (!triplets) {
    return false;
  }

  let primaryPrefixCount = 0;
  for (const triplet of triplets) {
    const code = Number(triplet);
    if (!isValidAsciiTripletCode(code)) {
      return false;
    }
    if (triplet.startsWith("04") || triplet.startsWith("05")) {
      primaryPrefixCount++;
    }
  }

  return primaryPrefixCount / triplets.length >= ASCII_TRIPLET_PRIMARY_RATIO;
}

function decodeAsciiTripletScan(value) {
  const digitsOnly = String(value).replace(/\D/g, "");
  const triplets = digitsOnly.match(/.{3}/g) || [];
  return triplets.map((triplet) => String.fromCharCode(Number(triplet))).join("");
}

function looksLikeGs1DataMatrix(value) {
  const compact = value.replace(/[\s()\u001d]/g, "");
  return compact.length > 13 && compact.includes("01");
}

function extractGs1Gtin14(value) {
  const compact = value.replace(/[\s()\u001d]/g, "");
  let aiIndex = compact.indexOf("01");

  while (aiIndex !== -1) {
    const afterAi = compact.slice(aiIndex + 2);
    const digitsOnly = afterAi.replace(/\D/g, "");
    if (digitsOnly.length >= 14) {
      return digitsOnly.slice(0, 14);
    }
    aiIndex = compact.indexOf("01", aiIndex + 2);
  }

  return "";
}

function normalizeBarcodeInput(rawValue) {
  const sanitized = sanitizeBarcodeInput(rawValue);
  if (!sanitized) {
    return { ok: false, barcode: "", errorMessage: "Δεν λήφθηκαν δεδομένα barcode από το scanner.", debugInfo: "" };
  }

  let working = sanitized;
  if (looksLikeAsciiTripletEncoded(working)) {
    const decoded = decodeAsciiTripletScan(working);
    console.log(`[Scan] ASCII triplet decode: ${working.length} -> ${decoded.length} chars`);
    working = decoded;
  }

  const hasLetters = /\p{L}/u.test(working);
  const mapped = hasLetters ? mapGreekLayoutToDigits(working) : working;
  const digitsOnly = mapped.replace(/\D/g, "");

  if (looksLikeGs1DataMatrix(mapped)) {
    const gtin14 = extractGs1Gtin14(mapped);
    if (!/^\d{14}$/.test(gtin14)) {
      return { ok: false, barcode: digitsOnly, errorMessage: INVALID_SCAN_FORMAT_MESSAGE, debugInfo: "gtin14 extraction failed" };
    }
    if (gtin14.startsWith("0280")) {
      const eofCode13 = gtin14.slice(1);
      if (/^280\d{10}$/.test(eofCode13)) {
        return { ok: true, barcode: eofCode13 };
      }
    }
    const internationalCode = gtin14.startsWith("0") ? gtin14.slice(1) : gtin14;
    console.log(`[Scan] GS1 international GTIN: ${internationalCode}`);
    return { ok: true, barcode: internationalCode };
  }

  if (/^\d{13}$/.test(digitsOnly)) {
    return { ok: true, barcode: digitsOnly };
  }

  if (!/^\d+$/.test(digitsOnly) || digitsOnly.length < 8) {
    return { ok: false, barcode: digitsOnly, errorMessage: INVALID_SCAN_FORMAT_MESSAGE, debugInfo: `digits=${digitsOnly.length}` };
  }

  return { ok: true, barcode: digitsOnly };
}

function isNetworkErrorMessage(text) {
  const value = String(text ?? "").toLowerCase();
  return value.includes("network") || value.includes("timeout") || value.includes("fetch") ||
    value.includes("σφάλμα δικτύου") || value.includes("καθυστέρησε");
}

function setOrbState(state) {
  ORB_STATES.forEach((s) => orb.classList.remove(s));
  orb.classList.add(`state-${state}`);
}

function truncateForOrbDisplay(value, maxLen = 42) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function updateOrbScanDisplay(rawValue, status = "idle", normalizedValue = "") {
  if (!orbScanDisplay) return;

  orbScanDisplay.classList.remove("scan-ok", "scan-error", "scan-pending");

  const raw = String(rawValue ?? "").trim();
  const normalized = String(normalizedValue ?? "").trim();

  if (status === "pending") {
    orbScanDisplay.classList.add("scan-pending");
    orbScanDisplay.textContent = raw ? `SCAN: ${truncateForOrbDisplay(raw)}` : "Αναμονή scan…";
    orbScanDisplay.title = raw || "Αναμονή barcode από scanner";
    return;
  }

  if (status === "ok") {
    orbScanDisplay.classList.add("scan-ok");
    const shown = normalized || raw;
    orbScanDisplay.textContent = shown ? `✓ ${truncateForOrbDisplay(shown)}` : "—";
    orbScanDisplay.title = normalized && raw && normalized !== raw
      ? `Raw: ${raw}\nNormalized: ${normalized}`
      : shown;
    return;
  }

  if (status === "error") {
    orbScanDisplay.classList.add("scan-error");
    orbScanDisplay.textContent = raw
      ? `✗ ${truncateForOrbDisplay(raw)}`
      : "✗ Κενό scan";
    orbScanDisplay.title = normalized
      ? `Raw: ${raw || "(κενό)"}\nParsed: ${normalized}`
      : raw || "Δεν λήφθηκαν δεδομένα από scanner";
    return;
  }

  orbScanDisplay.textContent = raw ? truncateForOrbDisplay(raw) : "—";
  orbScanDisplay.title = raw || "Τελευταίο scan";
}

function updateOrbHookBuffer(payload = {}) {
  if (!orbHookBuffer) return;

  const buffer = String(payload.buffer ?? "");
  const length = Number.isFinite(payload.length) ? payload.length : buffer.length;
  const event = String(payload.event ?? "");

  if (event === "flush" || event === "timeout_clear") {
    lastHookBuffer = buffer;
  }

  orbHookBuffer.classList.remove("hook-live", "hook-flush", "hook-timeout");

  if (buffer) {
    orbHookBuffer.classList.add("hook-live");
    orbHookBuffer.textContent = `HOOK[${length}]: ${truncateForOrbDisplay(buffer, 36)}`;
    orbHookBuffer.title = buffer;
    return;
  }

  if (lastHookBuffer) {
    const lastLen = lastHookBuffer.length;
    if (event === "timeout_clear") {
      orbHookBuffer.classList.add("hook-timeout");
      orbHookBuffer.textContent = `TIMEOUT[${lastLen}]: ${truncateForOrbDisplay(lastHookBuffer, 32)}`;
      orbHookBuffer.title = `Buffer cleared by timeout (> threshold)\n${lastHookBuffer}`;
    } else {
      orbHookBuffer.classList.add("hook-flush");
      orbHookBuffer.textContent = `LAST[${lastLen}]: ${truncateForOrbDisplay(lastHookBuffer, 32)}`;
      orbHookBuffer.title = `Last hook buffer before Enter/Tab\n${lastHookBuffer}`;
    }
    return;
  }

  orbHookBuffer.textContent = "HOOK[0]: —";
  orbHookBuffer.title = "Live keyboard hook buffer (empty)";
}

function triggerFlash() {
  orb.classList.remove("flash-active");
  void orb.offsetWidth;
  orb.classList.add("flash-active");
  orb.addEventListener("animationend", () => orb.classList.remove("flash-active"), { once: true });
}

async function waitForLayout() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function resizeWindow(sizeKey) {
  const size = SIZES[sizeKey];

  if (sizeKey === "collapsed") {
    await WINDOW.setSize(new LogicalSize(size.width, size.height));
    return;
  }

  await waitForLayout();
  const layout = $("main-layout");
  const contentHeight = (layout?.scrollHeight ?? 0) + WINDOW_LAYOUT_PADDING_Y;
  const height = Math.max(size.height, contentHeight);
  await WINDOW.setSize(new LogicalSize(size.width, height));
}

async function writeClipboard(text) {
  try {
    const plugin = window.__TAURI__["clipboard-manager"];
    if (plugin && plugin.writeText) {
      await plugin.writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch (err) {
    console.warn("Clipboard write failed:", err);
  }
}

function hideManualEntryRow() {
  manualEntryRow.classList.add("hidden");
  manualNameInput.value = "";
  sidebarLookupDetail.classList.add("hidden");
  sidebarLookupDetail.textContent = "";
  pendingManualBarcode = "";
}

function showManualEntryRow(barcode, missReason = "") {
  pendingManualBarcode = barcode;
  manualEntryRow.classList.remove("hidden");
  manualNameInput.value = "";
  if (missReason) {
    sidebarLookupDetail.textContent = missReason;
    sidebarLookupDetail.classList.remove("hidden");
    sidebarLookupDetail.title = missReason;
  } else {
    sidebarLookupDetail.classList.add("hidden");
    sidebarLookupDetail.textContent = "";
  }
  setTimeout(() => manualNameInput.focus(), 100);
}

async function openSidebar() {
  drugSidebar.classList.remove("hidden");
  void drugSidebar.offsetWidth;
  drugSidebar.classList.add("visible");
  sidebarOpen = true;
  await resizeWindow("sidebar");
}

async function collapseSidebar() {
  drugSidebar.classList.remove("visible");
  drugSidebar.classList.add("hidden");
  sidebarOpen = false;
  scannedDrugs = [];
  activeDrugId = null;
  drugList.innerHTML = "";
  hideManualEntryRow();
  await resizeWindow("collapsed");
}

function createDrugEntry(lookupResult, barcode) {
  return {
    id: createDrugId(),
    barcode,
    found: lookupResult.found,
    productName: lookupResult.product_name || "",
    activeIngredient: lookupResult.active_ingredient || "",
    atcCode: lookupResult.atc_code || "",
    recommendation: null,
    errorMessage: null,
    status: "idle",
  };
}

function highlightDrugRow(drugId) {
  const el = drugList.querySelector(`[data-drug-id="${drugId}"]`);
  if (!el) return;
  el.classList.remove("highlight");
  void el.offsetWidth;
  el.classList.add("highlight");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function syncDrugItemElement(el, drug) {
  const btn = el.querySelector(".drug-name-btn");
  const recBlock = el.querySelector(".drug-recommendation");
  const recText = el.querySelector(".recommendation-text");

  btn.textContent = shortDisplayName(drug.productName || drug.barcode);
  btn.title = drug.productName || drug.barcode;
  btn.disabled = processing && drug.status === "loading";
  btn.classList.toggle("active", drug.id === activeDrugId);
  btn.classList.toggle("loading", drug.status === "loading");

  const isActive = drug.id === activeDrugId;

  if (drug.status === "loading") {
    recBlock.classList.remove("hidden", "error");
    recText.textContent = "Αναμονή πρότασης…";
  } else if (isActive && drug.status === "done" && drug.recommendation) {
    recBlock.classList.remove("hidden", "error");
    recText.textContent = drug.recommendation;
  } else if (isActive && drug.status === "error" && drug.errorMessage) {
    recBlock.classList.remove("hidden");
    recBlock.classList.add("error");
    recText.textContent = drug.errorMessage;
  } else {
    recBlock.classList.add("hidden");
    recBlock.classList.remove("error");
    recText.textContent = "";
  }
}

function collapseDrugRecommendation(drugId) {
  if (activeDrugId !== drugId) return;
  activeDrugId = null;
  renderDrugList();
  resizeWindow("sidebar");
}

let pendingClickTimer = null;
let lastClickDrugId = null;
let lastClickTime = 0;
const DOUBLE_CLICK_MS = 350;

function handleDrugNameClick(drugId) {
  const now = Date.now();
  const isDouble = drugId === lastClickDrugId && now - lastClickTime < DOUBLE_CLICK_MS;

  if (isDouble) {
    if (pendingClickTimer) {
      clearTimeout(pendingClickTimer);
      pendingClickTimer = null;
    }
    lastClickDrugId = null;
    lastClickTime = 0;
    collapseDrugRecommendation(drugId);
    return;
  }

  lastClickDrugId = drugId;
  lastClickTime = now;

  if (pendingClickTimer) clearTimeout(pendingClickTimer);
  pendingClickTimer = setTimeout(() => {
    pendingClickTimer = null;
    requestRecommendation(drugId);
  }, DOUBLE_CLICK_MS);
}

function createDrugItemElement(drug) {
  const item = document.createElement("div");
  item.className = "drug-item";
  item.dataset.drugId = drug.id;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "drug-name-btn";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleDrugNameClick(drug.id);
  });

  const recBlock = document.createElement("div");
  recBlock.className = "drug-recommendation hidden";

  const recText = document.createElement("p");
  recText.className = "recommendation-text";
  recBlock.appendChild(recText);

  item.appendChild(btn);
  item.appendChild(recBlock);
  syncDrugItemElement(item, drug);
  return item;
}

function renderDrugList() {
  drugList.innerHTML = "";
  for (const drug of scannedDrugs) {
    drugList.appendChild(createDrugItemElement(drug));
  }
}

function appendDrug(drug) {
  scannedDrugs.push(drug);
  renderDrugList();
  const el = drugList.querySelector(`[data-drug-id="${drug.id}"]`);
  el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function applyCachedDrugClick(drug) {
  activeDrugId = drug.id;
  renderDrugList();
  if (drug.recommendation) {
    writeClipboard(drug.recommendation);
  }
}

async function handleLookupResult(lookupResult, barcode) {
  hideManualEntryRow();

  const existing = findDrugByBarcode(barcode);
  if (existing) {
    highlightDrugRow(existing.id);
    setOrbState("success");
    triggerFlash();
    setTimeout(() => setOrbState("idle"), 400);
    if (!sidebarOpen) await openSidebar();
    else await resizeWindow("sidebar");
    return;
  }

  if (lookupResult.found) {
    const drug = createDrugEntry(lookupResult, barcode);
    appendDrug(drug);
    if (!sidebarOpen) await openSidebar();
    else await resizeWindow("sidebar");
    setOrbState("success");
    triggerFlash();
    setTimeout(() => setOrbState("idle"), 400);
    return;
  }

  if (!sidebarOpen) await openSidebar();
  showManualEntryRow(barcode, lookupResult.miss_reason || "");
  await resizeWindow("sidebar");
  setOrbState("idle");
}

function addManualDrugFromInput() {
  const name = manualNameInput.value.trim();
  if (!name) {
    manualNameInput.focus();
    return null;
  }

  const barcode = pendingManualBarcode || lastAcceptedBarcode || MANUAL_ENTRY_BARCODE;
  const existing = scannedDrugs.find(
    (d) => d.barcode === barcode && d.productName.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    hideManualEntryRow();
    highlightDrugRow(existing.id);
    return existing;
  }

  const drug = {
    id: createDrugId(),
    barcode,
    found: false,
    productName: name,
    activeIngredient: "",
    atcCode: "",
    recommendation: null,
    errorMessage: null,
    status: "idle",
  };
  appendDrug(drug);
  hideManualEntryRow();
  return drug;
}

async function openManualEntry() {
  if (processing) return;

  if (sidebarOpen && !manualEntryRow.classList.contains("hidden")) {
    manualNameInput.focus();
    return;
  }

  if (!sidebarOpen) {
    await openSidebar();
  }

  showManualEntryRow(lastAcceptedBarcode || MANUAL_ENTRY_BARCODE, "");
  await resizeWindow("sidebar");
}

async function showScanError(errorMessage) {
  setOrbState("error");
  triggerFlash();
  setTimeout(() => setOrbState("idle"), 650);
  console.error("[Scan] Error:", errorMessage);
}

async function requestRecommendation(drugId) {
  if (processing) return;

  const drug = findDrugById(drugId);
  if (!drug) return;

  activeDrugId = drugId;

  if (drug.status === "done" && drug.recommendation) {
    applyCachedDrugClick(drug);
    return;
  }

  if (drug.status === "error" && drug.errorMessage) {
    renderDrugList();
    return;
  }

  processing = true;
  drug.status = "loading";
  renderDrugList();
  setOrbState("thinking");

  console.log(`[Recommend] barcode=${drug.barcode} product_name="${drug.productName}"`);

  try {
    let timeoutId;
    const result = await Promise.race([
      invoke("get_recommendation", {
        barcode: drug.barcode,
        productName: drug.productName || null,
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Η αναζήτηση καθυστέρησε ή μπλοκαρίστηκε από το δίκτυο."));
        }, RECOMMENDATION_TIMEOUT_MS);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    if (result?.success) {
      drug.recommendation = result.recommendation || "";
      drug.errorMessage = null;
      drug.status = "done";
      if (result.product_name && !drug.productName) {
        drug.productName = result.product_name;
      }
      await writeClipboard(drug.recommendation);
      setOrbState("success");
      triggerFlash();
      setTimeout(() => setOrbState("idle"), 400);
    } else {
      const msg = result?.error_message || result?.message || PRODUCT_NOT_FOUND_MESSAGE;
      drug.errorMessage = result?.raw_response || msg;
      drug.recommendation = null;
      drug.status = "error";
      setOrbState("error");
      triggerFlash();
      setTimeout(() => setOrbState("idle"), 650);
    }
  } catch (err) {
    console.error("[Recommend] Exception:", err);
    const errText = String(err ?? "");
    const message = isNetworkErrorMessage(errText) ? NETWORK_ERROR_MESSAGE : errText || NETWORK_ERROR_MESSAGE;
    drug.errorMessage = message;
    drug.recommendation = null;
    drug.status = "error";
    setOrbState("error");
    triggerFlash();
    setTimeout(() => setOrbState("idle"), 650);
  } finally {
    processing = false;
    renderDrugList();
    await resizeWindow("sidebar");
  }
}

async function processBarcode(rawBarcode) {
  if (lookupInFlight) return;

  updateOrbScanDisplay(rawBarcode, "pending");

  const normalized = normalizeBarcodeInput(rawBarcode);
  if (!normalized.ok) {
    console.log("[Scan] Rejected:", normalized);
    updateOrbScanDisplay(rawBarcode, "error", normalized.barcode || normalized.debugInfo);
    await showScanError(normalized.errorMessage);
    return;
  }

  const barcode = normalized.barcode;
  lastAcceptedBarcode = barcode;
  updateOrbScanDisplay(rawBarcode, "ok", barcode);
  console.log(`[Scan] Accepted: ${barcode}`);

  lookupInFlight = true;
  try {
    setOrbState("thinking");

    const lookupResult = await invoke("lookup_barcode", { barcode });
    console.log("[Lookup] Result:", lookupResult);
    if (!lookupResult.found) {
      console.log("[Lookup] Miss reason:", lookupResult.miss_reason || "(none)");
    }
    await handleLookupResult(lookupResult, barcode);
  } catch (err) {
    console.error("[Lookup] Exception:", err);
    await showScanError(String(err));
  } finally {
    lookupInFlight = false;
  }
}

function setupDrag() {
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest("#sidebar-close-btn")) return;
    if (target.closest("#profile-badge")) return;
    if (target.closest(".orb-chrome-btn")) return;
    if (target.closest("#scan-fallback")) return;
    if (target.closest("#manual-name-input")) return;
    if (target.closest(".drug-name-btn")) return;
    if (target.closest(".drug-recommendation")) return;
    if (target.closest(".drug-list")) return;

    if (target.closest("[data-drag-region]")) {
      e.preventDefault();
      WINDOW.startDragging();
    }
  });
}

function setupPanelControls() {
  $("sidebar-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    collapseSidebar();
  });

  manualNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const drug = addManualDrugFromInput();
      if (drug) {
        resizeWindow("sidebar").then(() => requestRecommendation(drug.id));
      }
    }
  });
}

function setupWindowChrome() {
  $("orb-manual-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    openManualEntry();
  });

  $("orb-minimize-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    WINDOW.minimize();
  });

  $("orb-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    WINDOW.close();
  });
}

function setupProfileBadge() {
  // UI hidden — re-enable with #profile-badge in index.html
  // profileBadge.addEventListener("click", async (e) => {
  //   e.stopPropagation();
  //   const name = await invoke("toggle_profile");
  //   updateProfileBadge(name);
  // });
}

function updateProfileBadge(name) {
  if (!profileBadge) return;
  profileBadge.textContent = name;
  profileBadge.classList.toggle("prod", name === "PROD");
}

function setupScanFallback() {
  scanFallback.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const value = scanFallback.value;
      scanFallback.value = "";
      processBarcode(value);
    }
  });
}

async function init() {
  console.log("[pharmaBuddy] Initializing...");

  setupDrag();
  setupWindowChrome();
  setupPanelControls();
  setupProfileBadge();
  setupScanFallback();

  // Profile badge hidden — default profile is PROD (env_config.rs)
  // const profile = await invoke("get_profile");
  // updateProfileBadge(profile);

  await listen("barcode-scanned", (event) => {
    console.log("[Hook] barcode-scanned event:", event.payload);
    processBarcode(event.payload);
  });

  await listen("scan-attempt", (event) => {
    const payload = event.payload || {};
    console.log("[Hook] scan-attempt:", payload);
    if (payload.accepted === false) {
      // updateOrbScanDisplay(payload.raw || "", "error", payload.reason || "");
    }
  });

  // Debug: hook-buffer UI hidden — re-enable with #orb-hook-buffer in index.html
  // await listen("hook-buffer", (event) => {
  //   console.log("[Hook] hook-buffer:", event.payload);
  //   updateOrbHookBuffer(event.payload || {});
  // });

  setOrbState("idle");
  await resizeWindow("collapsed");

  console.log("[pharmaBuddy] Widget ready");
}

init();
