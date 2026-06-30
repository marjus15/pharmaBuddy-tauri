const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const WINDOW = getCurrentWindow();

const SIZES = {
  collapsed: { width: 250, height: 288 },
  preview: { width: 368, height: 520 },
  success: { width: 368, height: 520 },
  error: { width: 368, height: 480 },
};

const WINDOW_LAYOUT_PADDING_Y = 20;

const ORB_STATES = ["state-idle", "state-thinking", "state-success", "state-error"];

const $ = (id) => document.getElementById(id);

const orb = $("orb");
const previewPanel = $("preview-panel");
const previewStatus = $("preview-status");
const previewProductName = $("preview-product-name");
const previewBarcode = $("preview-barcode");
const manualNameInput = $("manual-name-input");
const previewLookupDetail = $("preview-lookup-detail");
const recommendBtn = $("recommend-btn");

const responsePanel = $("response-panel");
const statusMessage = $("status-message");
const productName = $("product-name");
const recommendationText = $("recommendation-text");
const barcodeDisplay = $("barcode-display");
const profileBadge = $("profile-badge");
const scanFallback = $("scan-fallback");
const orbScanDisplay = $("orb-scan-display");
const orbHookBuffer = $("orb-hook-buffer");

let lastHookBuffer = "";
let lastAcceptedBarcode = "";

const MANUAL_ENTRY_BARCODE = "manual-entry";

let currentRecommendation = "";
let panelOpen = false;
let previewOpen = false;
let processing = false;

let pendingLookup = null;

const RECOMMENDATION_TIMEOUT_MS = 35000;

// Defensive defaults for keyboard-layout misreads (Greek/Latin lookalikes).
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

const INVALID_SCAN_FORMAT_MESSAGE =
  "Μη έγκυρη μορφή barcode.";
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
      return { ok: false, barcode: digitsOnly, errorMessage: INVALID_SCAN_FORMAT_MESSAGE, debugInfo: `gtin14 extraction failed` };
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

// ── Step 1: Preview panel (show product name or manual input) ──

async function showPreview(lookupResult, barcode) {
  responsePanel.classList.remove("visible");
  responsePanel.classList.add("hidden");
  panelOpen = false;

  previewPanel.classList.remove("hidden", "error-border", "visible");
  void previewPanel.offsetWidth;

  if (lookupResult.found) {
    previewStatus.textContent = "Βρέθηκε";
    previewProductName.textContent = lookupResult.product_name || "";
    previewProductName.classList.remove("hidden");
    manualNameInput.classList.add("hidden");
    manualNameInput.value = "";
    previewLookupDetail.classList.add("hidden");
    previewLookupDetail.textContent = "";
  } else {
    previewStatus.textContent = "Δεν βρέθηκε — πληκτρολογήστε όνομα";
    previewProductName.textContent = "";
    previewProductName.classList.add("hidden");
    manualNameInput.classList.remove("hidden");
    manualNameInput.value = "";
    if (lookupResult.miss_reason) {
      previewLookupDetail.textContent = lookupResult.miss_reason;
      previewLookupDetail.classList.remove("hidden");
      previewLookupDetail.title = lookupResult.miss_reason;
    } else {
      previewLookupDetail.classList.add("hidden");
      previewLookupDetail.textContent = "";
    }
    setTimeout(() => manualNameInput.focus(), 100);
  }

  previewBarcode.textContent = barcode;
  previewPanel.classList.add("visible");
  previewOpen = true;

  pendingLookup = {
    barcode,
    found: lookupResult.found,
    productName: lookupResult.product_name || "",
    activeIngredient: lookupResult.active_ingredient || "",
    atcCode: lookupResult.atc_code || "",
  };

  await resizeWindow("preview");
  setOrbState(lookupResult.found ? "success" : "idle");
  triggerFlash();
  setTimeout(() => setOrbState("idle"), 400);
}

async function collapsePreview() {
  previewPanel.classList.remove("visible");
  previewPanel.classList.add("hidden");
  previewOpen = false;
  pendingLookup = null;
  await resizeWindow("collapsed");
}

async function openManualEntry() {
  if (processing) return;

  if (previewOpen && pendingLookup && !pendingLookup.found) {
    manualNameInput.focus();
    return;
  }

  if (panelOpen) await collapsePanel();
  if (previewOpen) await collapsePreview();

  const barcode = lastAcceptedBarcode || MANUAL_ENTRY_BARCODE;
  await showPreview(
    { found: false, product_name: null, active_ingredient: null, atc_code: null },
    barcode,
  );
  previewStatus.textContent = "Πληκτρολογήστε όνομα φαρμάκου";
  previewLookupDetail.classList.add("hidden");
  previewLookupDetail.textContent = "";
  if (!lastAcceptedBarcode) {
    previewBarcode.textContent = "—";
  }
}

// ── Step 2: Recommendation panel ──

async function showPanel(mode, data) {
  previewPanel.classList.remove("visible");
  previewPanel.classList.add("hidden");
  previewOpen = false;

  responsePanel.classList.remove("hidden", "error-border", "visible");
  void responsePanel.offsetWidth;
  responsePanel.classList.add("visible");

  if (mode === "error") {
    responsePanel.classList.add("error-border");
    statusMessage.textContent = data.errorMessage || "Σφάλμα";
    productName.textContent = "Σφάλμα αναζήτησης";
    recommendationText.textContent = data.rawResponse || data.errorMessage || "";
  } else {
    responsePanel.classList.remove("error-border");
    const profile = await invoke("get_profile");
    statusMessage.textContent = profile === "TEST" ? "Ολοκληρώθηκε (TEST)" : "Ολοκληρώθηκε";
    productName.textContent = data.productName || "";
    recommendationText.textContent = data.recommendation || "";
  }

  barcodeDisplay.textContent = data.barcode || "";
  panelOpen = true;
}

async function collapsePanel() {
  responsePanel.classList.remove("visible");
  responsePanel.classList.add("hidden");
  panelOpen = false;
  await resizeWindow("collapsed");
}

async function handleSuccess(barcode, result) {
  currentRecommendation = result.recommendation || "";
  await writeClipboard(currentRecommendation);

  setOrbState("success");
  triggerFlash();

  await resizeWindow("success");
  await showPanel("success", {
    barcode,
    productName: result.product_name,
    recommendation: result.recommendation,
  });

  setTimeout(() => setOrbState("idle"), 400);
}

async function handleError(barcode, result) {
  setOrbState("error");
  triggerFlash();

  await resizeWindow("error");
  await showPanel("error", {
    barcode,
    errorMessage: result.error_message || "Σφάλμα",
    rawResponse: result.raw_response || "",
  });

  setTimeout(() => setOrbState("idle"), 650);
}

// ── Phase 1: Scan → Lookup → Preview ──

async function processBarcode(rawBarcode) {
  if (processing) return;

  updateOrbScanDisplay(rawBarcode, "pending");

  const normalized = normalizeBarcodeInput(rawBarcode);
  if (!normalized.ok) {
    console.log("[Scan] Rejected:", normalized);
    updateOrbScanDisplay(rawBarcode, "error", normalized.barcode || normalized.debugInfo);
    await handleError(normalized.barcode, buildUiError(normalized.errorMessage, normalized.debugInfo));
    return;
  }

  const barcode = normalized.barcode;
  lastAcceptedBarcode = barcode;
  updateOrbScanDisplay(rawBarcode, "ok", barcode);
  console.log(`[Scan] Accepted: ${barcode}`);

  try {
    if (previewOpen) await collapsePreview();
    if (panelOpen) await collapsePanel();

    setOrbState("thinking");

    const lookupResult = await invoke("lookup_barcode", { barcode });
    console.log("[Lookup] Result:", lookupResult);
    if (!lookupResult.found) {
      console.log("[Lookup] Miss reason:", lookupResult.miss_reason || "(none)");
    }
    await showPreview(lookupResult, barcode);
  } catch (err) {
    console.error("[Lookup] Exception:", err);
    await handleError(barcode, buildUiError(String(err)));
  }
}

// ── Phase 2: Click "Πρόταση" → AI Recommendation ──

async function requestRecommendation() {
  if (processing || !pendingLookup) return;

  const { barcode, found } = pendingLookup;
  let finalProductName = pendingLookup.productName;

  if (!found) {
    finalProductName = manualNameInput.value.trim();
    if (!finalProductName) {
      manualNameInput.focus();
      return;
    }
  }

  processing = true;
  console.log(`[Recommend] barcode=${barcode} product_name="${finalProductName}"`);

  try {
    previewPanel.classList.remove("visible");
    previewPanel.classList.add("hidden");
    previewOpen = false;

    setOrbState("thinking");
    await resizeWindow("collapsed");

    let timeoutId;
    const result = await Promise.race([
      invoke("get_recommendation", {
        barcode,
        productName: finalProductName || null,
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Η αναζήτηση καθυστέρησε ή μπλοκαρίστηκε από το δίκτυο."));
        }, RECOMMENDATION_TIMEOUT_MS);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    if (result?.success) {
      await handleSuccess(barcode, result);
    } else {
      const msg = result?.error_message || result?.message || PRODUCT_NOT_FOUND_MESSAGE;
      await handleError(barcode, buildUiError(msg, result?.raw_response || ""));
    }
  } catch (err) {
    console.error("[Recommend] Exception:", err);
    const errText = String(err ?? "");
    const message = isNetworkErrorMessage(errText) ? NETWORK_ERROR_MESSAGE : errText || NETWORK_ERROR_MESSAGE;
    await handleError(barcode, buildUiError(message, "Ελέγξτε σύνδεση, firewall ή πρόσβαση στο Supabase."));
  } finally {
    processing = false;
    pendingLookup = null;
  }
}

// ── Setup ──

function setupDrag() {
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest("#close-panel-btn")) return;
    if (target.closest("#preview-close-btn")) return;
    if (target.closest("#copy-btn")) return;
    if (target.closest("#recommend-btn")) return;
    if (target.closest("#profile-badge")) return;
    if (target.closest(".orb-chrome-btn")) return;
    if (target.closest("#recommendation-scroll")) return;
    if (target.closest("#scan-fallback")) return;
    if (target.closest("#manual-name-input")) return;

    if (target.closest("[data-drag-region]")) {
      e.preventDefault();
      WINDOW.startDragging();
    }
  });
}

function setupPanelControls() {
  $("close-panel-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    collapsePanel();
  });

  $("preview-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    collapsePreview();
  });

  $("copy-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentRecommendation) return;
    await writeClipboard(currentRecommendation);
    statusMessage.textContent = "Αντιγράφηκε στο πρόχειρο";
  });

  recommendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestRecommendation();
  });

  manualNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      requestRecommendation();
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
  profileBadge.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = await invoke("toggle_profile");
    updateProfileBadge(name);
  });
}

function updateProfileBadge(name) {
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

  const profile = await invoke("get_profile");
  updateProfileBadge(profile);

  await listen("barcode-scanned", (event) => {
    console.log("[Hook] barcode-scanned event:", event.payload);
    processBarcode(event.payload);
  });

  await listen("scan-attempt", (event) => {
    const payload = event.payload || {};
    console.log("[Hook] scan-attempt:", payload);
    if (payload.accepted === false) {
      updateOrbScanDisplay(payload.raw || "", "error", payload.reason || "");
    }
  });

  await listen("hook-buffer", (event) => {
    console.log("[Hook] hook-buffer:", event.payload);
    updateOrbHookBuffer(event.payload || {});
  });

  setOrbState("idle");
  await resizeWindow("collapsed");

  console.log("[pharmaBuddy] Widget ready");
}

init();
