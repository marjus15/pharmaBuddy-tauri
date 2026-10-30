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

/** No scan and no basket interaction for this long starts a new customer. */
export const CUSTOMER_IDLE_MS = 2 * 60 * 1000;

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

/** The visit stack stays in scan order. The latest card is the last one. */
export function latestDrugId(drugs) {
  if (!Array.isArray(drugs) || drugs.length === 0) return null;
  return drugs[drugs.length - 1]?.id ?? null;
}

export const SIDE_EFFECT_VISIBLE_LIMIT = 5;

const CHIP_MAX_WORDS = 3;

const FREQUENCY_LABELS = [
  ["μη γνωστής συχνότητας", 6],
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

function splitPieces(sentence) {
  const pieces = [];
  for (const chunk of splitTopLevel(listBody(sentence))) {
    pieces.push(...splitConjunctions(chunk));
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
  if (!text) return "";
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(
      /\s+(?:και|ή|του|της|των|το|τα|τις|τους|στο|στη|στην|στον|σε|με|από|για)$/iu,
      "",
    );
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || isCutOffFragment(text) || isSocHeader(text) || isFrequencyOnly(text) || isTableFragment(text)) {
    return "";
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > CHIP_MAX_WORDS) return "";
  if (words.some((word) => word.length < 3)) return "";
  if (text.length < 3 || !/[Α-Ωα-ωΆ-ώΪΫϊϋΐΰ]/u.test(text)) return "";
  return capitalizeGreek(text);
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
    const key = lowerEl(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(item.text);
  }
  if (bullets.length > 0) return bullets;
  const fallback = fallbackBullet(text);
  return fallback ? [fallback] : [];
}

export const RECOMMENDATION_MORE_LABEL = "+ περισσότερα";

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
 * Collapsed view is whole sentences only: the first two when they fit in three
 * lines, otherwise the longest complete prefix that fits. A sentence that is
 * itself longer than three lines is shown whole. Expanded view is the full text.
 */
export function visibleRecommendation(raw, options = {}) {
  const expanded = Boolean(options.expanded);
  const fits = typeof options.fits === "function" ? options.fits : () => true;
  const sentences = splitRecommendationSentences(raw);
  const full = sentences.join(" ");
  if (!full) return { text: "", more: false, moreLabel: "" };
  if (expanded) return { text: full, more: false, moreLabel: "" };

  let chosen = "";
  const limit = Math.min(2, sentences.length);
  for (let count = 1; count <= limit; count++) {
    const candidate = sentences.slice(0, count).join(" ");
    if (count > 1 && !fits(candidate)) break;
    chosen = candidate;
    if (count === 1 && !fits(candidate)) break;
  }
  if (!chosen) chosen = sentences[0];
  const more = chosen !== full;
  return {
    text: chosen,
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
 * collapsed row may show «💡 Πρόταση».
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
    needles: ["στατινη", "ατορβαστατινη", "ροσουβαστατινη", "σιμβαστατινη"],
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

export function suggestionRuleFor(drug) {
  const atc = normalizeAtc(drug?.atcCode);
  const blob = foldFacts(`${drug?.productName || ""} ${drug?.activeIngredient || ""}`);
  for (const rule of SUGGESTION_RULES) {
    if (atc.startsWith(rule.atcPrefix)) return { id: rule.id };
    if (rule.statin && mentionsStatin(blob)) return { id: rule.id };
    if (rule.needles.some((needle) => blob.includes(needle))) return { id: rule.id };
  }
  return null;
}

export function likelySuggestion(drug) {
  return suggestionRuleFor(drug) != null;
}

/**
 * One expanded card. A newly scanned product that matches a local rule takes
 * the slot. Otherwise a product that already matches stays open. With no
 * match, the product just scanned is the one shown.
 */
export function chooseExpandedId(drugs, options = {}) {
  const list = Array.isArray(drugs) ? drugs.filter((drug) => drug && drug.id) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].id;

  const addedId = options.addedId ?? null;
  const previousExpandedId = options.previousExpandedId ?? null;
  const added = addedId ? list.find((drug) => drug.id === addedId) : null;
  if (added && likelySuggestion(added)) return added.id;

  const previous = previousExpandedId
    ? list.find((drug) => drug.id === previousExpandedId)
    : null;
  if (previous && likelySuggestion(previous)) return previous.id;

  const likely = list.find((drug) => likelySuggestion(drug));
  if (likely) return likely.id;

  if (added) return added.id;
  if (previous) return previous.id;
  return list[list.length - 1].id;
}

export function sideEffectCountLabel(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  if (n === 1) return "1 παρενέργεια";
  return `${n} παρενέργειες`;
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
