# Progress

## 2026-10-09 — First signed release (v0.2.0)

- `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` is the minisign public key. The placeholder is gone.
- Version `0.2.0` is set in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `package.json`, and `package-lock.json`.
- `docs/auto-update.md` says the pubkey is set. The release workflow tags `v0.2.0` and writes `latest.json` against the signed installer. The workflow file was not rewritten.

## 2026-10-08 — Unassigned login copy

- The no-pharmacy line is exactly «Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.» The inactive-account line is unchanged.

## 2026-10-08 — No support phone in the pilot

- The inactive-account line is exactly «Ο λογαριασμός του φαρμακείου είναι ανενεργός. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.»
- An account with no pharmacy says «Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.»
- A sent report says «Πείτε αυτόν τον κωδικό στον υπεύθυνο του PharmaBuddy.» There is no support number on that panel.
- `PHARMABUDDY_SUPPORT_CONTACT` is gone from Rust, JS, `.env.example`, the compile-time env map, and the docs. The release workflow never baked that variable in.
- The login error slot stays four lines tall so the longer inactive message fits and the card does not jump.

## 2026-10-08 — UI review on reports, update note, logout

- The update line sits inside the glass card, under the pharmacy-name pill. Copy is «↻ Νέα έκδοση στο επόμενο άνοιγμα» at 12px, with no border of its own. The card and window grow while a download is waiting so the line is not clipped.
- A sent report shows «✓ Στάλθηκε», a large monospace «Κωδικός αναφοράς: #…», and a short hint under the code. The note is read-only and the button is «Κλείσιμο». Opening the panel again starts empty.
- «Αποσύνδεση» is separated from «Αναφορά προβλήματος» by a divider. Logout asks «Θέλετε να αποσυνδεθείτε; Θα χρειαστεί ξανά ο κωδικός.» with «Άκυρο» focused and «Αποσύνδεση» to confirm.

## 2026-10-08 — Problem reports, signed auto-update, two UI fixes

- Gear menu «Αναφορά προβλήματος» opens a panel with optional «Τι έγινε;». Send uploads a redacted log tail, version, PROD/TEST, and OS. The edge function `submit-problem-report` stores it on `problem_reports` for the JWT's pharmacy and returns a reference code («Στάλθηκε · #…»). Offline keeps the text. TEST and `PHARMABUDDY_REQUIRE_LOGIN=false` save a local file instead of calling Supabase.
- Migration `supabase/migrations/20261008160000_problem_reports.sql` is not applied to the live project from this change. Steps are in `docs/problem-reports.md`.
- Tauri updater checks in the background and only installs on the next launch. The orb shows «Νέα έκδοση, θα εγκατασταθεί στο επόμενο άνοιγμα». The release workflow signs with `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and uploads `latest.json`. Backup builds do not auto-update. See `docs/auto-update.md`.
- Login card no longer stretches the password-to-«Είσοδος» gap; the error line is three lines tall. The scan chip keeps 48px of padding so the × does not cover the barcode.

## 2026-10-08 — Login and panel UI review

- Login button stays «Είσοδος» (accented). While signing in it is disabled and reads «Σύνδεση…». Enter in the password field submits the form, and a second submit is ignored until the first finishes.
- The login card is a fixed size. The error line keeps its space so wrong-password, offline, and inactive states do not move the card.
- Inactive pharmacies stay on the login card. The support-phone wording from this pass was removed the same day (see the entry above).
- Subtitle is «Τα στοιχεία σύνδεσης σάς τα δίνει η PharmaBuddy.» The pharmacy name sits centered under «PharmaBuddy AI», inside the card, at 12px.
- Recommendation and error panels use rounded corners on every side, with a gap before the orb. The SPC source line is 12px with higher contrast. The close control is 24px in the panel’s top-right corner.
- A PROD catalog miss says «Το προϊόν δεν βρέθηκε στον κατάλογο. Σκανάρετε ξανά ή πληκτρολογήστε τον κωδικό.» TEST still uses its «Δοκιμαστικό» label. The error panel shows that message, not the raw API body.

## 2026-10-08 — Per-pharmacy login

- PROD shows a Greek login screen (email/username, password with eye toggle, remembered username) when there is no valid Supabase session. Logout sits in the gear menu. The pharmacy name is shown at the lower left of the orb.
- The session is stored in the OS keychain (app-data file only if the keychain is unavailable) and the access token refreshes during a shift.
- Edge functions `get-ai-recommendation` and `cache-catalog-entry` require a user JWT, resolve `pharmacy_members`, reject inactive pharmacies, and log `pharmacy_id` plus user id. `ALLOW_LEGACY_ANON=true` is the server-side backup for the old anon-key build.
- Migration `supabase/migrations/20261008120000_pharmacy_login.sql` adds `pharmacies.active` and `pharmacy_members` with RLS. Not applied to the live project from this change.
- `scripts/create-pharmacy-user.mjs` creates a pharmacy and its login with the service-role key from the environment. `PHARMABUDDY_REQUIRE_LOGIN=false` keeps a no-login PROD build. TEST stays mock-only.
- Deploy and first-account steps are in `docs/pharmacy-login.md`.

## 2026-10-05 — Side effects of the scanned medicine

- After a scan, the widget loads the public Galinos SPC excerpt under «Ανεπιθύμητες ενέργειες» and shows it under the medicine name.
- The excerpt is stored on `global_product_catalog.metadata.side_effects` (existing rows are updated only when that field is empty).
- `cache-catalog-entry` version 4 is deployed with that merge.
- The recommendation request includes the excerpt. The function source in `supabase/functions/get-ai-recommendation` tells the model to mention one relevant adverse effect and not to invent one.
