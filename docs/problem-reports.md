# Αναφορά προβλήματος

The gear menu has «Αναφορά προβλήματος». One click opens a small panel. «Τι έγινε;» is optional. Send uploads the recent widget log (last session, capped at 48 KB), the app version, PROD or TEST, and the OS, tied to the signed-in pharmacy.

The pharmacist sees «Στάλθηκε · #A2B3» (four characters, no `0`, `O`, `1`, or `I`). No network shows «Δεν υπάρχει σύνδεση στο internet» and the text stays so they can retry. TEST, and a PROD build made with `PHARMABUDDY_REQUIRE_LOGIN=false`, do not call Supabase: they write `%LOCALAPPDATA%\pharmaBuddy\problem-reports\<code>.json` and still show a code.

Passwords, bearer tokens, and JWTs are removed before anything is stored or uploaded. The edge function ignores any pharmacy id in the body and uses the user JWT.

## What you run

Do this after the pharmacy-login migration. Nothing here is applied to the live project from the repo.

1. **Migration.** In the Supabase SQL editor, run [`supabase/migrations/20261008160000_problem_reports.sql`](../supabase/migrations/20261008160000_problem_reports.sql). It creates `problem_reports` with RLS. A pharmacist can read only their pharmacy's rows. Inserts are not allowed from the widget; the service role bypasses RLS.

2. **Deploy the function:**

   ```powershell
   supabase functions deploy submit-problem-report
   ```

   It uses the same user-JWT check as `get-ai-recommendation`. `ALLOW_LEGACY_ANON` does not accept reports: there is no pharmacy user on that path.

3. **No new widget secret.** The existing `SUPABASE_FUNCTIONS_URL` and `SUPABASE_ANON_KEY` are enough. The report URL is derived by swapping the function name.
