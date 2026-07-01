# Note Spese — Microgeo / Dynatech · Guida di configurazione

App per la gestione note spese: **16 agenti** inseriscono le spese da web,
**Cristiana** le gestisce dal foglio Google.

## I tre pezzi e come si parlano

```
  index.html  ──POST JSON──►  spese-agenti.gs  ──►  Google Sheet
 (GitHub Pages)               (Web App)             (1sSEKcE…5ZmsPQI)
```

| Pezzo             | File               | Ruolo                                             |
|-------------------|--------------------|---------------------------------------------------|
| Frontend agenti   | `index.html`       | Login Google, inserimento spese, "Le mie spese"   |
| Backend           | `spese-agenti.gs`  | Web App: `append` / `read`, riepilogo, azzeramento |
| Database          | Google Sheet       | Fogli `SPESE`, `Riepilogo Mensile`, `STORICO ANNUALE` |

### I fogli del database

- **`SPESE`** — spese del **mese corrente**. Ogni nuova spesa viene scritta qui.
  Cristiana lo svuota a fine mese con "Azzera spese mensili".
- **`STORICO ANNUALE`** — archivio **permanente**: ogni spesa ci finisce sempre
  (scrittura doppia in `append`). Non viene mai azzerato dall'app.
- **`Riepilogo Mensile`** — auto-generato: totali per agente del mese corrente.

## Schema colonne — foglio `Spese` (A→M)

Identico in `index.html` (`submitExpense`) e in `spese-agenti.gs` (`HEADERS`/`COL`):

| A  | B         | C    | D       | E    | F     | G         | H    | I  | J       | K    | L     | M        |
|----|-----------|------|---------|------|-------|-----------|------|----|---------|------|-------|----------|
| ID | Timestamp | Nome | Cognome | Zona | Email | DataSpesa | Tipo | Km | Importo | Note | Stato | MeseAnno |

`MeseAnno` è nel formato `MM-YYYY` (es. `07-2026`).

## Deploy del backend (Apps Script)

1. Apri il foglio Google → **Estensioni → Apps Script**.
2. Incolla il contenuto di `spese-agenti.gs` e salva.
3. **Distribuisci → Nuova distribuzione → Tipo: App web**
   - *Esegui come:* **Me**
   - *Chi ha accesso:* **Chiunque**
4. Copia l'URL `…/exec` e incollalo in `index.html` → `CONFIG.SCRIPT_URL`.
5. Ricarica il foglio: comparirà il menu **💼 Note Spese**.

## Problemi risolti in questa versione

1. **Righe in posizione sbagliata** — `appendRow`/`getLastRow` calcolavano
   l'ultima riga in base a qualunque colonna con contenuto. Sostituiti da
   `getFirstEmptyDataRow()`, che scrive nella prima riga con **colonna A (ID)
   vuota**. Scrittura protetta da `LockService` contro invii concorrenti.

2. **"Riepilogo Mensile" vuoto** — `aggiornaRiepilogoMensile()` ricostruisce il
   foglio con i totali per agente del **mese corrente** (N. spese, Totale,
   Approvate, Da autorizzare, In attesa) + riga totale generale. Viene
   rigenerato automaticamente a ogni nuova spesa e dal menu.

3. **Manca "Azzera spese mensili"** — voce di menu **💼 Note Spese → 🧹 Azzera
   spese mensili** (solo Cristiana, dal foglio). Con conferma, verifica che ogni
   riga sia già presente in `STORICO ANNUALE` (nessuna perdita dati) e poi
   svuota `SPESE` mantenendo l'intestazione.

> L'azzeramento è volutamente **lato foglio** (non nell'app agenti): gli agenti
> non devono poter cancellare le spese di tutti. Cristiana lo usa dal menu.
> Lo `STORICO ANNUALE` non viene toccato: resta l'archivio completo dell'anno.
