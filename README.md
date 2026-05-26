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

| Variable | Purpose |
|----------|---------|
| `PHARMABUDDY_PROFILE` | `test` (mock) or `prod` (Supabase) |
| `SUPABASE_FUNCTIONS_URL` | Full edge function URL (prod only) |
| `SUPABASE_ANON_KEY` | Bearer token (prod only) |

Profile is also stored in `%LOCALAPPDATA%\pharmaBuddy\profile.txt` (shared with WinUI app). Click the **TEST** / **PROD** badge under the orb to toggle.

## Barcode input

- **Production:** global Windows low-level keyboard hook (works while POS/other apps are focused).
- **Dev fallback:** focus the hidden `#scan-fallback` input (e.g. via DevTools) and type a 13-digit barcode + Enter.

### Test barcodes (TEST profile)

| Barcode | Result |
|---------|--------|
| Any 13 digits | Mock OK |
| `0000000000000` | Error |
| `1111111111111` | Long recommendation |
| `2222222222222` | Short recommendation |

## Logs

`%LOCALAPPDATA%\pharmaBuddy\pharmabuddy-tauri.log`

## Window sizes

| State | Size |
|-------|------|
| Orb only | 250×250 |
| Success + panel | 368×520 |
| Error + panel | 368×400 |

Drag the orb or panel header to move. Close the panel with **✕** only.
