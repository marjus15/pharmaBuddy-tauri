# Progress

## 2026-10-08 — Rebase onto side-effects master

- Rebased the Linux keystroke scan onto master after the side-effects work landed.
- Kept the Linux barcode buffer in `src/main.js` and the Galinos side-effect lookup, storage, and recommendation changes from master.

## 2026-10-05 — Side effects of the scanned medicine

- After a scan, the widget loads the public Galinos SPC excerpt under «Ανεπιθύμητες ενέργειες» and shows it under the medicine name.
- The excerpt is stored on `global_product_catalog.metadata.side_effects` (existing rows are updated only when that field is empty).
- `cache-catalog-entry` version 4 is deployed with that merge.
- The recommendation request includes the excerpt. The function source in `supabase/functions/get-ai-recommendation` tells the model to mention one relevant adverse effect and not to invent one.

## 2026-10-05

- Added a Linux keystroke scan path in `src/main.js` so rapid barcode keystrokes are accepted when the Windows global hook is unavailable.
- Cloud Agent environment will clone `https://github.com/marjus15/fake_scanner_trigger` and install a `fake-scan` command that injects a barcode into the running widget.
