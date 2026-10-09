export const OFFLINE_MESSAGE = "Δεν υπάρχει σύνδεση στο internet";
export const UPDATE_NOTE = "↻ Νέα έκδοση στο επόμενο άνοιγμα";
export const REPORT_SENT_MARK = "✓ Στάλθηκε";
export const REPORT_SENT_HINT = "Πείτε αυτόν τον κωδικό στον υπεύθυνο του PharmaBuddy.";
export const INACTIVE_PHARMACY_MESSAGE =
  "Ο λογαριασμός του φαρμακείου είναι ανενεργός. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.";
export const UNASSIGNED_PHARMACY_MESSAGE =
  "Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.";

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

export const SIDE_EFFECTS_TRUST_LINE =
  "Βοηθητικές πληροφορίες. Η τελική απόφαση ανήκει στον φαρμακοποιό.";

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

const MAX_BULLET_WORDS = 5;

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

function isSentenceStart(text, index) {
  const prev = text.slice(0, index).trimEnd();
  return prev.length === 0 || /[.!;]$/.test(prev);
}

function nextWord(text) {
  const match = String(text || "")
    .trimStart()
    .match(/^[\p{L}]+/u);
  return match ? lowerEl(match[0]) : "";
}

function isLegend(sentence) {
  const lower = lowerEl(sentence);
  if (/[≥≤]/.test(sentence)) return true;
  return /ταξινομ|ορίζοντ|κατηγορία οργανικού|προφίλ ασφάλειας|παρατίθενται παρακάτω|δεν μπορούν να εκτιμηθούν/.test(
    lower,
  );
}

function isOverdose(sentence) {
  return /υπερδοσ|υπερβολικ\p{L}*\s+δόση/iu.test(sentence);
}

function isSocHeader(text) {
  return /^διαταραχ(?:ές|ών|ή)\b/iu.test(text);
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
      const adverbOk = isSentenceStart(text, i) && !ADVERB_STOP.has(nextWord(trimmed));
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
  let text = String(raw || "");
  text = text.replace(/\([^)]*\)/g, " ");
  text = text.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");
  text = text.replace(/[≥≤][^,.;]*/g, " ");
  text = text.replace(
    /^(?:πολύ\s+συχν\p{L}*|όχι\s+συχν\p{L}*|πολύ\s+σπάνι\p{L}*|μη\s+γνωστής\s+συχνότητας|σπάνι\p{L}*|συχν\p{L}*)\s*[:.]?\s*/iu,
    "",
  );
  text = text.replace(/[…]+/g, " ");
  text = text.replace(/^(?:και|ή)\s+/iu, "");
  text = text.replace(/^[\s\-–—:.,;]+|[\s\-–—:.,;]+$/g, "");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\s+σε\s+(?:μικρό|μεγάλο)\s+ποσοστό(?:\s+ασθεν\p{L}*)?$/iu, "");
  text = text.replace(/^(?:η|ο|το|οι|τα)\s+/iu, "");
  text = text.replace(/[.]+$/g, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  if (!text || isSocHeader(text) || isFrequencyOnly(text) || isLegend(text)) return "";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > MAX_BULLET_WORDS) text = words.slice(0, MAX_BULLET_WORDS).join(" ");
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(
      /\s+(?:και|ή|του|της|των|το|τα|τις|τους|στο|στη|στην|στον|σε|με|από|για)$/iu,
      "",
    );
  }
  if (text.length < 3 || !/[Α-Ωα-ωΆ-ώΪΫϊϋΐΰ]/u.test(text)) return "";
  return capitalizeGreek(text);
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
      if (isLegend(sentence) || isOverdose(sentence)) continue;
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
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
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
