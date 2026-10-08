export const OFFLINE_MESSAGE = "Δεν υπάρχει σύνδεση στο internet";
export const UPDATE_NOTE = "Νέα έκδοση, θα εγκατασταθεί στο επόμενο άνοιγμα";
export const REPORT_SENT_PREFIX = "Στάλθηκε · #";

export function formatReportSent(code) {
  const clean = String(code || "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
  return `${REPORT_SENT_PREFIX}${clean}`;
}

export function reportStatusFor(result) {
  if (result?.ok && result.reference_code) {
    return {
      kind: "sent",
      text: formatReportSent(result.reference_code),
      keepDraft: true,
    };
  }
  const code = String(result?.error_code || "");
  const message = String(result?.error_message || "");
  if (code === "offline" || message === OFFLINE_MESSAGE) {
    return { kind: "offline", text: OFFLINE_MESSAGE, keepDraft: true };
  }
  return {
    kind: "error",
    text: message || "Η αναφορά δεν στάλθηκε. Δοκιμάστε ξανά.",
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
