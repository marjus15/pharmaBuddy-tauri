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
  const js = readFileSync("src/main.js", "utf8");
  const html = readFileSync("src/index.html", "utf8");
  assert.match(js, /Λάθος στοιχεία/);
  assert.match(js, /Δεν υπάρχει σύνδεση στο internet/);
  assert.match(js, /Ο λογαριασμός του φαρμακείου είναι ανενεργός, επικοινωνήστε στο/);
  assert.match(js, /69XX\\u00A0XXX\\u00A0XXX/);
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
