# Pharmacy login

Each pilot pharmacy gets its own email and password. The widget does not offer signup. Marios creates the account, then the pharmacist signs in once on the store PC. The session is kept in the Windows Credential Manager (or, if that is unavailable, in the user app-data folder — not in the git repo) and the access token refreshes on its own during a shift.

TEST profile stays on mock data and does not ask for a login.

## What you run before the first login build

Do this in order. These steps are not applied from the repo automatically.

1. **Migration.** In the Supabase SQL editor, run [`supabase/migrations/20261008120000_pharmacy_login.sql`](../supabase/migrations/20261008120000_pharmacy_login.sql). It adds `pharmacies.active` (the kill switch) and `pharmacy_members` (user → pharmacy), with RLS so a user can read only their own pharmacy. Existing catalog tables are left as they are. If `pharmacies` already exists, the script adds the missing columns and backfills `active` from a legacy `status` column when that column is present.

2. **Turn off public signup.** Supabase Dashboard → Authentication → Providers → Email → disable “Allow new users to sign up”. Password login stays on. The admin script uses the service role, so it can still create users.

3. **Deploy the edge functions** after the migration:

   ```powershell
   supabase functions deploy get-ai-recommendation
   supabase functions deploy cache-catalog-entry
   ```

   Both functions reject calls that do not carry a valid user JWT. They load the user’s pharmacy and reject the call when `pharmacies.active` is false. Each recommendation call logs `pharmacy_id` and `user_id`.

4. **Widget env** (`.env`, not committed):

   | Variable | Purpose |
   | --- | --- |
   | `SUPABASE_FUNCTIONS_URL` | `https://<project>.supabase.co/functions/v1/get-ai-recommendation` |
   | `SUPABASE_ANON_KEY` | Public anon key. Sent as the `apikey` header. It is not the user session. |
   | `PHARMABUDDY_REQUIRE_LOGIN` | Default is login required. Set `false` only for a backup build (see below). |
   | `PHARMABUDDY_LOGIN_EMAIL_DOMAIN` | Optional. If the pharmacist types a username with no `@`, the widget appends `@<domain>`. |

   For a release binary, the same values can be baked in at compile time (`SUPABASE_FUNCTIONS_URL`, `SUPABASE_ANON_KEY`, `PHARMABUDDY_REQUIRE_LOGIN`, `PHARMABUDDY_LOGIN_EMAIL_DOMAIN`).

5. **Service role, only on your machine, only for the script.**

   ```powershell
   $env:SUPABASE_URL = "https://<project>.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY = "<service-role-key>"
   ```

   Do not put the service-role key in the widget `.env` that ships to a pharmacy, and do not commit it.

## Create the first pharmacy login

```powershell
node scripts/create-pharmacy-user.mjs `
  --name "Φαρμακείο Παπαδόπουλος" `
  --email pilot@example.com `
  --password "a-long-secret"
```

The script creates a confirmed auth user, a `pharmacies` row with `active = true`, and a `pharmacy_members` row. Give the pharmacy the email and password. The script does not print the password again.

On the widget (PROD), the pharmacist enters that email and password. The pharmacy name appears centered under «PharmaBuddy AI», inside the orb card. Logout is under the gear menu, not on the orb itself. The username is remembered; the password is not.

Wrong password shows «Λάθος στοιχεία». No network shows «Δεν υπάρχει σύνδεση στο internet». An inactive pharmacy shows «Ο λογαριασμός του φαρμακείου είναι ανενεργός. Επικοινωνήστε με τον υπεύθυνο του PharmaBuddy.» There is no support phone in the pilot. An account that is not linked to a pharmacy shows «Ο λογαριασμός δεν είναι συνδεδεμένος με φαρμακείο. Αναφορά προβλήματος ή καλέστε τον υπεύθυνο του PharmaBuddy.»

## Deactivate a pharmacy

Either:

```powershell
node scripts/create-pharmacy-user.mjs --deactivate --email pilot@example.com
```

```powershell
node scripts/create-pharmacy-user.mjs --deactivate --pharmacy-id <uuid>
```

or SQL:

```sql
update public.pharmacies
set active = false
where id = '<uuid>';
```

The next recommendation or lookup from that login is rejected. Turn it back on with `--activate` or `set active = true`.

## Backup build (no login)

Default PROD builds require login. To build the previous behaviour (shared anon key, license screen, no login) set this before `npm run tauri build`:

```powershell
$env:PHARMABUDDY_REQUIRE_LOGIN = "false"
```

That binary works with the **currently deployed** functions (before step 3). After you deploy the new functions, they reject the anon key unless you set the function secret `ALLOW_LEGACY_ANON=true`. Leave that secret unset once the login build is the one in the store. TEST builds never ask for a login, regardless of the flag.

The backup build also skips auto-update, so it is not replaced by the login release. See [auto-update.md](auto-update.md). Problem reports are in [problem-reports.md](problem-reports.md).
