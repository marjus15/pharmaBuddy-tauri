import {
  INACTIVE_PHARMACY_MESSAGE,
  OFFLINE_MESSAGE,
  SIDE_EFFECTS_TRUST_LINE,
  UNASSIGNED_PHARMACY_MESSAGE,
  UPDATE_NOTE,
  reduceUpdateUi,
  reportStatusFor,
  visibleRecommendation,
  visibleSideEffects,
} from "./widget-logic.mjs";

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke
  ? tauri.core.invoke.bind(tauri.core)
  : async () => {
      throw new Error("Tauri API unavailable");
    };
const listen = tauri?.event?.listen
  ? tauri.event.listen.bind(tauri.event)
  : async () => () => {};
const LogicalSize = tauri?.window?.LogicalSize;
const WINDOW = tauri?.window?.getCurrentWindow ? tauri.window.getCurrentWindow() : null;

// Sidebar column is 360px (CSS max 400). Width stays fixed so long names wrap
// inside the column instead of pushing the window: padding 24 + sidebar 360 + gap 14 + orb 250.
const SIDEBAR_WINDOW_MAX_WIDTH = 688;
const SIZES = {
  collapsed: { width: 250, height: 288 },
  collapsedNote: { width: 336, height: 324 },
  login: { width: 300, height: 400 },
  sidebar: { width: 648, height: 320 },
  report: { width: 340, height: 460 },
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
const activationOverlay = $("activation-overlay");
const activationKeyInput = $("activation-key-input");
const activationSubmitBtn = $("activation-submit-btn");
const activationError = $("activation-error");
const activationDesc = $("activation-desc");
const orbPharmacyName = $("orb-pharmacy-name");
const loginOverlay = $("login-overlay");
const loginForm = $("login-form");
const loginIdentifier = $("login-identifier");
const loginPassword = $("login-password");
const loginPasswordToggle = $("login-password-toggle");
const loginError = $("login-error");
const loginSubmit = $("login-submit");
const settingsButton = $("orb-settings-btn");
const settingsMenu = $("settings-menu");
const settingsPharmacy = $("settings-pharmacy");
const settingsEmail = $("settings-email");
const logoutButton = $("logout-btn");
const settingsLogoutSep = $("settings-logout-sep");
const logoutConfirm = $("logout-confirm");
const logoutCancel = $("logout-cancel");
const logoutConfirmButton = $("logout-confirm-btn");
const reportMenuButton = $("report-menu-btn");
const orbDock = document.querySelector(".orb-dock");
const reportOverlay = $("report-overlay");
const reportForm = $("report-form");
const reportMessage = $("report-message");
const reportStatus = $("report-status");
const reportSend = $("report-send");
const reportClose = $("report-close");
const updateNote = $("update-note");

let lastHookBuffer = "";
let lastAcceptedBarcode = "";
let pendingManualBarcode = "";

let pharmacyActivated = false;
let pharmacyLicenseValid = false;
let activationMode = "activate";
let authMode = "legacy";
let scansEnabled = false;

const BAD_CREDENTIALS_MESSAGE = "Λάθος στοιχεία";
const REPORT_EXAMPLE =
  "Σκάναρα το ίδιο κουτί δύο φορές και έβγαλε ότι το προϊόν δεν υπάρχει. Ο κωδικός στο κουτί φαίνεται σωστός.";

const MANUAL_ENTRY_BARCODE = "manual-entry";

/** @type {Array<{id:string,barcode:string,found:boolean,productName:string,activeIngredient:string,atcCode:string,sideEffects:string|null,sideEffectsStatus:string,recommendation:string|null,errorMessage:string|null,status:string}>} */
let scannedDrugs = [];
let activeDrugId = null;
let sidebarOpen = false;
let processing = false;
let lookupInFlight = false;

const RECOMMENDATION_TIMEOUT_MS = 35000;
const sideEffectLoads = new Map();

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
const PRODUCT_NOT_FOUND_MESSAGE =
  "Το προϊόν δεν βρέθηκε στον κατάλογο. Σκανάρετε ξανά ή πληκτρολογήστε τον κωδικό.";
const LOOKUP_NO_RESULTS_MESSAGE = "Δεν βρέθηκαν αποτελέσματα.";
const LICENSE_INACTIVE_MESSAGE =
  "Η άδεια χρήσης δεν είναι ενεργή. Επικοινωνήστε μαζί μας.";
const LICENSE_RECONNECT_MESSAGE =
  "Απαιτείται σύνδεση στο διαδίκτυο για επαλήθευση της άδειας.";

function showLoginError(message) {
  if (!loginError) return;
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function clearLoginError() {
  if (!loginError) return;
  loginError.textContent = "";
  loginError.classList.add("hidden");
}

function showLoginOverlay() {
  if (!loginOverlay) return;
  loginOverlay.classList.remove("hidden");
  loginOverlay.setAttribute("aria-hidden", "false");
  if (WINDOW && LogicalSize) {
    WINDOW.setSize(new LogicalSize(SIZES.login.width, SIZES.login.height)).catch(() => {});
  }
}

function hideLoginOverlay() {
  if (!loginOverlay) return;
  loginOverlay.classList.add("hidden");
  loginOverlay.setAttribute("aria-hidden", "true");
  clearLoginError();
  if (loginPassword) loginPassword.value = "";
  if (loginPassword) loginPassword.type = "password";
  loginPasswordToggle?.classList.remove("is-visible");
  loginPasswordToggle?.setAttribute("aria-pressed", "false");
  loginPasswordToggle?.setAttribute("aria-label", "Εμφάνιση κωδικού");
}

function setSettingsVisible(visible, { logout = false } = {}) {
  settingsButton?.classList.toggle("hidden", !visible);
  logoutButton?.classList.toggle("hidden", !logout);
  settingsLogoutSep?.classList.toggle("hidden", !logout);
  if (!visible) closeSettingsMenu();
}

function setSettingsDetails(gate) {
  if (settingsPharmacy) settingsPharmacy.textContent = gate?.pharmacy_name || "";
  if (settingsEmail) settingsEmail.textContent = gate?.email || "";
}

function closeSettingsMenu() {
  settingsMenu?.classList.add("hidden");
  settingsButton?.setAttribute("aria-expanded", "false");
}

function openSettingsMenu() {
  settingsMenu?.classList.remove("hidden");
  settingsButton?.setAttribute("aria-expanded", "true");
}

function applyAuthGate(gate) {
  authMode = gate?.mode || "legacy";
  if (authMode === "test") {
    scansEnabled = true;
    hideLoginOverlay();
    hideActivationOverlay();
    updatePharmacyFooter(null);
    setSettingsDetails({});
    setSettingsVisible(true, { logout: false });
    return;
  }
  if (authMode === "legacy") {
    scansEnabled = false;
    hideLoginOverlay();
    setSettingsVisible(false);
    return;
  }

  hideActivationOverlay();
  if (loginIdentifier && gate?.remembered_username && !loginIdentifier.value) {
    loginIdentifier.value = gate.remembered_username;
  }
  if (gate?.logged_in && gate?.scans_enabled) {
    scansEnabled = true;
    hideLoginOverlay();
    updatePharmacyFooter(gate.pharmacy_name || null);
    setSettingsVisible(true, { logout: true });
    setSettingsDetails(gate);
    if (!sidebarOpen) resizeWindow(idleSizeKey());
    return;
  }

  scansEnabled = false;
  setSettingsVisible(false);
  updatePharmacyFooter(null);
  showLoginOverlay();
  if (gate?.error_message) showLoginError(gate.error_message);
  else clearLoginError();
}

let loginPending = false;

async function submitLogin(event) {
  event?.preventDefault();
  if (!loginSubmit || loginPending) return;
  const identifier = loginIdentifier?.value?.trim() || "";
  const password = loginPassword?.value || "";
  if (!identifier || !password) {
    showLoginError("Συμπληρώστε email και κωδικό.");
    return;
  }
  clearLoginError();
  loginPending = true;
  loginSubmit.disabled = true;
  loginSubmit.textContent = "Σύνδεση…";
  try {
    const gate = await invoke("login", { identifier, password });
    applyAuthGate(gate);
    if (!gate?.scans_enabled && gate?.error_message) showLoginError(gate.error_message);
  } catch (err) {
    const text = String(err ?? "");
    showLoginError(text.toLowerCase().includes("network") ? OFFLINE_MESSAGE : text || OFFLINE_MESSAGE);
  } finally {
    loginPending = false;
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Είσοδος";
    if (loginPassword) loginPassword.value = "";
  }
}

function setupLogin() {
  loginForm?.addEventListener("submit", (event) => {
    void submitLogin(event);
  });
  loginPasswordToggle?.addEventListener("click", () => {
    if (!loginPassword) return;
    const show = loginPassword.type === "password";
    loginPassword.type = show ? "text" : "password";
    loginPasswordToggle.classList.toggle("is-visible", show);
    loginPasswordToggle.setAttribute("aria-pressed", show ? "true" : "false");
    loginPasswordToggle.setAttribute("aria-label", show ? "Απόκρυψη κωδικού" : "Εμφάνιση κωδικού");
  });
}

function setupSettingsMenu() {
  settingsButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (settingsMenu?.classList.contains("hidden")) openSettingsMenu();
    else closeSettingsMenu();
  });
  reportMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    openReportPanel();
  });
  logoutButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    openLogoutConfirm();
  });
  logoutCancel?.addEventListener("click", (event) => {
    event.preventDefault();
    closeLogoutConfirm();
  });
  logoutConfirmButton?.addEventListener("click", (event) => {
    event.preventDefault();
    void confirmLogout();
  });
  logoutConfirm?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLogoutConfirm();
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (!settingsMenu || settingsMenu.classList.contains("hidden")) return;
    const target = event.target;
    if (target.closest?.("#settings-menu") || target.closest?.("#orb-settings-btn")) return;
    closeSettingsMenu();
  });
}

let reportReturnSize = "collapsed";
let reportLocked = false;
let updateUi = { note: false, installNow: false };

function idleSizeKey() {
  return updateUi.note ? "collapsedNote" : "collapsed";
}

function showUpdateNote(message) {
  updateUi = reduceUpdateUi(updateUi, { type: "downloaded" });
  if (!updateNote) return;
  updateNote.textContent = message || UPDATE_NOTE;
  updateNote.classList.remove("hidden");
  orbDock?.classList.add("has-update-note");
  if (!sidebarOpen && reportOverlay?.classList.contains("hidden") && logoutConfirm?.classList.contains("hidden")) {
    resizeWindow("collapsedNote");
  }
}

function openLogoutConfirm() {
  closeSettingsMenu();
  if (!logoutConfirm) return;
  logoutConfirm.classList.remove("hidden");
  logoutConfirm.setAttribute("aria-hidden", "false");
  logoutCancel?.focus();
}

function closeLogoutConfirm() {
  if (!logoutConfirm) return;
  logoutConfirm.classList.add("hidden");
  logoutConfirm.setAttribute("aria-hidden", "true");
}

async function confirmLogout() {
  closeLogoutConfirm();
  try {
    const gate = await invoke("logout");
    applyAuthGate(gate);
  } catch (err) {
    showLoginOverlay();
    showLoginError(String(err));
  }
}

function hideReportStatus() {
  if (!reportStatus) return;
  reportStatus.replaceChildren();
  reportStatus.classList.add("hidden");
  reportStatus.classList.remove("sent");
}

function resetReportComposer() {
  reportLocked = false;
  if (reportMessage) {
    reportMessage.value = "";
    reportMessage.readOnly = false;
  }
  hideReportStatus();
  if (reportSend) {
    reportSend.disabled = false;
    reportSend.textContent = "Αποστολή";
    reportSend.type = "submit";
  }
}

function applyReportResult(result) {
  const status = reportStatusFor(result);
  if (!reportStatus) return status;
  if (status.kind === "sent") {
    reportLocked = true;
    const mark = document.createElement("span");
    mark.className = "report-sent-mark";
    mark.textContent = status.mark;
    const code = document.createElement("span");
    code.className = "report-sent-code";
    code.textContent = status.codeLabel;
    const hint = document.createElement("span");
    hint.className = "report-sent-hint";
    hint.textContent = status.hint;
    reportStatus.replaceChildren(mark, code, hint);
    reportStatus.classList.remove("hidden");
    reportStatus.classList.add("sent");
    if (reportMessage) reportMessage.readOnly = true;
    if (reportSend) {
      reportSend.disabled = false;
      reportSend.textContent = status.buttonLabel;
      reportSend.type = "button";
    }
    return status;
  }
  reportStatus.textContent = status.text;
  reportStatus.classList.remove("hidden", "sent");
  if (reportMessage) reportMessage.readOnly = false;
  if (reportSend) {
    reportSend.disabled = false;
    reportSend.textContent = status.buttonLabel;
    reportSend.type = "submit";
  }
  return status;
}

function openReportPanel() {
  if (!reportOverlay) return;
  if (reportLocked) resetReportComposer();
  reportReturnSize = sidebarOpen ? "sidebar" : idleSizeKey();
  closeSettingsMenu();
  reportOverlay.classList.remove("hidden");
  reportOverlay.setAttribute("aria-hidden", "false");
  resizeWindow("report");
  if (!reportMessage?.readOnly) reportMessage?.focus();
}

function closeReportPanel() {
  if (!reportOverlay) return;
  reportOverlay.classList.add("hidden");
  reportOverlay.setAttribute("aria-hidden", "true");
  resizeWindow(reportReturnSize);
}

let reportPending = false;

async function submitReport(event) {
  event?.preventDefault();
  if (!reportSend || reportPending || reportSend.disabled) return;
  const draft = reportMessage?.value ?? "";
  hideReportStatus();
  reportPending = true;
  reportSend.disabled = true;
  const previousLabel = reportSend.textContent;
  reportSend.textContent = "Αποστολή…";
  try {
    const result = await invoke("submit_problem_report", {
      message: draft.trim() ? draft : null,
    });
    applyReportResult(result);
    if (reportMessage && reportStatusFor(result).keepDraft) reportMessage.value = draft;
  } catch (err) {
    const text = String(err ?? "");
    const offline = text.toLowerCase().includes("network") || text.includes(OFFLINE_MESSAGE);
    applyReportResult({
      ok: false,
      error_code: offline ? "offline" : "server",
      error_message: offline ? OFFLINE_MESSAGE : text || "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.",
    });
    if (reportMessage) reportMessage.value = draft;
  } finally {
    reportPending = false;
    if (reportSend && !reportStatus?.classList.contains("sent")) {
      reportSend.textContent = previousLabel || "Αποστολή";
      reportSend.disabled = false;
      reportSend.type = "submit";
    }
  }
}

function setupReport() {
  reportForm?.addEventListener("submit", (event) => {
    if (reportStatus?.classList.contains("sent")) {
      event.preventDefault();
      closeReportPanel();
      return;
    }
    void submitReport(event);
  });
  reportSend?.addEventListener("click", (event) => {
    if (!reportStatus?.classList.contains("sent")) return;
    event.preventDefault();
    closeReportPanel();
  });
  reportClose?.addEventListener("click", (event) => {
    event.preventDefault();
    closeReportPanel();
  });
}

async function startUpdateWatch() {
  try {
    const notice = await invoke("get_update_notice");
    if (notice) showUpdateNote(notice);
  } catch (err) {
    console.warn("[Update] status unavailable:", err);
  }
  await listen("update-ready", (event) => {
    showUpdateNote(event?.payload?.message || UPDATE_NOTE);
  });
}

function browserPreview() {
  if (window.__TAURI__?.core?.invoke) return null;
  const raw = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.search.startsWith("?")
      ? location.search.slice(1)
      : "";
  const params = new URLSearchParams(raw);
  if (!params.get("preview")) return null;
  return params;
}

function renderPreview(params) {
  document.body.classList.add("preview-stage");
  const state = params.get("preview");
  const email = params.get("email") || "pilot@farmakeio.gr";
  const pharmacy = params.get("pharmacy") || "Φαρμακείο Παπαδόπουλος";
  hideActivationOverlay();
  hideLoginOverlay();
  setSettingsVisible(false);
  updatePharmacyFooter(null);
  scansEnabled = false;
  authMode = "test";

  if (
    state === "login" ||
    state === "login-error" ||
    state === "login-inactive" ||
    state === "login-unassigned" ||
    state === "login-offline" ||
    state === "login-loading"
  ) {
    authMode = "login";
    if (loginIdentifier) loginIdentifier.value = email;
    if (loginPassword && state !== "login") loginPassword.value = "secret-password";
    showLoginOverlay();
    if (state === "login-error") showLoginError(BAD_CREDENTIALS_MESSAGE);
    if (state === "login-inactive") showLoginError(INACTIVE_PHARMACY_MESSAGE);
    if (state === "login-unassigned") showLoginError(UNASSIGNED_PHARMACY_MESSAGE);
    if (state === "login-offline") showLoginError(OFFLINE_MESSAGE);
    if (state === "login-loading" && loginSubmit) {
      loginPending = true;
      loginSubmit.disabled = true;
      loginSubmit.textContent = "Σύνδεση…";
    }
    return;
  }

  if (state === "logged-in" || state === "settings" || state === "update-ready" || state === "logout-confirm") {
    authMode = "login";
    scansEnabled = true;
    updatePharmacyFooter(pharmacy);
    setSettingsVisible(true, { logout: true });
    setSettingsDetails({ pharmacy_name: pharmacy, email });
    if (state === "settings") openSettingsMenu();
    else closeSettingsMenu();
    if (state === "update-ready") showUpdateNote(UPDATE_NOTE);
    if (state === "logout-confirm") openLogoutConfirm();
    setOrbState("idle");
    return;
  }

  if (state === "report" || state === "report-filled" || state === "report-sent" || state === "report-offline") {
    authMode = "login";
    scansEnabled = true;
    updatePharmacyFooter(pharmacy);
    setSettingsVisible(true, { logout: true });
    setSettingsDetails({ pharmacy_name: pharmacy, email });
    closeSettingsMenu();
    openReportPanel();
    if (state === "report-filled" || state === "report-offline" || state === "report-sent") {
      if (reportMessage) reportMessage.value = REPORT_EXAMPLE;
    }
    if (state === "report-sent") {
      applyReportResult({ ok: true, reference_code: "A1B2" });
    }
    if (state === "report-offline") {
      applyReportResult({ ok: false, error_code: "offline", error_message: OFFLINE_MESSAGE });
    }
    setOrbState("idle");
    return;
  }

  if (state === "idle") {
    setOrbState("idle");
    return;
  }

  if (state === "scan-chip") {
    const drug = {
      id: "preview-chip",
      barcode: "0000000000000",
      found: false,
      productName: "0000000000000",
      activeIngredient: "",
      atcCode: "",
      sideEffects: null,
      sideEffectsStatus: "idle",
      recommendation: null,
      errorMessage: null,
      status: "idle",
    };
    scannedDrugs = [drug];
    activeDrugId = null;
    sidebarOpen = true;
    drugSidebar.classList.remove("hidden");
    drugSidebar.classList.add("visible");
    renderDrugList();
    setOrbState("idle");
    return;
  }

  if (state === "side-effects-many" || state === "side-effects-few") {
    const many = state === "side-effects-many";
    const drug = {
      id: many ? "preview-augmentin" : "preview-few",
      barcode: many ? "5201234567890" : "5200000000002",
      found: true,
      productName: many ? "Augmentin" : "Algofren",
      activeIngredient: many ? "Amoxicillin / Clavulanic acid" : "Ibuprofen",
      atcCode: many ? "J01CR02" : "M01AE01",
      sideEffects: many
        ? "Περίληψη του προφίλ ασφάλειας. Οι συχνότερα αναφερόμενες ανεπιθύμητες ενέργειες είναι διάρροια, ναυτία, έμετος και δερματικό εξάνθημα. Οι ανεπιθύμητες ενέργειες ταξινομούνται κατά συχνότητα ως εξής: πολύ συχνές (≥1/10), συχνές (≥1/100 έως <1/10), όχι συχνές (≥1/1.000 έως <1/100), σπάνιες (≥1/10.000 έως <1/1.000), πολύ σπάνιες (<1/10.000). Λοιμώξεις και παρασιτώσεις Συχνές: καντιντίαση του δέρματος και των βλεννογόνων. Διαταραχές του ανοσοποιητικού συστήματος Σπάνιες: αναφυλαξία, αγγειοοίδημα. Διαταραχές του νευρικού συστήματος Όχι συχνές: κεφαλαλγία, ζάλη. Διαταραχές του γαστρεντερικού συστήματος Πολύ συχνές: διάρροια. Συχνές: ναυτία, έμετος, δυσπεψία, κοιλιακό άλγος. Διαταραχές του ήπατος Όχι συχνές: αύξηση ηπατικών ενζύμων. Σπάνιες: ηπατίτιδα. Διαταραχές του δέρματος Συχνές: κνησμός, κνίδωση."
        : "Ήπια ναυτία, κεφαλαλγία και ζάλη.",
      sideEffectsStatus: "done",
      sideEffectsExpanded: false,
      recommendation: many
        ? "Επειδή ξεκινάτε το Augmentin, καλό είναι να συνδυάσουμε ένα προβιοτικό για την εντερική χλωρίδα. Η διάρροια είναι συχνή με αυτή την αγωγή. Το προβιοτικό την περιορίζει στην πράξη. Πάρτε το με ένα ποτήρι νερό, μακριά από το αντιβιοτικό."
        : null,
      errorMessage: null,
      status: many ? "done" : "idle",
    };
    scannedDrugs = [drug];
    activeDrugId = many ? drug.id : null;
    sidebarOpen = true;
    drugSidebar.classList.remove("hidden");
    drugSidebar.classList.add("visible");
    renderDrugList();
    setOrbState("idle");
    return;
  }

  if (state === "scan-success" || state === "scan-error" || state === "scan-not-found") {
    const success = state === "scan-success";
    const prodMiss = state === "scan-not-found";
    const drug = {
      id: success ? "preview-success" : "preview-error",
      barcode: success ? "1111111111111" : "0000000000000",
      found: success,
      productName: success ? "Panadol Extra 500mg (TEST)" : "0000000000000",
      activeIngredient: success ? "Paracetamol / Caffeine" : "",
      atcCode: success ? "N02BE51" : "",
      sideEffects: success
        ? "Σπάνια δερματικό εξάνθημα. Σε υπερβολική δόση, κίνδυνος ηπατικής βλάβης."
        : null,
      sideEffectsStatus: success ? "done" : "idle",
      recommendation: success
        ? "Μαζί με το Panadol Extra, προτείνετε ένα ήπιο προβιοτικό για την εντερική άνεση κατά την αγωγή. Είναι μια πρακτική και ασφαλής συνοδευτική πρόταση."
        : null,
      errorMessage: success
        ? null
        : prodMiss
          ? PRODUCT_NOT_FOUND_MESSAGE
          : "Δοκιμαστικό σφάλμα — το προϊόν δεν βρέθηκε στον κατάλογο.",
      status: success ? "done" : "error",
    };
    scannedDrugs = [drug];
    activeDrugId = drug.id;
    sidebarOpen = true;
    drugSidebar.classList.remove("hidden");
    drugSidebar.classList.add("visible");
    renderDrugList();
    setOrbState(success ? "idle" : "error");
  }
}

async function noteApiAuthFailure(message, raw) {
  const blob = `${message || ""}\n${raw || ""}`;
  const authFailure =
    blob.includes("pharmacy_inactive") ||
    blob.includes("ανενεργός") ||
    blob.includes("pharmacy_unassigned") ||
    blob.includes("unauthorized") ||
    blob.includes("σύνδεση έληξε") ||
    blob.includes("Απαιτείται σύνδεση") ||
    isLicenseInactiveMessage(blob);
  if (!authFailure) return false;
  if (authMode === "login") {
    try {
      const gate = await invoke("get_auth_gate");
      applyAuthGate(gate);
    } catch (err) {
      showLoginOverlay();
    }
    if (message) showLoginError(message);
    return true;
  }
  return false;
}

function showActivationError(message) {
  if (!activationError) return;
  activationError.textContent = message;
  activationError.classList.remove("hidden");
}

function clearActivationError() {
  if (!activationError) return;
  activationError.textContent = "";
  activationError.classList.add("hidden");
}

function updatePharmacyFooter(businessName) {
  if (!orbPharmacyName) return;
  if (businessName) {
    orbPharmacyName.textContent = businessName;
    orbPharmacyName.classList.remove("hidden");
  } else {
    orbPharmacyName.textContent = "";
    orbPharmacyName.classList.add("hidden");
  }
}

function showActivationOverlay(mode = "activate") {
  if (!activationOverlay) return;
  activationMode = mode;
  pharmacyActivated = false;
  pharmacyLicenseValid = false;
  activationOverlay.classList.remove("hidden");
  activationOverlay.setAttribute("aria-hidden", "false");
  if (activationDesc) {
    activationDesc.textContent =
      mode === "reconnect"
        ? LICENSE_RECONNECT_MESSAGE
        : mode === "inactive"
          ? LICENSE_INACTIVE_MESSAGE
          : "Εισάγετε τον κωδικό ενεργοποίησης από τη σελίδα εγγραφής.";
  }
  if (activationKeyInput) {
    activationKeyInput.value = "";
    activationKeyInput.disabled = mode === "reconnect";
  }
  if (activationSubmitBtn) {
    activationSubmitBtn.disabled = mode === "reconnect";
    activationSubmitBtn.textContent =
      mode === "reconnect" ? "Επανάληψη" : "Ενεργοποίηση";
  }
  clearActivationError();
}

function hideActivationOverlay() {
  if (!activationOverlay) return;
  activationOverlay.classList.add("hidden");
  activationOverlay.setAttribute("aria-hidden", "true");
  clearActivationError();
}

function applyPharmacyStatus(status) {
  pharmacyActivated = Boolean(status?.activated);
  pharmacyLicenseValid =
    pharmacyActivated && status?.license_valid !== false && !status?.needs_reconnect;

  if (!pharmacyActivated) {
    showActivationOverlay("activate");
    updatePharmacyFooter(null);
    return;
  }

  if (!pharmacyLicenseValid) {
    const mode = status?.needs_reconnect ? "reconnect" : "inactive";
    showActivationOverlay(mode);
    if (status?.lock_reason) showActivationError(status.lock_reason);
    updatePharmacyFooter(status?.business_name || null);
    return;
  }

  hideActivationOverlay();
  updatePharmacyFooter(status?.business_name || null);
}

async function submitActivation() {
  if (!activationSubmitBtn) return;

  if (activationMode === "reconnect") {
    clearActivationError();
    activationSubmitBtn.disabled = true;
    try {
      const status = await invoke("get_pharmacy_status");
      applyPharmacyStatus(status);
      if (!pharmacyLicenseValid && status?.lock_reason) {
        showActivationError(status.lock_reason);
      }
    } catch (err) {
      showActivationError(String(err));
    } finally {
      activationSubmitBtn.disabled = false;
    }
    return;
  }

  if (!activationKeyInput) return;
  const licenseKey = activationKeyInput.value.trim();
  if (!licenseKey) {
    showActivationError("Εισάγετε τον κωδικό ενεργοποίησης.");
    return;
  }

  clearActivationError();
  activationSubmitBtn.disabled = true;
  try {
    const status = await invoke("activate_pharmacy", { licenseKey });
    applyPharmacyStatus(status);
    if (!pharmacyLicenseValid && status?.lock_reason) {
      showActivationError(status.lock_reason);
    }
  } catch (err) {
    showActivationError(String(err));
  } finally {
    activationSubmitBtn.disabled = false;
  }
}

function setupActivationOverlay() {
  if (!activationSubmitBtn) return;
  activationSubmitBtn.addEventListener("click", () => {
    void submitActivation();
  });
  if (activationKeyInput) {
    activationKeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitActivation();
      }
    });
  }
}

async function checkPharmacyOnStartup() {
  try {
    const status = await invoke("get_pharmacy_status");
    applyPharmacyStatus(status);
  } catch (err) {
    console.error("[Pharmacy] status check failed:", err);
    showActivationOverlay("activate");
  }
}

function isLicenseInactiveMessage(message) {
  return String(message || "").includes("άδεια χρήσης δεν είναι ενεργή");
}

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
  if (!WINDOW || !LogicalSize) return;
  const size = SIZES[sizeKey];

  if (sizeKey === "collapsed" || sizeKey === "collapsedNote" || sizeKey === "report" || sizeKey === "login") {
    await WINDOW.setSize(new LogicalSize(size.width, size.height));
    return;
  }

  await waitForLayout();
  const layout = $("main-layout");
  const contentHeight = (layout?.scrollHeight ?? 0) + WINDOW_LAYOUT_PADDING_Y;
  const height = Math.max(size.height, contentHeight);
  let width = size.width;
  if (sizeKey === "sidebar") {
    const contentWidth = (layout?.scrollWidth ?? 0) + 24;
    width = Math.min(SIDEBAR_WINDOW_MAX_WIDTH, Math.max(size.width, contentWidth));
  }
  await WINDOW.setSize(new LogicalSize(width, height));
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
    sidebarLookupDetail.textContent = LOOKUP_NO_RESULTS_MESSAGE;
    sidebarLookupDetail.classList.remove("hidden");
    sidebarLookupDetail.title = "";
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
  await resizeWindow(idleSizeKey());
}

function createDrugEntry(lookupResult, barcode) {
  return {
    id: createDrugId(),
    barcode,
    found: lookupResult.found,
    productName: lookupResult.product_name || "",
    activeIngredient: lookupResult.active_ingredient || "",
    atcCode: lookupResult.atc_code || "",
    sideEffects: lookupResult.side_effects || null,
    sideEffectsStatus: lookupResult.side_effects ? "done" : "idle",
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
  const effectsBlock = el.querySelector(".drug-side-effects");
  const effectsText = el.querySelector(".side-effects-text");
  const effectsList = el.querySelector(".side-effects-list");
  const moreBtn = el.querySelector(".side-effects-more");
  const recBlock = el.querySelector(".drug-recommendation");
  const recText = el.querySelector(".recommendation-text");
  const recMore = el.querySelector(".recommendation-more");

  btn.textContent = shortDisplayName(drug.productName || drug.barcode);
  btn.title = drug.productName || drug.barcode;
  btn.disabled = processing && drug.status === "loading";
  btn.classList.toggle("active", drug.id === activeDrugId);
  btn.classList.toggle("loading", drug.status === "loading");

  const view = visibleSideEffects(drug.sideEffects, Boolean(drug.sideEffectsExpanded));
  if (view.bullets.length) {
    effectsBlock.classList.remove("hidden", "loading");
    effectsBlock.classList.toggle("is-expanded", Boolean(drug.sideEffectsExpanded));
    effectsText.textContent = "";
    effectsText.classList.add("is-hidden");
    effectsList.classList.remove("is-hidden");
    effectsList.replaceChildren(
      ...view.bullets.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    if (view.hiddenCount > 0) {
      moreBtn.textContent = view.moreLabel;
      moreBtn.classList.remove("is-hidden");
    } else {
      moreBtn.textContent = "";
      moreBtn.classList.add("is-hidden");
    }
  } else if (drug.sideEffectsStatus === "loading") {
    effectsBlock.classList.remove("hidden", "is-expanded");
    effectsBlock.classList.add("loading");
    effectsText.textContent = "Αναζήτηση παρενεργειών…";
    effectsText.classList.remove("is-hidden");
    effectsList.replaceChildren();
    effectsList.classList.add("is-hidden");
    moreBtn.textContent = "";
    moreBtn.classList.add("is-hidden");
  } else {
    effectsBlock.classList.add("hidden");
    effectsBlock.classList.remove("loading", "is-expanded");
    effectsText.textContent = "";
    effectsText.classList.add("is-hidden");
    effectsList.replaceChildren();
    effectsList.classList.add("is-hidden");
    moreBtn.textContent = "";
    moreBtn.classList.add("is-hidden");
  }

  const isActive = drug.id === activeDrugId;

  const showRecommendationMore = (label) => {
    if (!label) {
      recMore.textContent = "";
      recMore.classList.add("is-hidden");
      return;
    }
    recMore.textContent = label;
    recMore.classList.remove("is-hidden");
  };

  if (drug.status === "loading") {
    recBlock.classList.remove("hidden", "error", "is-expanded");
    recText.textContent = "Αναμονή πρότασης…";
    showRecommendationMore("");
  } else if (isActive && drug.status === "done" && drug.recommendation) {
    const recommendation = visibleRecommendation(drug.recommendation, {
      expanded: Boolean(drug.recommendationExpanded),
      fits: recommendationFitsThreeLines,
    });
    recBlock.classList.remove("hidden", "error");
    recBlock.classList.toggle("is-expanded", Boolean(drug.recommendationExpanded));
    recText.textContent = recommendation.text;
    showRecommendationMore(recommendation.moreLabel);
  } else if (isActive && drug.status === "error" && drug.errorMessage) {
    recBlock.classList.remove("hidden", "is-expanded");
    recBlock.classList.add("error");
    recText.textContent = drug.errorMessage;
    showRecommendationMore("");
  } else {
    recBlock.classList.add("hidden");
    recBlock.classList.remove("error", "is-expanded");
    recText.textContent = "";
    showRecommendationMore("");
  }
}

const RECOMMENDATION_LINE_PX = 26;
const RECOMMENDATION_TEXT_WIDTH = 336;

function recommendationFitsThreeLines(text) {
  const probe = document.createElement("p");
  probe.className = "recommendation-text";
  probe.textContent = text;
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.display = "block";
  probe.style.width = `${RECOMMENDATION_TEXT_WIDTH}px`;
  probe.style.margin = "0";
  probe.style.padding = "0";
  probe.style.fontSize = "18px";
  probe.style.lineHeight = `${RECOMMENDATION_LINE_PX}px`;
  probe.style.whiteSpace = "normal";
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  if (height < 1) {
    const charsPerLine = Math.floor(RECOMMENDATION_TEXT_WIDTH / 9);
    return text.length <= charsPerLine * 3;
  }
  return Math.round(height / RECOMMENDATION_LINE_PX) <= 3;
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

  const effectsBlock = document.createElement("div");
  effectsBlock.className = "drug-side-effects hidden";

  const effectsLabel = document.createElement("p");
  effectsLabel.className = "side-effects-label";
  effectsLabel.textContent = "Παρενέργειες";

  const effectsText = document.createElement("p");
  effectsText.className = "side-effects-text is-hidden";

  const effectsList = document.createElement("ul");
  effectsList.className = "side-effects-list";

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "side-effects-more is-hidden";
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = findDrugById(drug.id);
    if (!current) return;
    current.sideEffectsExpanded = true;
    renderDrugList();
    void resizeWindow("sidebar");
  });

  const effectsNote = document.createElement("p");
  effectsNote.className = "side-effects-note";
  effectsNote.textContent = SIDE_EFFECTS_TRUST_LINE;

  effectsBlock.appendChild(effectsLabel);
  effectsBlock.appendChild(effectsText);
  effectsBlock.appendChild(effectsList);
  effectsBlock.appendChild(moreBtn);
  effectsBlock.appendChild(effectsNote);

  const recBlock = document.createElement("div");
  recBlock.className = "drug-recommendation hidden";

  const recText = document.createElement("p");
  recText.className = "recommendation-text";

  const recMore = document.createElement("button");
  recMore.type = "button";
  recMore.className = "recommendation-more is-hidden";
  recMore.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = findDrugById(drug.id);
    if (!current) return;
    current.recommendationExpanded = true;
    renderDrugList();
    void resizeWindow("sidebar");
  });

  recBlock.appendChild(recText);
  recBlock.appendChild(recMore);

  item.appendChild(btn);
  item.appendChild(effectsBlock);
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

  if (await noteApiAuthFailure(lookupResult.miss_reason, "")) {
    setOrbState("error");
    return;
  }

  if (isLicenseInactiveMessage(lookupResult.miss_reason)) {
    const status = await invoke("get_pharmacy_status");
    applyPharmacyStatus(status);
    setOrbState("error");
    return;
  }

  const existing = findDrugByBarcode(barcode);
  if (existing) {
    void loadSideEffects(existing);
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
    void loadSideEffects(drug);
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
    sideEffects: null,
    sideEffectsStatus: "idle",
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

function loadSideEffects(drug) {
  if (!drug || drug.sideEffects || drug.sideEffectsStatus === "empty") {
    return Promise.resolve();
  }
  if (sideEffectLoads.has(drug.id)) {
    return sideEffectLoads.get(drug.id);
  }

  drug.sideEffectsStatus = "loading";
  renderDrugList();

  const job = invoke("fetch_side_effects", {
    barcode: drug.barcode,
    productName: drug.productName || null,
  })
    .then(async (result) => {
      const text = String(result?.side_effects || "").trim();
      if (text) {
        drug.sideEffects = text;
        drug.sideEffectsStatus = "done";
        if (result.active_ingredient && !drug.activeIngredient) {
          drug.activeIngredient = result.active_ingredient;
        }
        if (result.atc_code && !drug.atcCode) {
          drug.atcCode = result.atc_code;
        }
        if (result.product_name && !drug.productName) {
          drug.productName = result.product_name;
        }
      } else {
        drug.sideEffectsStatus = "empty";
      }
    })
    .catch((err) => {
      console.warn("[SideEffects] fetch failed:", err);
      drug.sideEffectsStatus = "empty";
    })
    .finally(async () => {
      sideEffectLoads.delete(drug.id);
      renderDrugList();
      if (sidebarOpen) await resizeWindow("sidebar");
    });

  sideEffectLoads.set(drug.id, job);
  return job;
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

  await loadSideEffects(drug);
  console.log(`[Recommend] barcode=${drug.barcode} product_name="${drug.productName}"`);

  try {
    let timeoutId;
    const result = await Promise.race([
      invoke("get_recommendation", {
        barcode: drug.barcode,
        productName: drug.productName || null,
        activeIngredient: drug.activeIngredient || null,
        atcCode: drug.atcCode || null,
        sideEffects: drug.sideEffects || null,
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
      if (await noteApiAuthFailure(msg, result?.raw_response)) {
        drug.errorMessage = msg;
        drug.recommendation = null;
        drug.status = "error";
        setOrbState("error");
        triggerFlash();
        setTimeout(() => setOrbState("idle"), 650);
        return;
      }
      if (isLicenseInactiveMessage(msg) || isLicenseInactiveMessage(result?.raw_response)) {
        const status = await invoke("get_pharmacy_status");
        applyPharmacyStatus(status);
        drug.errorMessage = LICENSE_INACTIVE_MESSAGE;
        drug.recommendation = null;
        drug.status = "error";
        setOrbState("error");
        triggerFlash();
        setTimeout(() => setOrbState("idle"), 650);
        return;
      }
      drug.errorMessage = msg;
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
  const legacyReady = authMode === "legacy" && pharmacyActivated && pharmacyLicenseValid;
  if (!scansEnabled && !legacyReady) return;
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
    if (target.closest("#activation-key-input")) return;
    if (target.closest("#activation-submit-btn")) return;
    if (target.closest("#login-overlay")) return;
    if (target.closest("#report-overlay")) return;
    if (target.closest("#settings-menu")) return;
    if (target.closest("#report-menu-btn")) return;
    if (target.closest("#logout-btn")) return;
    if (target.closest(".drug-name-btn")) return;
    if (target.closest(".drug-recommendation")) return;
    if (target.closest(".drug-side-effects")) return;
    if (target.closest(".drug-list")) return;

    if (target.closest("[data-drag-region]")) {
      e.preventDefault();
      WINDOW?.startDragging();
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
    WINDOW?.minimize();
  });

  $("orb-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    WINDOW?.close();
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
  setupActivationOverlay();
  setupLogin();
  setupSettingsMenu();
  setupReport();

  const preview = browserPreview();
  if (preview) {
    renderPreview(preview);
    return;
  }

  const gate = await invoke("get_auth_gate");
  applyAuthGate(gate);
  if (gate?.mode === "legacy") {
    await checkPharmacyOnStartup();
  }

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
  void startUpdateWatch();

  console.log("[pharmaBuddy] Widget ready");
}

init();

// LINUX_KEYSTROKE_SCAN
(function setupLinuxKeystrokeScan() {
  if (/Windows/i.test(navigator.userAgent)) return;

  const thresholdMs = 400;
  let buffer = "";
  let lastAt = 0;

  window.addEventListener("keydown", (e) => {
    const tag = e.target?.tagName || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const now = Date.now();
    if (lastAt && now - lastAt > thresholdMs) buffer = "";
    lastAt = now;

    if (e.key === "Enter" || e.key === "Tab") {
      const raw = buffer;
      buffer = "";
      if (raw.length > 3) {
        e.preventDefault();
        processBarcode(raw);
      }
      return;
    }

    if (e.key.length === 1 && /[0-9a-zA-Z]/.test(e.key)) {
      buffer += e.key.toUpperCase();
      e.preventDefault();
    }
  });
})();
