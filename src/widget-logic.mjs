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
