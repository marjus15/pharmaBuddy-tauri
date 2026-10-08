import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OFFLINE_MESSAGE,
  REPORT_SENT_HINT,
  REPORT_SENT_MARK,
  UPDATE_NOTE,
  buildLatestJson,
  formatReportCode,
  reduceUpdateUi,
  reportStatusFor,
} from "../src/widget-logic.mjs";

test("sent report shows a phone code and closes instead of resending", () => {
  assert.equal(formatReportCode("a2b3"), "#A2B3");
  assert.equal(formatReportCode("#A2B3"), "#A2B3");
  const sent = reportStatusFor({ ok: true, reference_code: "A2B3" });
  assert.equal(sent.kind, "sent");
  assert.equal(sent.mark, REPORT_SENT_MARK);
  assert.equal(sent.mark, "✓ Στάλθηκε");
  assert.equal(sent.codeLabel, "Κωδικός αναφοράς: #A2B3");
  assert.equal(sent.hint, REPORT_SENT_HINT);
  assert.equal(sent.hint, "Αν τηλεφωνήσετε, πείτε αυτόν τον κωδικό.");
  assert.equal(sent.readOnly, true);
  assert.equal(sent.buttonLabel, "Κλείσιμο");
  assert.equal(sent.closeOnSend, true);
  assert.equal(sent.keepDraft, true);
});

test("offline report uses the existing copy and keeps the text", () => {
  const offline = reportStatusFor({
    ok: false,
    error_code: "offline",
    error_message: OFFLINE_MESSAGE,
  });
  assert.equal(offline.kind, "offline");
  assert.equal(offline.text, "Δεν υπάρχει σύνδεση στο internet");
  assert.equal(offline.keepDraft, true);
  assert.equal(offline.readOnly, false);
  assert.equal(offline.buttonLabel, "Αποστολή");
});

test("update ui never installs during the shift", () => {
  assert.equal(UPDATE_NOTE, "↻ Νέα έκδοση στο επόμενο άνοιγμα");
  const downloaded = reduceUpdateUi({ note: false }, { type: "downloaded" });
  assert.deepEqual(downloaded, { note: true, installNow: false });
  const later = reduceUpdateUi(downloaded, { type: "tick" });
  assert.equal(later.installNow, false);
  assert.equal(later.note, true);
});

test("latest.json points the windows updater at the signed installer", () => {
  const latest = buildLatestJson({
    version: "0.2.0",
    signature: "SIG",
    url: "https://github.com/marjus15/pharmaBuddy-tauri/releases/download/v0.2.0/pharmaBuddy_0.2.0_x64-setup.exe",
    notes: "PharmaBuddy 0.2.0",
    pubDate: "2026-10-08T12:00:00.000Z",
  });
  assert.equal(latest.version, "0.2.0");
  assert.equal(latest.platforms["windows-x86_64"].signature, "SIG");
  assert.match(latest.platforms["windows-x86_64"].url, /pharmaBuddy_0\.2\.0_x64-setup\.exe$/);
});

test("problem report migration and edge function stay pharmacy-scoped", () => {
  const sql = readFileSync("supabase/migrations/20261008160000_problem_reports.sql", "utf8");
  assert.match(sql, /create table if not exists public\.problem_reports/i);
  assert.match(sql, /pharmacy_id uuid not null references public\.pharmacies/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /reference_code/);
  const fn = readFileSync("supabase/functions/submit-problem-report/index.ts", "utf8");
  assert.match(fn, /authorizePharmacy/);
  assert.match(fn, /reference_code: code/);
  assert.match(fn, /pharmacy_id: auth\.pharmacyId/);
  assert.doesNotMatch(fn, /body\.pharmacy_id/);
});

test("widget copy and the two polish rules are in the ui", () => {
  const html = readFileSync("src/index.html", "utf8");
  const css = readFileSync("src/style.css", "utf8");
  const js = readFileSync("src/main.js", "utf8");
  assert.match(html, /Αναφορά προβλήματος/);
  assert.match(html, /Τι έγινε;/);
  assert.match(html, /id="report-message"/);
  assert.match(html, /id="update-note"/);
  assert.match(html, /id="settings-logout-sep"/);
  assert.match(html, /Θέλετε να αποσυνδεθείτε; Θα χρειαστεί ξανά ο κωδικός\./);
  assert.match(html, /id="logout-cancel"[\s\S]*Άκυρο/);
  assert.match(html, /id="logout-confirm-btn"[\s\S]*Αποσύνδεση/);
  assert.match(js, /submit_problem_report/);
  assert.match(js, /get_update_notice/);
  assert.match(js, /if \(reportLocked\) resetReportComposer\(\)/);
  assert.match(js, /openLogoutConfirm\(\)/);
  assert.match(css, /\.update-note \{[^}]*font-size:\s*12px/);
  assert.match(css, /\.update-note \{[^}]*border:\s*none/);
  assert.match(css, /\.update-note \{[^}]*background:\s*none/);
  assert.match(css, /\.settings-divider \{/);
  assert.match(css, /\.report-sent-code \{[^}]*font-size:\s*18px/);
  assert.match(css, /\.report-sent-code \{[^}]*monospace/);
  assert.match(css, /\.orb-dock\.has-update-note \{[^}]*width:\s*308px/);
  assert.match(css, /\.drug-item:first-child \.drug-name-btn \{[^}]*padding-right:\s*48px;/);
  assert.match(css, /\.login-error \{[^}]*height:\s*calc\(1\.35em \* 3\)/);
  assert.match(css, /\.login-btn \{[^}]*margin-top:\s*0;/);
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.version, conf.version);
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.match(conf.plugins.updater.endpoints[0], /latest\.json$/);
  assert.equal(conf.plugins.updater.windows.installMode, "passive");
});
