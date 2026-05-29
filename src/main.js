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
  // Strip scanner suffixes (\r, \n) and any other surrounding whitespace.
  const barcode = String(rawBarcode ?? "").trim();
  if (processing) return;

  if (!barcode || barcode.length !== 13) {
    console.log(`[Scan] Rejected: length=${barcode?.length}`);
    setOrbState("error");
    triggerFlash();
    setTimeout(() => setOrbState("idle"), 650);
    return;
  }

  processing = true;
  console.log(`[Scan] Accepted: ${barcode}`);

  try {
    await setThinking();
    const result = await invoke("get_recommendation", { barcode });

    if (result.success) {
      await handleSuccess(barcode, result);
    } else {
      await handleError(barcode, result);
    }
  } catch (err) {
    console.error("[Scan] Exception:", err);
    await handleError(barcode, {
      error_message: String(err),
      raw_response: "",
      success: false,
    });
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
