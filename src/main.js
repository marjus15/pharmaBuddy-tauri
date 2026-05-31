const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const WINDOW = getCurrentWindow();

const SIZES = {
  collapsed: { width: 250, height: 245 },
  success: { width: 368, height: 520 },
  error: { width: 368, height: 400 },
};

const ORB_STATES = ["state-idle", "state-thinking", "state-success", "state-error"];

const $ = (id) => document.getElementById(id);

const orb = $("orb");
const responsePanel = $("response-panel");
const statusMessage = $("status-message");
const productName = $("product-name");
const recommendationText = $("recommendation-text");
const barcodeDisplay = $("barcode-display");
const profileBadge = $("profile-badge");
const scanFallback = $("scan-fallback");

let currentRecommendation = "";
let panelOpen = false;
let processing = false;

const RECOMMENDATION_TIMEOUT_MS = 12000;

// Defensive defaults for keyboard-layout misreads (Greek/Latin lookalikes).
// Keep override map editable for scanner-specific character pairs.
const GREEK_LAYOUT_DIGIT_MAP_DEFAULT = Object.freeze({
  c: "0",
  C: "0",
  o: "0",
  O: "0",
  "ο": "0",
  "Ο": "0",
  g: "6",
  G: "6",
  b: "8",
  B: "8",
  q: "1",
  Q: "1",
  l: "1",
  L: "1",
  I: "1",
  i: "1",
  z: "2",
  Z: "2",
  e: "3",
  E: "3",
  a: "4",
  A: "4",
  s: "5",
  S: "5",
  t: "7",
  T: "7",
  y: "9",
  Y: "9",
});

const GREEK_LAYOUT_DIGIT_MAP_OVERRIDE = Object.freeze({
  // Example:
  // "x": "3",
});

const GREEK_LAYOUT_DIGIT_MAP = Object.freeze({
  ...GREEK_LAYOUT_DIGIT_MAP_DEFAULT,
  ...GREEK_LAYOUT_DIGIT_MAP_OVERRIDE,
});

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
    .trim();
}

function mapGreekLayoutToDigits(value) {
  return Array.from(value).map((char) => GREEK_LAYOUT_DIGIT_MAP[char] ?? char).join("");
}

function extractNationalCodeFromGs1(value) {
  const compact = value.replace(/[\s()]/g, "");
  if (compact.length <= 13 || !compact.includes("01")) return null;

  let aiIndex = compact.indexOf("01");
  while (aiIndex !== -1) {
    const afterAi = compact.slice(aiIndex + 2);
    const digitsOnly = afterAi.replace(/\D/g, "");
    if (digitsOnly.length >= 14) {
      const gtin14 = digitsOnly.slice(0, 14);
      // National/EAN code: remove packaging indicator digit from GTIN-14.
      return gtin14.slice(1);
    }
    aiIndex = compact.indexOf("01", aiIndex + 2);
  }

  return null;
}

function normalizeBarcodeInput(rawValue) {
  const sanitized = sanitizeBarcodeInput(rawValue);
  if (!sanitized) {
    return {
      ok: false,
      barcode: "",
      errorMessage: "Δεν λήφθηκαν δεδομένα barcode από το scanner.",
      debugInfo: "",
    };
  }

  const mapped = mapGreekLayoutToDigits(sanitized);
  const gs1Barcode = extractNationalCodeFromGs1(mapped);
  const candidate = (gs1Barcode || mapped).replace(/\D/g, "");

  if (!/^\d{13}$/.test(candidate)) {
    return {
      ok: false,
      barcode: candidate,
      errorMessage: "Μη έγκυρο barcode μετά τον καθαρισμό. Απαιτούνται 13 ψηφία.",
      debugInfo: `raw="${rawValue ?? ""}" | cleaned="${mapped}" | digits="${candidate}"`,
    };
  }

  return {
    ok: true,
    barcode: candidate,
  };
}

async function invokeRecommendationWithTimeout(barcode) {
  let timeoutId;
  try {
    return await Promise.race([
      invoke("get_recommendation", { barcode }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Η αναζήτηση καθυστέρησε ή μπλοκαρίστηκε από το δίκτυο."));
        }, RECOMMENDATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function setOrbState(state) {
  ORB_STATES.forEach((s) => orb.classList.remove(s));
  orb.classList.add(`state-${state}`);
}

function triggerFlash() {
  orb.classList.remove("flash-active");
  void orb.offsetWidth;
  orb.classList.add("flash-active");
  orb.addEventListener(
    "animationend",
    () => orb.classList.remove("flash-active"),
    { once: true }
  );
}

async function resizeWindow(sizeKey) {
  const size = SIZES[sizeKey];
  await WINDOW.setSize(new LogicalSize(size.width, size.height));
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

async function showPanel(mode, data) {
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
    statusMessage.textContent =
      profile === "TEST" ? "Ολοκληρώθηκε (TEST)" : "Ολοκληρώθηκε";
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

async function setThinking() {
  if (panelOpen) {
    await collapsePanel();
  }
  setOrbState("thinking");
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

async function processBarcode(rawBarcode) {
  if (processing) return;

  const normalized = normalizeBarcodeInput(rawBarcode);
  if (!normalized.ok) {
    console.log("[Scan] Rejected:", normalized);
    await handleError(normalized.barcode, buildUiError(normalized.errorMessage, normalized.debugInfo));
    return;
  }

  const barcode = normalized.barcode;
  processing = true;
  console.log(`[Scan] Accepted: ${barcode}`);

  try {
    await setThinking();
    const result = await invokeRecommendationWithTimeout(barcode);

    if (result?.success) {
      await handleSuccess(barcode, result);
    } else {
      await handleError(
        barcode,
        buildUiError(
          result?.error_message || result?.message || "Το προϊόν δεν βρέθηκε.",
          result?.raw_response || result?.rawResponse || ""
        )
      );
    }
  } catch (err) {
    console.error("[Scan] Exception:", err);
    await handleError(barcode, buildUiError(String(err), "Ελέγξτε σύνδεση, firewall ή πρόσβαση στο Supabase."));
  } finally {
    processing = false;
  }
}

function setupDrag() {
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;

    const target = e.target;
    if (target.closest("#close-panel-btn")) return;
    if (target.closest("#copy-btn")) return;
    if (target.closest("#profile-badge")) return;
    if (target.closest(".orb-chrome-btn")) return;
    if (target.closest("#recommendation-scroll")) return;
    if (target.closest("#scan-fallback")) return;

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

  $("copy-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentRecommendation) return;
    await writeClipboard(currentRecommendation);
    statusMessage.textContent = "Αντιγράφηκε στο πρόχειρο";
  });
}

function setupWindowChrome() {
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

  setOrbState("idle");
  await resizeWindow("collapsed");

  console.log("[pharmaBuddy] Widget ready");
}

init();
