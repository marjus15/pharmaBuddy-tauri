export const OFFLINE_MESSAGE = "Δεν υπάρχει σύνδεση στο internet";
export const LOGIN_OFFLINE_MESSAGE =
  "Δεν υπάρχει σύνδεση στο internet. Ελέγξτε τη σύνδεση και δοκιμάστε ξανά.";
export const LOGIN_CONFIG_MESSAGE =
  "Λάθος ρυθμίσεις εφαρμογής. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.";
export const LOGIN_SERVER_MESSAGE =
  "Δεν ήταν δυνατή η σύνδεση με το PharmaBuddy. Δοκιμάστε ξανά σε λίγο.";
export const FORGOT_PASSWORD_MESSAGE =
  "Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy για νέο κωδικό.";
export const UPDATE_NOTE = "↻ Νέα έκδοση στο επόμενο άνοιγμα";
export const REPORT_SENT_MARK = "✓ Στάλθηκε";
export const REPORT_SENT_HINT = "Πείτε αυτόν τον κωδικό στον υπεύθυνο του PharmaBuddy.";
export const INACTIVE_PHARMACY_MESSAGE =
  "Ο λογαριασμός του φαρμακείου είναι ανενεργός. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.";
export const UNASSIGNED_PHARMACY_MESSAGE =
  "Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.";

const LOGIN_DEFERRED_CODES = new Set(["offline", "unreachable", "config", "server", "store"]);

/**
 * Connectivity, config, and generic server failures stay hidden until Είσοδος.
 * Credential and pharmacy-state messages still show when the session gate already has them.
 */
export function loginErrorOnStartup(gate) {
  const code = String(gate?.error_code || "");
  const message = String(gate?.error_message || "");
  if (!message) return "";
  if (
    LOGIN_DEFERRED_CODES.has(code) ||
    message === OFFLINE_MESSAGE ||
    message === LOGIN_OFFLINE_MESSAGE ||
    message === LOGIN_CONFIG_MESSAGE ||
    message === LOGIN_SERVER_MESSAGE
  ) {
    return "";
  }
  return message;
}

/**
 * A thrown login call is not proof the PC is offline.
 * `online === false` is the device check. Config strings stay config. Everything else is "could not reach PharmaBuddy".
 */
export function loginFailureMessage({ online, errorText }) {
  if (online === false) return LOGIN_OFFLINE_MESSAGE;
  const text = String(errorText || "");
  if (
    /SUPABASE_FUNCTIONS_URL|SUPABASE_ANON_KEY/.test(text) ||
    text.includes("Σφάλμα ρυθμίσεων") ||
    /\bconfig\b/i.test(text)
  ) {
    return LOGIN_CONFIG_MESSAGE;
  }
  return LOGIN_SERVER_MESSAGE;
}

export function formatReportCode(code) {
  const clean = String(code || "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
  return `#${clean}`;
}

export function reportStatusFor(result) {
  if (result?.ok && result.reference_code) {
    return {
      kind: "sent",
      mark: REPORT_SENT_MARK,
      codeLabel: `Κωδικός αναφοράς: ${formatReportCode(result.reference_code)}`,
      hint: REPORT_SENT_HINT,
      readOnly: true,
      buttonLabel: "Κλείσιμο",
      closeOnSend: true,
      keepDraft: true,
    };
  }
  const code = String(result?.error_code || "");
  const message = String(result?.error_message || "");
  if (code === "offline" || message === OFFLINE_MESSAGE) {
    return {
      kind: "offline",
      text: OFFLINE_MESSAGE,
      readOnly: false,
      buttonLabel: "Αποστολή",
      closeOnSend: false,
      keepDraft: true,
    };
  }
  return {
    kind: "error",
    text: message || "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.",
    readOnly: false,
    buttonLabel: "Αποστολή",
    closeOnSend: false,
    keepDraft: true,
  };
}

/**
 * UI update state. A download only raises the note.
 * installNow stays false for the whole shift; the installer runs on the next launch.
 */
export function reduceUpdateUi(state, event) {
  const note = Boolean(state?.note);
  if (event?.type === "downloaded" || event?.type === "already-pending") {
    return { note: true, installNow: false };
  }
  return { note, installNow: false };
}

/** Footer on the product card. Must not name a data source. */
export const SIDE_EFFECTS_TRUST_LINE = "ⓘ Τελική απόφαση: φαρμακοποιός";

/** Shown when an excerpt exists but no real side-effect names can be read from it. */
export const SIDE_EFFECTS_FALLBACK = "Συγκεκριμένες παρενέργειες δεν είναι διαθέσιμες.";

/** Sentinel barcode for a typed name. It is not a GTIN and must not be written to the catalog. */
export const MANUAL_ENTRY_BARCODE = "manual-entry";

export const MANUAL_NAME_NOT_FOUND_MESSAGE = "Δεν βρέθηκαν πληροφορίες για αυτό το φάρμακο";

function normalizeManualName(value) {
  return String(value || "").trim().toLocaleLowerCase("el-GR");
}

/**
 * Barcode to attach to a name the pharmacist typed.
 * An unresolved scan (no card owns that barcode yet) keeps its own code.
 * A barcode that already belongs to a different medicine is dropped, and so is
 * the last accepted scan — a typed name is not that product.
 */
export function barcodeForManualName({ pendingBarcode, name, drugs }) {
  const pending = String(pendingBarcode || "").trim();
  const typed = normalizeManualName(name);
  if (!pending || pending === MANUAL_ENTRY_BARCODE || !typed) {
    return MANUAL_ENTRY_BARCODE;
  }
  const ownedByOtherProduct = (drugs || []).some((drug) => {
    if (String(drug?.barcode || "") !== pending) return false;
    const existing = normalizeManualName(drug?.productName);
    return Boolean(existing) && existing !== typed;
  });
  if (ownedByOtherProduct) return MANUAL_ENTRY_BARCODE;
  return pending;
}

/** The newest scan is inserted first. That card is the latest one. */
export function latestDrugId(drugs) {
  if (!Array.isArray(drugs) || drugs.length === 0) return null;
  return drugs[0]?.id ?? null;
}

/** The basket panel stays this far inside the window, in CSS pixels. */
export const PANEL_MAX_INSET = 16;

export function panelMaxHeight(windowHeight) {
  const height = Number(windowHeight);
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, height - PANEL_MAX_INSET);
}

/** One product: the chip list cap used before a second product asks for room. */
export function soloChipBudget(windowHeight) {
  const height = Number(windowHeight);
  if (!Number.isFinite(height)) return 220;
  return Math.max(72, Math.min(220, height - 280));
}

/**
 * Space left for chips once the basket bar, the open card chrome, and the
 * collapsed rows have taken their height. `occupied` is that reserved height.
 */
export function sharedChipBudget(windowHeight, occupied) {
  return panelMaxHeight(windowHeight) - Math.max(0, Number(occupied) || 0);
}

/** Height of `rowCount` uniform rows. The gap sits between rows, not after the last one. */
export function chipRowsHeight(rowCount, rowHeight, gap) {
  const rows = Math.max(0, Math.floor(Number(rowCount) || 0));
  const height = Number(rowHeight);
  const spacing = Math.max(0, Number(gap) || 0);
  if (rows <= 0 || !Number.isFinite(height) || height <= 0) return 0;
  return rows * height + (rows - 1) * spacing;
}

/** How many uniform rows fit in `available` without opening a partial row. */
export function chipRowsThatFit(available, rowHeight, gap, options = {}) {
  const height = Number(rowHeight);
  const spacing = Math.max(0, Number(gap) || 0);
  const maxRows = options.maxRows ?? Infinity;
  const minRows = options.minRows ?? 0;
  if (!Number.isFinite(height) || height <= 0) return 0;
  const room = Number(available);
  if (!Number.isFinite(room)) return 0;
  const stride = height + spacing;
  let rows = Math.floor((Math.max(0, room) + spacing) / stride);
  if (Number.isFinite(maxRows)) rows = Math.min(rows, Math.max(0, maxRows));
  if (rows < minRows) rows = minRows;
  return rows;
}

/**
 * Pixel height of the chip scroller. Rows are added only when the whole row
 * fits, so the clip lands on a row boundary. The first row is kept even when
 * the budget is shorter than one row.
 */
export function chipViewportHeight(rowHeights, gap, available) {
  const heights = (Array.isArray(rowHeights) ? rowHeights : [])
    .map(Number)
    .filter((height) => Number.isFinite(height) && height > 0);
  const spacing = Math.max(0, Number(gap) || 0);
  if (heights.length === 0) return 0;
  const room = Number(available);
  let used = 0;
  let count = 0;
  for (const height of heights) {
    const next = used + (count > 0 ? spacing : 0) + height;
    if (count >= 1 && Number.isFinite(room) && next > room) break;
    used = next;
    count += 1;
  }
  return used;
}

/**
 * Inline size for the open chip scroller.
 * `null` means no row had a real height, which happens while the sidebar is
 * `display: none`. The caller must leave height and max-height alone instead
 * of writing 0, or the chips stay invisible under the label.
 * A null `height` with a positive `maxHeight` means every row fits.
 */
export function chipScrollerLock(rowHeights, gap, available) {
  const heights = (Array.isArray(rowHeights) ? rowHeights : [])
    .map(Number)
    .filter((height) => Number.isFinite(height) && height > 0);
  if (heights.length === 0) return null;
  const snapped = chipViewportHeight(heights, gap, available);
  const content = chipViewportHeight(heights, gap, Number.POSITIVE_INFINITY);
  if (snapped <= 0 || content <= 0) return null;
  if (snapped >= content) return { height: null, maxHeight: content };
  return { height: snapped, maxHeight: snapped };
}

/**
 * Window height used to budget chip rows.
 * The collapsed orb is shorter than the sidebar the window is about to grow
 * into. A fit during that open uses the screen. A sidebar that is already
 * open uses its own height, so a second product still keeps its rows on screen.
 */
export function chipFitWindowHeight(innerHeight, availHeight, collapsedHeight = 288) {
  const inner = Number(innerHeight);
  const avail = Number(availHeight);
  const collapsed = Number(collapsedHeight);
  const innerOk = Number.isFinite(inner) && inner > 0;
  const availOk = Number.isFinite(avail) && avail > 0;
  const stillCollapsed =
    innerOk &&
    availOk &&
    Number.isFinite(collapsed) &&
    collapsed > 0 &&
    inner <= collapsed + 48 &&
    avail > inner;
  if (stillCollapsed) return avail;
  if (innerOk) return inner;
  if (availOk) return avail;
  return 700;
}

/**
 * Max height of the chip list. Two or more products use the shared budget so
 * the collapsed rows stay on screen. One product uses the solo cap. Either
 * way the result is an exact number of rows.
 */
export function chipListMaxHeight({
  productCount,
  rowHeight,
  gap,
  rowCount,
  sharedBudget,
  soloBudget,
} = {}) {
  const rows = Math.max(0, Math.floor(Number(rowCount) || 0));
  const cap = productCount >= 2 ? Number(sharedBudget) : Number(soloBudget);
  const fit = chipRowsThatFit(cap, rowHeight, gap, {
    maxRows: rows,
    minRows: rows > 0 ? 1 : 0,
  });
  return chipRowsHeight(fit, rowHeight, gap);
}

/**
 * Keep the window inside the monitor work area.
 * The top stays put so the panel grows downward. The right edge stays put
 * so the orb does not jump. A window that would miss the orb is shifted up,
 * but never above the work-area top.
 */
export function clampWindowToWorkArea({ x, y, width, height, workArea, minHeight = 0 } = {}) {
  const areaX = Number(workArea?.x) || 0;
  const areaY = Number(workArea?.y) || 0;
  const areaW = Math.max(0, Number(workArea?.width) || 0);
  const areaH = Math.max(0, Number(workArea?.height) || 0);
  const bottom = areaY + areaH;
  const right = areaX + areaW;
  let nextW = areaW > 0 ? Math.min(Math.max(1, width), areaW) : Math.max(1, width);
  let nextH = Math.max(1, Number(height) || 1);
  let nextX = Number(x) || 0;
  let nextY = Number(y) || 0;

  if (nextY < areaY) nextY = areaY;
  const roomBelow = Math.max(1, bottom - nextY);
  if (nextH > roomBelow) nextH = roomBelow;

  const floor = areaH > 0 ? Math.min(Math.max(0, minHeight), areaH) : Math.max(0, minHeight);
  if (floor > 0 && nextH < floor) {
    nextY = Math.max(areaY, bottom - floor);
    nextH = Math.min(floor, Math.max(1, bottom - nextY));
  }

  if (nextX + nextW > right) nextX = right - nextW;
  if (nextX < areaX) nextX = areaX;
  if (areaW > 0 && nextX + nextW > right) nextW = Math.max(1, right - nextX);

  return {
    x: Math.round(nextX),
    y: Math.round(nextY),
    width: Math.round(nextW),
    height: Math.round(nextH),
  };
}

export const SIDE_EFFECT_VISIBLE_LIMIT = 5;

const CHIP_MAX_WORDS = 3;

/** Connector, frequency, and reference words that are never a side effect. */
const FILLER_WORDS = new Set([
  "αντιστοιχα",
  "αντιστοιχες",
  "αντιστοιχη",
  "αντιστοιχο",
  "αντιστοιχοι",
  "αντιστοιχων",
  "βλεπε",
  "βλ",
  "παρακατω",
  "επισης",
  "οπως",
  "καθως",
  "σπανια",
  "σπανιες",
  "σπανιο",
  "σπανιος",
  "σπανιως",
  "αναφερθηκαν",
  "αναφερθηκε",
  "αναφερθει",
  "αναφερονται",
  "αναφερεται",
  "αναφερομενες",
  "αναφερομενη",
  "αναφερομενα",
  "αναφερομενων",
  "ιστορικα",
  "δεδομενα",
  "κλινικων",
  "κλινικες",
  "μελετων",
  "μελετες",
  "εμπειρια",
  "εκτενη",
  "εκτεταμενη",
  "ασθενων",
  "ασθενεις",
  "ασθενη",
  "αριθμο",
  "αριθμος",
  "μικρο",
  "μικρος",
]);

/**
 * A chip must contain one of these adverse-reaction stems.
 * Boilerplate such as «Αντίστοιχα» does not.
 */
const SYMPTOM_STEMS = [
  "ναυτ",
  "εμετ",
  "διαρρο",
  "εξανθ",
  "ζαλ",
  "κεφαλαλγ",
  "αλγ",
  "δυσπεψ",
  "αιμορραγ",
  "κνησμ",
  "κνιδω",
  "ηπατ",
  "αναφυλαξ",
  "οιδημ",
  "καντιντ",
  "μυαλγ",
  "αναιμ",
  "φαρυγγ",
  "ερυθρ",
  "δυσφορ",
  "γαστρ",
  "ελκ",
  "κνιδ",
  "πυρετ",
  "βηχ",
  "δυσκοιλ",
  "υπνηλ",
  "αυπν",
  "ιλιγγ",
  "αρθραλγ",
  "ταχυκαρδ",
  "βραδυκαρδ",
  "υποτασ",
  "υπερτασ",
  "λευκοπεν",
  "θρομβ",
  "ουδετεροπ",
  "δερματιτ",
  "ουρτικ",
  "δυσπνο",
  "βρογχ",
  "στοματιτ",
  "παγκρεατ",
  "ικτερ",
  "χολοστασ",
  "δυσουρ",
  "συγχυσ",
  "παραισθ",
  "τρεμου",
  "σπασμ",
  "ξηροστομ",
  "ανορεξ",
  "κοπωσ",
  "εξασθεν",
  "ραβδομυ",
  "καταθλιψ",
  "αταξ",
  "καταστολ",
  "διαβητ",
  "μυοπαθ",
  "νευροπαθ",
  "υπογλυκ",
  "υπεργλυκ",
  "ακοκκιο",
  "υπερευαισθησ",
];

const FREQUENCY_LABELS = [
  ["μη γνωστής συχνότητας", 6],
  ["πολύ συνήθεις", 0],
  ["πολύ συνήθης", 0],
  ["όχι συνήθεις", 3],
  ["όχι συνήθης", 3],
  ["μη γνωστής", 6],
  ["πολύ σπάνιες", 5],
  ["πολύ συχνές", 0],
  ["πολύ σπάνια", 5],
  ["πολύ σπάνιο", 5],
  ["όχι συχνές", 3],
  ["πολύ συχνός", 0],
  ["πολύ συχνή", 0],
  ["πολύ συχνά", 0],
  ["όχι συχνή", 3],
  ["όχι συχνά", 3],
  ["συνήθεις", 1],
  ["συνήθης", 1],
  ["σπάνιες", 4],
  ["συχνές", 1],
  ["συχνός", 1],
  ["σπάνια", 4],
  ["σπάνιο", 4],
  ["συχνή", 1],
  ["συχνά", 1],
].sort((a, b) => b[0].length - a[0].length);

const ADVERB_STOP = new Set([
  "αναφερόμενες",
  "αναφερόμενη",
  "αναφέρεται",
  "αναφέρονται",
  "εμφανίζονται",
  "παρατηρούνται",
  "παρατηρείται",
  "είναι",
  "περιλαμβάνουν",
  "ορίζονται",
  "ορίζεται",
]);

const SERIOUS_EFFECT =
  /αναφυλαξ|αγγειοοίδ|θρομβοπεν|λευκοπεν|ακοκκιοκυτταρ|ηπατίτιδ|ραβδομυόλ|αιμορραγ|επιδερμική\s+νεκρόλ|οίδημα\s+του\s+λάρυγγ|σύνδρομο\s+stevens/iu;

function lowerEl(value) {
  return String(value || "").toLocaleLowerCase("el");
}

function isGreekLetter(ch) {
  return /[\p{L}]/u.test(ch || "");
}

function nextWord(text) {
  const match = String(text || "")
    .trimStart()
    .match(/^[\p{L}]+/u);
  return match ? lowerEl(match[0]) : "";
}

const SECTION_HEADINGS = [
  "περίληψη του προφίλ ασφαλείας",
  "περίληψη του προφίλ ασφάλειας",
  "κατάλογος ανεπιθύμητων ενεργειών",
  "πίνακας ανεπιθύμητων ενεργειών",
  "κατηγορία οργανικού συστήματος",
  "ανεπιθύμητη ενέργεια",
].sort((a, b) => b.length - a.length);

const TABLE_TOKENS = new Set([
  "συχνότητα",
  "κατηγορία",
  "οργανικού",
  "συστήματος",
  "ανεπιθύμητη",
  "ανεπιθύμητες",
  "ενέργεια",
  "ενέργειες",
  "κατάλογος",
  "περίληψη",
  "προφίλ",
  "ασφαλείας",
  "ασφάλειας",
  "πίνακας",
  "του",
  "της",
  "των",
  "και",
  "ή",
  "πολύ",
  "όχι",
  "οι",
  "η",
  "ο",
  "το",
  "τα",
  "σε",
  "με",
  "από",
  "για",
]);

function stripSectionHeadings(text) {
  let value = String(text || "");
  for (let guard = 0; guard < 8; guard++) {
    const lower = lowerEl(value);
    let next = null;
    for (const heading of SECTION_HEADINGS) {
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(heading, from);
        if (at === -1) break;
        const before = at === 0 ? "" : lower[at - 1];
        const after = lower[at + heading.length] || "";
        if (!isGreekLetter(before) && !isGreekLetter(after)) {
          next = { at, len: heading.length };
          break;
        }
        from = at + heading.length;
      }
      if (next) break;
    }
    if (!next) break;
    value = `${value.slice(0, next.at)} ${value.slice(next.at + next.len)}`.replace(/\s+/g, " ").trim();
  }
  return value;
}

function isLegend(sentence) {
  const lower = lowerEl(sentence);
  if (/[≥≤]/.test(sentence)) return true;
  return /ταξινομ|ορίζοντ|κατηγορία οργανικού|προφίλ ασφάλειας|προφίλ ασφαλείας|παρατίθενται παρακάτω|δεν μπορούν να εκτιμηθούν|κατάλογος ανεπιθύμητων|πίνακας ανεπιθύμητων|βασίζ|αυθόρμητ|καταγραφόμεν|μετά την κυκλοφορία/.test(
    lower,
  );
}

function isCutOffFragment(text) {
  return /…|\.{3}/.test(String(text || ""));
}

function isTableFragment(text) {
  const lower = lowerEl(text).replace(/[.:;]+/g, " ").replace(/\s+/g, " ").trim();
  if (!lower) return true;
  const tokens = lower.split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => TABLE_TOKENS.has(token) || isFrequencyOnly(token));
}

function isOverdose(sentence) {
  return /υπερδοσ|υπερβολικ\p{L}*\s+δόση/iu.test(sentence);
}

function isSocHeader(text) {
  const lower = lowerEl(text);
  if (/^διαταραχ(?:ές|ών)(?![\p{L}])/u.test(lower)) return true;
  if (/^(?:λοιμώξεις|παρασιτώσεις)(?![\p{L}])/u.test(lower)) return true;
  if (/λοιμώξεις και παρασιτ/.test(lower)) return true;
  if (/παρακλινικές εξετάσεις/.test(lower)) return true;
  if (/νεοπλάσμα/.test(lower)) return true;
  if (/οργανικού συστήματος/.test(lower)) return true;
  if (/κακώσεις/.test(lower) && /δηλητηρ/.test(lower)) return true;
  return false;
}

function isFrequencyOnly(text) {
  const lower = lowerEl(text).replace(/[:.]/g, "").trim();
  return FREQUENCY_LABELS.some(([label]) => label === lower);
}

function introRank(sentence) {
  const lower = lowerEl(sentence);
  if (/συχνότερ|πιο συχν|πλέον συχν|συχνά αναφερ/.test(lower)) return 0;
  return 2;
}

function findLabels(text) {
  const lower = lowerEl(text);
  const found = [];
  for (let i = 0; i < lower.length; i++) {
    for (const [label, rank] of FREQUENCY_LABELS) {
      if (!lower.startsWith(label, i)) continue;
      const before = i === 0 ? "" : lower[i - 1];
      const afterChar = lower[i + label.length] || "";
      if (isGreekLetter(before) || isGreekLetter(afterChar)) continue;
      const after = text.slice(i + label.length);
      const trimmed = after.trimStart();
      const colon = trimmed.startsWith(":");
      const adverbOk = !ADVERB_STOP.has(nextWord(trimmed));
      if (!colon && !adverbOk) continue;
      const whitespace = after.length - trimmed.length;
      found.push({
        index: i,
        end: i + label.length + (colon ? whitespace + 1 : 0),
        rank,
      });
      i += label.length - 1;
      break;
    }
  }
  return found;
}

function listBody(sentence) {
  if (!sentence.includes(",")) return sentence;
  const lower = lowerEl(sentence);
  const marker = lower.lastIndexOf(" είναι ");
  if (marker === -1) return sentence;
  return sentence.slice(marker + " είναι ".length);
}

function splitConjunctions(chunk) {
  const parts = String(chunk || "")
    .split(/\s+και\s+|\s+ή\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts;
  const merged = [];
  for (const part of parts) {
    const continuation = /^(?:των|του|της|το|τα|τις|τους|στο|στη|στην|στον|στα|στις|στους|σε|με|από|για)\b/iu.test(
      part,
    );
    if (merged.length && continuation) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} και ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function splitTopLevel(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    if (depth === 0 && (ch === "," || ch === ";" || ch === "•" || ch === "·")) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitCapitalizedEffects(piece) {
  const words = String(piece || "").split(/\s+/).filter(Boolean);
  const groups = [];
  for (const word of words) {
    const startsUpper = /^\p{Lu}/u.test(word);
    if (startsUpper && groups.length && groups[groups.length - 1].length) {
      groups.push([word]);
    } else if (groups.length) {
      groups[groups.length - 1].push(word);
    } else {
      groups.push([word]);
    }
  }
  return groups.map((group) => group.join(" ")).filter(Boolean);
}

function splitPieces(sentence) {
  const pieces = [];
  for (const chunk of splitTopLevel(listBody(sentence))) {
    for (const part of splitConjunctions(chunk)) {
      pieces.push(...splitCapitalizedEffects(part));
    }
  }
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

const ACCENTED_UPPER = {
  ά: "Ά",
  έ: "Έ",
  ή: "Ή",
  ί: "Ί",
  ό: "Ό",
  ύ: "Ύ",
  ώ: "Ώ",
  ϊ: "Ϊ",
  ϋ: "Ϋ",
};

function capitalizeGreek(text) {
  const first = text.charAt(0);
  const upper = ACCENTED_UPPER[first] || first.toLocaleUpperCase("el");
  return upper + text.slice(1);
}

function percentRank(piece) {
  const match = String(piece || "").match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (Number.isNaN(value)) return null;
  if (value >= 10) return 0;
  if (value >= 1) return 1;
  if (value >= 0.1) return 3;
  return 4;
}

function cleanItem(raw) {
  if (isCutOffFragment(raw)) return "";
  let text = String(raw || "");
  text = text.replace(/\([^)]*\)/g, " ");
  text = text.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");
  text = text.replace(/[≥≤][^,.;]*/g, " ");
  text = text.replace(
    /^(?:πολύ\s+συχν\p{L}*|όχι\s+συχν\p{L}*|πολύ\s+σπάνι\p{L}*|μη\s+γνωστής\s+συχνότητας|σπάνι\p{L}*|συχν\p{L}*)\s*[:.]?\s*/iu,
    "",
  );
  text = text.replace(/^(?:και|ή)\s+/iu, "");
  text = text.replace(/^[\s\-–—:.,;]+|[\s\-–—:.,;]+$/g, "");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\s+σε\s+(?:μικρό|μεγάλο)\s+ποσοστό(?:\s+ασθεν\p{L}*)?$/iu, "");
  text = text.replace(/^(?:η|ο|το|οι|τα)\s+/iu, "");
  text = text.replace(
    /^(?:έχει\s+παρατηρηθεί|έχουν\s+αναφερθεί|αναφέρεται|παρατηρείται|εμφανίζονται|παρατηρούνται|αναφέρονται)\s+/iu,
    "",
  );
  text = text.replace(/[\d*†]+$/u, "").trim();
  text = text.replace(/^(?:του|της|των|στο|στη|στην|στον|στα|στις|στους|σε|με|από|για)\b.*$/iu, "");
  text = text.replace(/[.]+$/g, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  if (!text || isSocHeader(text) || isFrequencyOnly(text) || isLegend(text) || isTableFragment(text)) {
    return "";
  }
  if (/^(?:του|της|των|στο|στη|στην|στον|στα|στις|στους|σε|με|από|για)\b/u.test(lowerEl(text))) {
    return "";
  }
  text = shortenToChip(text);
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(
      /\s+(?:και|ή|του|της|των|το|τα|τις|τους|στο|στη|στην|στον|σε|με|από|για)$/iu,
      "",
    );
  }
  text = text.replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const directOk = text
    && !isCutOffFragment(text)
    && !isSocHeader(text)
    && !isFrequencyOnly(text)
    && !isTableFragment(text)
    && words.length > 0
    && words.length <= CHIP_MAX_WORDS
    && words.every((word) => word.length >= 3)
    && /[Α-Ωα-ωΆ-ώΪΫϊϋΐΰ]/u.test(text);
  const direct = directOk ? symptomChip(text) : "";
  if (direct) return capitalizeGreek(direct);
  const recovered = recoverEffectPhrase(raw);
  if (!recovered) return "";
  return capitalizeGreek(recovered);
}

/** When the words before a preposition are not an effect, keep a later effect name. */
function recoverEffectPhrase(raw) {
  let text = String(raw || "");
  text = text.replace(/\([^)]*\)/g, " ");
  text = text.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");
  text = text.replace(/[≥≤][^,.;]*/g, " ");
  text = text.replace(/[\d*†]+$/u, "");
  text = text.replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const phrase = words.slice(index, index + size).join(" ");
      const chip = symptomChip(phrase);
      if (chip) return chip;
    }
  }
  return "";
}

function foldedWord(word) {
  return foldFacts(word).replace(/[^\p{L}]/gu, "");
}

/** Drop connector words, then keep the phrase only when a real effect stem remains. */
function symptomChip(text) {
  const kept = String(text || "")
    .replace(/[.]+$/g, "")
    .split(/\s+/)
    .filter((word) => {
      const folded = foldedWord(word);
      return folded && !FILLER_WORDS.has(folded);
    });
  let phrase = kept.join(" ").trim();
  let previous = "";
  while (phrase && phrase !== previous) {
    previous = phrase;
    phrase = phrase
      .replace(/^(?:του|της|των|στο|στη|στην|στον|στα|στις|στους|σε|με|από|για|και|ή|να)\s+/iu, "")
      .replace(
        /\s+(?:πιθανώς|πιθανόν|να|συμπεριλαμβανομένου|συμπεριλαμβανομένης|συμπεριλαμβανομένων)$/iu,
        "",
      )
      .trim();
  }
  if (!phrase) return "";
  const folded = foldFacts(phrase);
  const stems = matchingStems(folded);
  if (stems.length === 0) return "";
  if (stems.length === 1 && stems[0] === "γαστρ") return "";
  if (/^γαστρεντερικ\p{L}*$/iu.test(phrase)) return "";
  if (
    /(?:^|\s)(?:είναι|εμφανισ\p{L}*|πιθανώς|πιθανόν|μπορεί|πρέπει|συνιστάται|έχει|έχουν|γίνει|συμβεί|προκαλέσει|εξαρτάται|φύσης)(?:\s|$)/iu.test(
      phrase,
    )
  ) {
    return "";
  }
  return phrase;
}

function matchingStems(folded) {
  const words = String(folded || "")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean);
  return SYMPTOM_STEMS.filter((stem) =>
    words.some((word) => {
      if (stem === "αλγ") {
        return word.startsWith("αλγ") || /αλγ(?:ος|ια|ιες|ους|ων)$/u.test(word);
      }
      return word.includes(stem);
    }),
  );
}


/** Keep a short effect name. Longer phrases survive only as the words before a preposition. */
function shortenToChip(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const boundary =
    /^(?:του|της|των|το|τα|τις|τους|στο|στη|στην|στον|στα|στις|στους|σε|με|από|για|και|ή)$/iu;
  const head = [];
  for (const word of words) {
    if (boundary.test(word)) break;
    head.push(word);
    if (head.length === CHIP_MAX_WORDS) break;
  }
  if (head.length === 0) return "";
  const next = words[head.length] || "";
  if (next && boundary.test(next)) return head.join(" ");
  if (words.length <= CHIP_MAX_WORDS) return words.join(" ");
  return "";
}

/**
 * Shorten a bullet so it ends on a whole word or sentence. Never slices inside a word.
 * `maxChars` counts the ellipsis.
 */
export function trimAtWordBoundary(text, maxChars) {
  const value = String(text ?? "")
    .replace(/…+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const limit = Number(maxChars);
  if (!value) return "";
  if (!Number.isFinite(limit) || limit < 1 || [...value].length <= limit) return value;
  const chars = [...value];
  const budget = Math.max(1, limit - 1);
  let idx = -1;
  const scanTo = Math.min(budget, chars.length) - 1;
  for (let i = scanTo; i >= 0; i--) {
    const ch = chars[i];
    if (ch === " " || ch === "." || ch === ";" || ch === "!" || ch === "·") {
      idx = i;
      break;
    }
  }
  let kept = "";
  if (idx <= 0) {
    const space = chars.indexOf(" ");
    if (space === -1) return value;
    kept = chars.slice(0, space).join("");
  } else {
    kept = chars.slice(0, idx).join("");
  }
  let previous = "";
  while (kept !== previous) {
    previous = kept;
    kept = kept.replace(/[\s.,;:·!]+$/u, "").replace(
      /\s+(?:και|ή|του|της|των|το|τα|τις|τους|στο|στη|στην|στον|σε|με|από|για)$/iu,
      "",
    );
  }
  kept = kept.trim();
  if (!kept) return "…";
  return `${kept}…`;
}

function collectSideEffects(text) {
  const labels = findLabels(text);
  const chunks = [];
  if (labels.length === 0) {
    chunks.push({ rank: null, text, intro: true });
  } else {
    chunks.push({ rank: null, text: text.slice(0, labels[0].index), intro: true });
    for (let i = 0; i < labels.length; i++) {
      const end = i + 1 < labels.length ? labels[i + 1].index : text.length;
      chunks.push({ rank: labels[i].rank, text: text.slice(labels[i].end, end), intro: false });
    }
  }

  const items = [];
  let order = 0;
  for (const chunk of chunks) {
    const sentences = chunk.text
      .split(/(?<=[.!;])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (isLegend(sentence) || isOverdose(sentence) || isTableFragment(sentence)) continue;
      const baseRank = chunk.intro ? introRank(sentence) : chunk.rank;
      for (const piece of splitPieces(sentence)) {
        const cleaned = cleanItem(piece);
        if (!cleaned) continue;
        const pct = percentRank(piece);
        const freqRank = pct == null ? baseRank : Math.min(baseRank, pct);
        items.push({
          text: cleaned,
          freqRank,
          serious: SERIOUS_EFFECT.test(cleaned),
          order: order++,
        });
      }
    }
  }
  return items;
}

function displayRank(item) {
  if (item.freqRank <= 1) return item.freqRank;
  if (item.serious) return 2;
  return item.freqRank + 1;
}

function fallbackBullet(text) {
  const sentences = text
    .split(/(?<=[.!;])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !isLegend(sentence));
  const preferred = sentences.filter((sentence) => !isOverdose(sentence));
  for (const sentence of [...preferred, ...sentences]) {
    const item = cleanItem(listBody(sentence));
    if (item) return item;
  }
  return "";
}

export function sideEffectsMoreLabel(hiddenCount) {
  return `+ ακόμη ${hiddenCount}`;
}

/** Short counter bullets from a stored SPC excerpt. Common effects lead; serious ones follow. */
export function sideEffectBullets(raw) {
  const text = stripSectionHeadings(
    String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!text || /^(?:n\/a|δεν αναφέρεται)$/iu.test(text)) return [];

  const ranked = collectSideEffects(text).sort(
    (a, b) => displayRank(a) - displayRank(b) || a.order - b.order,
  );
  const seen = new Set();
  const bullets = [];
  for (const item of ranked) {
    const key = foldFacts(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(item.text);
  }
  if (bullets.length > 0) return bullets;
  const fallback = fallbackBullet(text);
  return fallback ? [fallback] : [];
}

/**
 * Galinos stores about 200 characters and ends the cut with «...».
 * That teaser is not the effect list, even when a few names happen to sit in it.
 */
export function isTruncatedSideEffectTeaser(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || [...text].length > 240) return false;
  return /(?:\.{3}|…)\s*$/u.test(text);
}

/** True when the stored excerpt should not be the final card text. */
export function excerptNeedsRicherSource(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (isTruncatedSideEffectTeaser(text)) return true;
  return sideEffectBullets(text).length === 0;
}

export const RECOMMENDATION_MORE_LABEL = "+ περισσότερα";

/** Safety net when a suggestion is longer than about two lines. */
export const RECOMMENDATION_MAX_CHARS = 110;

/**
 * Keep a suggestion that fits the limit. A longer one ends on a whole word with «…».
 * `fits` is the layout check (about two lines). It never slices inside a word.
 */
export function clampRecommendation(text, options = {}) {
  const full = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!full) return "";
  const maxChars = Number(options.maxChars) || RECOMMENDATION_MAX_CHARS;
  const fits = typeof options.fits === "function" ? options.fits : () => true;
  if ([...full].length <= maxChars && fits(full)) return full;

  const words = full.split(/\s+/).filter(Boolean);
  let chosen = "";
  for (let count = 1; count <= words.length; count++) {
    const phrase = words.slice(0, count).join(" ");
    const partial = count < words.length || [...phrase].length > maxChars;
    const candidate = partial ? `${phrase}…` : phrase;
    if ([...candidate].length > maxChars || !fits(candidate)) break;
    chosen = candidate;
    if (!partial) break;
  }
  if (chosen) return chosen;
  const shortest = `${words[0]}…`;
  if ([...shortest].length <= maxChars) return shortest;
  return trimAtWordBoundary(full, maxChars);
}

/** Complete sentences, keeping the closing punctuation on each one. */
export function splitRecommendationSentences(raw) {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isStop = ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === ";" || ch === "\u037E";
    if (!isStop) continue;
    const next = text[i + 1] || "";
    if (next && !/\s/.test(next)) continue;
    const sentence = text.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * Collapsed view stays within about two lines and 110 characters.
 * Overflow ends on a whole word with «…». Expanded view is the full text.
 */
export function visibleRecommendation(raw, options = {}) {
  const expanded = Boolean(options.expanded);
  const fits = typeof options.fits === "function" ? options.fits : () => true;
  const sentences = splitRecommendationSentences(raw);
  const full = sentences.join(" ");
  if (!full) return { text: "", more: false, moreLabel: "" };
  if (expanded) return { text: full, more: false, moreLabel: "" };

  const text = clampRecommendation(full, { fits, maxChars: options.maxChars });
  const more = text !== full;
  return {
    text,
    more,
    moreLabel: more ? RECOMMENDATION_MORE_LABEL : "",
  };
}

export function visibleSideEffects(raw, expanded = false) {
  const all = sideEffectBullets(raw);
  if (expanded) return { bullets: all, hiddenCount: 0, moreLabel: "" };
  const bullets = all.slice(0, SIDE_EFFECT_VISIBLE_LIMIT);
  const hiddenCount = all.length - bullets.length;
  return {
    bullets,
    hiddenCount,
    moreLabel: hiddenCount > 0 ? sideEffectsMoreLabel(hiddenCount) : "",
  };
}

function foldFacts(value) {
  return String(value || "")
    .toLocaleLowerCase("el")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function normalizeAtc(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || raw === "N/A" || raw.includes("ΑΝΑΦΕΡ")) return "";
  const match = raw.match(/[A-Z]\d{2}[A-Z0-9]*/);
  return match ? match[0] : "";
}

/**
 * Local cross-sell categories. These mirror the strict ATC rules in
 * get-ai-recommendation and never call the model. A match only means the
 * collapsed row may show «💡», with the name «Πρόταση» on hover.
 */
const SUGGESTION_RULES = [
  {
    id: "antibiotic",
    atcPrefix: "J01",
    needles: [
      "augmentin",
      "amoxicillin",
      "amoxycillin",
      "αμοξικιλλινη",
      "αμοξυκιλλινη",
      "ciprofloxacin",
      "σιπροφλοξασινη",
      "hexaquin",
      "cefaclor",
      "κεφακλορη",
      "clarithromycin",
      "κλαριθρομυκινη",
      "zinadol",
    ],
  },
  {
    id: "statin",
    atcPrefix: "C10",
    needles: ["στατινη", "ατορβαστατινη", "ροσουβαστατινη", "σιμβαστατινη", "lipitor"],
    statin: true,
  },
  {
    id: "gastro",
    atcPrefix: "A02",
    needles: ["omeprazole", "ομεπραζολη", "pantoprazole", "παντοπραζολη"],
  },
  {
    id: "diabetes",
    atcPrefix: "A10",
    needles: ["metformin", "μετφορμινη"],
  },
];

function mentionsStatin(blob) {
  const stripped = blob.replace(/nystatin/g, " ");
  return /statin/.test(stripped);
}

function atcCandidates(drug) {
  const codes = [normalizeAtc(drug?.atcCode), normalizeAtc(drug?.activeIngredient)];
  return codes.filter((code, index) => code && codes.indexOf(code) === index);
}

export function suggestionRuleFor(drug) {
  const atcs = atcCandidates(drug);
  const blob = foldFacts(`${drug?.productName || ""} ${drug?.activeIngredient || ""}`);
  for (const rule of SUGGESTION_RULES) {
    if (atcs.some((code) => code.startsWith(rule.atcPrefix))) return { id: rule.id };
    if (rule.statin && mentionsStatin(blob)) return { id: rule.id };
    if (rule.needles.some((needle) => blob.includes(needle))) return { id: rule.id };
  }
  return null;
}

/**
 * Collapsed-row tag. «ready» is a real suggestion (local rule or AI text).
 * «pending» is still waiting. «none» is an answer that had nothing to offer.
 */
export function basketSuggestionKind(drug) {
  const text = String(drug?.recommendation || "").trim();
  if (text || suggestionRuleFor(drug)) return "ready";
  if (drug?.status === "done") return "none";
  return "pending";
}

/** A basket of two or more always keeps one card open. An empty choice opens the first. */
export function basketExpandedId(drugs, expandedId) {
  const list = Array.isArray(drugs) ? drugs.filter((drug) => drug && drug.id) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].id;
  if (expandedId && list.some((drug) => drug.id === expandedId)) return expandedId;
  return list[0].id;
}

export function likelySuggestion(drug) {
  return suggestionRuleFor(drug) != null;
}

/**
 * One expanded card. A new scan always takes the slot, even when the card
 * that was open matches a local suggestion rule. With no new scan, the card
 * that is already open stays open. Otherwise the newest product is shown.
 * The newest scan is first in the list.
 */
export function chooseExpandedId(drugs, options = {}) {
  const list = Array.isArray(drugs) ? drugs.filter((drug) => drug && drug.id) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].id;

  const addedId = options.addedId ?? null;
  if (addedId && list.some((drug) => drug.id === addedId)) return addedId;

  const previousExpandedId = options.previousExpandedId ?? null;
  if (previousExpandedId && list.some((drug) => drug.id === previousExpandedId)) {
    return previousExpandedId;
  }
  return list[0].id;
}

/** The drug that should be open after `addedId` is scanned onto the front of the list. */
export function openCardAfterScan(drugs, addedId, previousExpandedId) {
  const openId = chooseExpandedId(drugs, { addedId, previousExpandedId });
  return (Array.isArray(drugs) ? drugs : []).find((drug) => drug?.id === openId) || null;
}

/** Title, suggestion, and chips taken only from this drug. */
export function cardFacts(drug) {
  return {
    id: drug?.id ?? null,
    barcode: String(drug?.barcode ?? ""),
    productName: String(drug?.productName || ""),
    recommendation: drug?.recommendation == null ? null : String(drug.recommendation),
    chips: sideEffectBullets(drug?.sideEffects),
  };
}

export function sideEffectCountLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  if (n === 1) return "1 παρενέργεια";
  return `${n} παρενέργειες`;
}

/** Compact count for a collapsed row, so the dose stays on the name line. */
export function collapsedSideEffectCountLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return `${n} παρεν.`;
}

export function basketCountLabel(count) {
  const n = Number(count) || 0;
  if (n === 1) return "1 προϊόν";
  return `${n} προϊόντα`;
}

export function formatScanClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const DOSAGE_FORM_RULES = [
  [/αναβράζ|αναβρ\.?|effervescen/i, "Αναβράζοντα δισκία"],
  [/f\.?\s*c\.?\s*tab|film[-\s]?coated|επικαλυμμ/i, "Επικαλ. δισκία"],
  [/dispers/i, "Δισκία διασπειρόμενα"],
  [/\b(?:tabs?|δισκία|δισκίο)\b/i, "Δισκία"],
  [/\b(?:caps?(?:ules)?|καψάκια|κάψουλες)\b/i, "Καψάκια"],
  [/σιρόπ|σιροπι|\bsyr(?:up)?\b/i, "Σιρόπι"],
  [/\b(?:cream|κρέμα)\b/i, "Κρέμα"],
  [/\b(?:gel|γέλη)\b/i, "Γέλη"],
  [/\bspray\b|εκνέφωμα/i, "Εκνέφωμα"],
  [/σταγόν|drops\b|gutt/i, "Σταγόνες"],
  [/υπόθετ|\bsupp\b/i, "Υπόθετα"],
  [/ενέσιμ|\binj\b/i, "Ενέσιμο"],
];

export function dosageFormLabel(productName) {
  const raw = String(productName || "");
  for (const [pattern, label] of DOSAGE_FORM_RULES) {
    if (pattern.test(raw)) return label;
  }
  return "";
}

export function cardMetaLine({ formLabel = "", clock = "", index = 0, count = 0 } = {}) {
  const parts = [];
  if (count > 1 && index > 0) parts.push(`${index} από ${count}`);
  else if (formLabel) parts.push(formLabel);
  if (clock) parts.push(clock);
  return parts.join(" · ");
}

export function buildLatestJson({ version, signature, url, notes, pubDate }) {
  return {
    version,
    notes: notes || `PharmaBuddy ${version}`,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature,
        url,
      },
    },
  };
}
