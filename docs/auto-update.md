# Auto-update

The widget uses the official Tauri v2 updater (`tauri-plugin-updater`) with the free minisign update key. This is not Windows code signing. SmartScreen still appears on the first install.

The app checks GitHub Releases in the background when it starts, then about every 3 hours. It never installs or restarts during a shift. When a package has downloaded, the orb shows one line under the pharmacy name: «↻ Νέα έκδοση στο επόμενο άνοιγμα». The next time the pharmacist opens the app, the NSIS installer runs before the window opens (`/P /UPDATE /R`) and starts the new version.

The login session stays in Windows Credential Manager (or the app-data fallback file). The updater does not delete that file or the remembered username. Logs stay in `%LOCALAPPDATA%\pharmaBuddy`.

A backup build compiled with `PHARMABUDDY_REQUIRE_LOGIN=false` does not check for updates and does not install a pending package. That keeps it from being replaced by the normal login release. TEST versus PROD is only the data profile; it does not change this.

## 1. Generate the key pair once

On your machine (Git Bash or PowerShell):

```powershell
cd pharmaBuddy-tauri
npm install
npx tauri signer generate -w $env:USERPROFILE\.tauri\pharmabuddy.key
```

The command asks for a password. It writes:

- `%USERPROFILE%\.tauri\pharmabuddy.key` — private key. This never goes in git.
- `%USERPROFILE%\.tauri\pharmabuddy.key.pub` — public key.

The CLI also prints the public key string. That string is what the app expects.

**Keep an offline backup of the private key and the password** (a USB drive that is not the pharmacy PC, or a password manager export). If you lose them, every pharmacy that already installed the app can no longer verify updates. You would have to hand them a new installer. Generating a new key does not fix old installs.

The pubkey currently in `src-tauri/tauri.conf.json` is the placeholder `REPLACE_WITH_MINISIGN_PUBKEY`. Replace it with the public key the CLI printed:

```json
"plugins": {
  "updater": {
    "pubkey": "<paste the public key here>",
    "endpoints": [
      "https://github.com/marjus15/pharmaBuddy-tauri/releases/latest/download/latest.json"
    ]
  }
}
```

Commit that pubkey change. Do not commit the `.key` file.

## 2. GitHub secrets

Repo → Settings → Secrets and variables → Actions → New repository secret.

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The entire contents of `pharmabuddy.key` (including the `untrusted comment` lines). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you typed when generating the key. |
| `SUPABASE_FUNCTIONS_URL` | Already used by the release build. |
| `SUPABASE_ANON_KEY` | Already used by the release build. |

The private key in GitHub is not a backup. If the GitHub secret is deleted, you still need the offline copy.

## 3. Cut a release

1. Bump the same version in all three places:
   - `src-tauri/tauri.conf.json` (`version`)
   - `src-tauri/Cargo.toml` (`version`)
   - `package.json` (`version`)
2. Merge to `master`.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on that push. It builds the Windows installer with the Supabase values baked in, signs the update with the two Tauri secrets, and publishes a GitHub Release tagged `v<version>` with:

- `pharmaBuddy_<version>_x64-setup.exe` (the file the updater downloads)
- `pharmaBuddy_x64-setup.exe` (same bytes, stable name for a manual download)
- `latest.json`

The tag must be new. If `v0.1.0` already exists, bump the version before merging.

## 4. First install on a pharmacy PC

There is no Authenticode certificate, so Windows SmartScreen says the app is unrecognized.

1. Run `pharmaBuddy_x64-setup.exe`.
2. On the blue SmartScreen window, choose **More info**.
3. Choose **Run anyway**.
4. Finish the installer and sign in once.

Later updates are signed with the minisign key, not with a Windows certificate. SmartScreen can still appear when the updater runs the next installer. Use the same **More info → Run anyway** step if it does. Code signing is out of scope.
