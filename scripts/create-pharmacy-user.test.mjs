import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs, validateArgs } from "./create-pharmacy-user.mjs";

test("create args require name, email, and password", () => {
  const args = parseArgs([
    "--name",
    "Φαρμακείο Παπαδόπουλος",
    "--email",
    "pilot@example.com",
    "--password",
    "long-secret",
  ]);
  assert.equal(args.name, "Φαρμακείο Παπαδόπουλος");
  assert.equal(args.email, "pilot@example.com");
  assert.doesNotThrow(() => validateArgs(args));
});

test("short password and missing email are rejected", () => {
  assert.throws(
    () => validateArgs(parseArgs(["--name", "A", "--email", "pilot@example.com", "--password", "short"])),
    /8 characters/,
  );
  assert.throws(
    () => validateArgs({ name: "A", email: "pilot", password: "long-secret" }),
    /email/i,
  );
});

test("deactivate requires a pharmacy id or email", () => {
  const args = parseArgs(["--deactivate", "--pharmacy-id", "11111111-1111-1111-1111-111111111111"]);
  assert.equal(args.deactivate, true);
  assert.equal(args.pharmacyId, "11111111-1111-1111-1111-111111111111");
  assert.doesNotThrow(() => validateArgs(args));
  assert.throws(() => validateArgs({ deactivate: true }), /pharmacy-id or --email/);
});

test("migration defines pharmacies, members, and rls", () => {
  const sql = readFileSync("supabase/migrations/20261008120000_pharmacy_login.sql", "utf8");
  assert.match(sql, /create table if not exists public\.pharmacies/i);
  assert.match(sql, /active boolean/);
  assert.match(sql, /pharmacy_members/);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth\.uid\(\)/);
  assert.doesNotMatch(sql, /service_role/i);
});

test("widget shows the three greek login errors", () => {
  const js = [readFileSync("src/main.js", "utf8"), readFileSync("src/widget-logic.mjs", "utf8")].join("\n");
  const html = readFileSync("src/index.html", "utf8");
  const rust = readFileSync("src-tauri/src/auth_session.rs", "utf8");
  assert.match(js, /Λάθος στοιχεία/);
  assert.match(js, /Δεν υπάρχει σύνδεση στο internet/);
  assert.match(
    js,
    /Ο λογαριασμός του φαρμακείου είναι ανενεργός\. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy\./,
  );
  assert.match(
    rust,
    /Ο λογαριασμός του φαρμακείου είναι ανενεργός\. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy\./,
  );
  assert.match(
    js,
    /Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο\. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy\./,
  );
  assert.doesNotMatch(js, /69XX/);
  assert.doesNotMatch(js, /PHARMABUDDY_SUPPORT_CONTACT/);
  assert.doesNotMatch(js, /επικοινωνήστε στο/);
  assert.match(js, /Σύνδεση…/);
  assert.match(
    js,
    /Το προϊόν δεν βρέθηκε στον κατάλογο\. Σκανάρετε ξανά ή πληκτρολογήστε τον κωδικό\./,
  );
  assert.match(html, /Τα στοιχεία σύνδεσης σάς τα δίνει η PharmaBuddy\./);
  assert.match(html, /Είσοδος/);
  assert.equal(html.includes("Εισοδος"), false);
  assert.match(html, /login-password-toggle/);
  assert.match(html, /Αποσύνδεση/);
});

test("support phone plumbing is gone from the widget build", () => {
  const files = [
    "src/main.js",
    "src/widget-logic.mjs",
    "src/style.css",
    "src/index.html",
    "src-tauri/src/auth_session.rs",
    "src-tauri/src/env_config.rs",
    "src-tauri/build.rs",
    "README.md",
    ".env.example",
    "docs/pharmacy-login.md",
    "docs/problem-reports.md",
    ".github/workflows/release.yml",
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /PHARMABUDDY_SUPPORT_CONTACT/, file);
    assert.doesNotMatch(text, /69XX/, file);
    assert.doesNotMatch(text, /τηλεφωνήσετε/, file);
  }
});
