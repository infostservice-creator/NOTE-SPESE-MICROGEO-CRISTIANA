# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Expense-report app ("Note Spese") for Microgeo S.r.l. / Dynatech S.r.l.: ~16 sales agents log expenses from a web page; the admin (Cristiana) manages them directly in a Google Sheet. All UI text, comments, sheet names and commit messages are in Italian — keep it that way.

No build system, package manager, linter or tests.

- `index.html` — single-file frontend (HTML + CSS + inline JS), hosted on GitHub Pages. Google Identity Services login, "Nuova spesa" form, "Le mie spese" list, "Scontrini" tab (opens the agent's private Drive folder).
- `gas/Codice.js` — **the only reference for the Apps Script backend** (Web App bound to the sheet), synced with clasp. `gas/.clasp.json` holds the script ID; `gas/appsscript.json` is the manifest (V8, Europe/Rome, executes as the deploying user, access anyone).

`SETUP.md` is the detailed architecture guide (in Italian); its manual copy-paste deploy steps are superseded by the flow below. `index_backup_*.html` files are gitignored local snapshots.

## Backend deploy flow (clasp)

Run from `gas/` (clasp 3.x, already logged in):

1. Edit `gas/Codice.js`.
2. `clasp push` — uploads to the Apps Script project (HEAD). Check `clasp status` first: every `.js/.gs/.html/.json` file in `gas/` gets pushed.
3. `clasp version "<descrizione>"` → note the version number N.
4. `clasp update-deployment AKfycbzRfIFKR6fAVFgCnESAQEi8E0ufyIB4ABmii-jNhn5tzZ6vJB2vEiiB8hzZ4XJM0IERiA -V N -d "<descrizione>"`.

**Never create a new deployment** (`clasp deploy` without `-i`, or "Nuova distribuzione" in the editor): that deployment ID is the `/exec` URL hardcoded in `CONFIG.SCRIPT_URL` in `index.html`, and it must stay the same. `clasp deployments` lists the others (`@HEAD` test deployment, an old `@3` one) — not used by the app. Push/deploy only when the user explicitly asks.

Deploy the backend before the frontend when a change touches the request/response contract, keeping the backend backward compatible with the currently published `index.html`.

## Architecture

```
index.html ──POST JSON (text/plain)──► Apps Script doPost ──► Google Sheet
```

- **Request flow**: `apiPost(action, payload)` in `index.html` sends `{action, email, idToken, ...}` as `text/plain` (avoids CORS preflight). `doPost` verifies `idToken` via Google's tokeninfo endpoint (checks `aud === OAUTH_CLIENT_ID`), takes the email **from the verified token**, not the payload, checks it against `ALLOWED_EMAILS`, then dispatches to `handleAppend` / `handleRead`. Errors return `{error, code}` with HTTP 200; the frontend treats `code === 401` as session expired and logs out.
- **No edit of saved expenses**: there is no `update` action in the backend and no "Modifica" button in `index.html` (removed by decision in rilascio 2). An old draft of `handleUpdate` exists in git history (`bozza-update.gs`, deleted).
- **Over-cap confirmation**: `submitExpense()` shows a confirm pop-up (`askConfirm`) before saving when `importo > RULES[tipo].cap`; "Annulla" keeps the form filled for correction.
- **Sheets** (headers on row 3, data from row 4 — `FIRST_DATA_ROW`): `SPESE` (current month only, cleared monthly via menu), `STORICO ANNUALE` (permanent; every append is written to both), `RIEPILOGO MENSILE` (fixed layout of agent rows + "TOTALE GENERALE", recomputed by `aggiornaRiepilogoMensile` from all of `SPESE`), `ANAGRAFICA` (not touched by code). "Le mie spese" reads `STORICO ANNUALE` via `handleRead`: filtered by token email and by month of **DataInserimento (col B)** in the sheet's timezone; the response is `{values, meseAnno, mesi}` (`mesi` from `PRIMO_MESE_LETTURA` = 09-2026 to the current month), and the frontend month dropdown preselects the returned `meseAnno`. Stats are computed client-side; the total excludes `RIFIUTATA`. So agent totals intentionally differ from `RIEPILOGO MENSILE` (which uses all of `SPESE`).
- **Row schema A→M (13 cols)** must stay identical in `submitExpense()` (`index.html`) and `gas/Codice.js`: ID, DataInserimento (UTC ISO string from the browser), Nome, Cognome, Zona, Email, DataSpesa (`yyyy-MM-dd`), Tipologia, Km, Importo (must be a **number**, not a string — Italian locale misreads `"12.00"` as a time), Note agente, Stato, Note revisione. Month is never stored as a column.
- **Stati**: `IN ATTESA`, `DA AUTORIZZARE`, `APPROVATA`, `RIFIUTATA`. The frontend sets `APPROVATA` when within the cap and `DA AUTORIZZARE` when over it (`RULES` in `index.html`, per "Circolare n.18/26"). Only Cristiana edits Stato (L) and Note revisione (M) in the sheet; the `onEdit` trigger propagates those to `STORICO ANNUALE` by ID (only the first row of a multi-row edit) and recomputes the summary.
- **Writes** use `getFirstEmptyDataRow()` (first row with empty column A) under `LockService` instead of `appendRow`, which wrote rows in wrong positions.
- **Summary matching** is by normalized "Nome Cognome" (`normName_`) against the names in `RIEPILOGO MENSILE` column A.
- Monthly reset (`azzeraSpeseMensili`) is intentionally sheet-side only (custom menu "💼 Note Spese"), never exposed to agents.

## Keeping lists in sync

Adding/removing an agent requires editing three places by hand:
1. `AGENTS` in `index.html` (email → nome, cognome, zona; multiple emails can map to the same person),
2. `RECEIPT_FOLDERS` in `index.html` (email → Drive folder URL),
3. `ALLOWED_EMAILS` in `gas/Codice.js` (then deploy with the flow above),
plus a row in the `RIEPILOGO MENSILE` sheet whose name matches.

The OAuth client ID appears in both `CONFIG.CLIENT_ID` (`index.html`) and `OAUTH_CLIENT_ID` (`gas/Codice.js`) and must match.

## Testing

No automated tests. Verify by opening `index.html` (served over http(s) from an origin authorized for the OAuth client, e.g. GitHub Pages) and checking the sheet; `doGet` returns `{status:'ok', version}` as a quick health check of the Web App URL. The `@HEAD` deployment (`clasp deployments`) serves the latest pushed code and can be used for testing before updating the production deployment.

## Idee future

- valutare blocco spese più vecchie di 30 giorni
- il database passerà da Google Sheet a vTiger
- togliere email agenti e link Drive da index.html (con vTiger)
- handleAppend si fida di stato, nome ed email inviati dalla pagina: forzarli lato server (con vTiger o prima)
