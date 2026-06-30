# pharmaBuddy Tauri Widget

Borderless, transparent, always-on-top AI orb desktop widget for Greek pharmacies. Ports the WinUI `pharmaBuddy` app to **Tauri v2** (Vanilla HTML/CSS/JS + Rust).

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- **Rust + Cargo** (required — `npm run tauri build` calls `cargo`)
- [Tauri prerequisites (Windows)](https://v2.tauri.app/start/prerequisites/) — MSVC Build Tools, WebView2

### Install Rust on Windows

If you see `program not found` for `cargo metadata`:

```powershell
winget install Rustlang.Rustup --accept-package-agreements --accept-source-agreements
```

Close and reopen your terminal (or add `%USERPROFILE%\.cargo\bin` to PATH), then verify:

```powershell
cargo --version
rustc --version
```

Default toolchain: `rustup default stable`

## Setup

```powershell
git clone https://github.com/marjus15/pharmaBuddy-tauri.git
cd pharmaBuddy-tauri
npm install
copy .env.example .env
# Edit .env with your Supabase keys for PROD mode
```

## Run

```powershell
npm run dev
# or
npm run tauri dev
```

## Build

```powershell
npm run build
# or
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`

## Configuration

| Variable                           | Purpose                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PHARMABUDDY_PROFILE`              | `test` (mock) or `prod` (Supabase)                                                                                     |
| `PHARMABUDDY_SCANNER_THRESHOLD_MS` | Max gap between scanner keystrokes before the hook buffer clears (default `400`; try `800` for slow/wireless scanners) |
| `SUPABASE_FUNCTIONS_URL`           | Full edge function URL (prod only)                                                                                     |
| `SUPABASE_ANON_KEY`                | Bearer token (prod only)                                                                                               |

Profile is also stored in `%LOCALAPPDATA%\pharmaBuddy\profile.txt` (shared with WinUI app). Click the **TEST** / **PROD** badge under the orb to toggle.

## Barcode input

- **Production:** global Windows low-level keyboard hook (works while POS/other apps are focused).
- **Dev fallback:** focus the hidden `#scan-fallback` input (e.g. via DevTools) and paste/type a barcode + Enter. Supports 13-digit EAN, plain GS1 DataMatrix, and long ASCII-triplet encoded GS1 strings (100+ digits; whitespace/newlines are stripped automatically).

Under the orb, two debug lines help diagnose real scanner issues:

- **Scan line** — last accepted/rejected barcode after parsing.
- **Hook buffer line** — live keyboard hook capture (`HOOK[n]`, `LAST[n]`, `TIMEOUT[n]`).

### Scanner debugging (orb hook buffer)

| What you see                                   | Likely cause                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `HOOK[n]` stays at 0 while scanning            | Hook isn't receiving scanner keystrokes (wrong scanner mode, or not HID keyboard wedge). |
| `HOOK[n]` grows then `TIMEOUT`                 | Scanner is too slow; raise `PHARMABUDDY_SCANNER_THRESHOLD_MS=800` in `.env`.             |
| `LAST[n]` shows data but scan line stays empty | Buffer reached Enter but was ≤3 chars, or normalization rejected it.                     |
| `LAST[n]` matches box but scan fails           | Parsing issue (check the scan line above for the normalized result).                     |

Hover either debug line for the full untruncated buffer text.

### Test barcodes (TEST profile)

| Barcode                                               | Result                        |
| ----------------------------------------------------- | ----------------------------- |
| Any 13 digits                                         | Mock OK                       |
| Plain GS1 DataMatrix (e.g. `0105054290011142…`)       | Mock OK after GTIN extraction |
| ASCII triplet GS1 (100+ digits, e.g. `048049048053…`) | Decoded to GS1, then mock OK  |
| `0000000000000`                                       | Error                         |
| `1111111111111`                                       | Long recommendation           |
| `2222222222222`                                       | Short recommendation          |

Use [`fake_scanner_trigger`](../fake_scanner_trigger/) to inject long ASCII triplet samples (see `samples/ascii_triplet_augmentin.txt`).

## Logs

`%LOCALAPPDATA%\pharmaBuddy\pharmabuddy-tauri.log`

## Window sizes

| State           | Size    |
| --------------- | ------- |
| Orb only        | 250×288 |
| Success + panel | 368×520 |
| Error + panel   | 368×400 |

Drag the orb or panel header to move. Close the panel with **✕** only.
