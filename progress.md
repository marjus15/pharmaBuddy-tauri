# Progress

## 2026-10-08 — Login and panel UI review

- Login button stays «Είσοδος» (accented). While signing in it is disabled and reads «Σύνδεση…». Enter in the password field submits the form, and a second submit is ignored until the first finishes.
- The login card is a fixed size. The error line keeps its space so wrong-password, offline, and inactive states do not move the card.
- Inactive pharmacies show «επικοινωνήστε στο …». `PHARMABUDDY_SUPPORT_CONTACT` supplies the number. Until the real number is set, the placeholder is `69XX XXX XXX` (documented in `docs/pharmacy-login.md`).
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
