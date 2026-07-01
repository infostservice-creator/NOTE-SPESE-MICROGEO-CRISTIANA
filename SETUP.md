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
| Database          | Google Sheet       | Fogli `SPESE`, `RIEPILOGO MENSILE`, `STORICO ANNUALE`, `ANAGRAFICA` |

### I fogli del database (intestazioni su riga 3, dati dalla riga 4)

- **`SPESE`** — spese del **mese corrente**. Ogni nuova spesa viene scritta qui.
  Cristiana lo svuota a fine mese con "Azzera spese mensili".
- **`STORICO ANNUALE`** — archivio **permanente**: ogni spesa ci finisce sempre
  (scrittura doppia in `append`). Non viene mai azzerato dall'app.
- **`RIEPILOGO MENSILE`** — layout fisso con i 16 agenti + TOTALE GENERALE;
  lo script riempie le colonne dei totali del mese corrente.
- **`ANAGRAFICA`** — elenco agenti (informativo, non gestito dallo script).

## Schema colonne — foglio `SPESE` (A→M)

Identico in `index.html` (`submitExpense`) e in `spese-agenti.gs`:

| A  | B          | C    | D       | E    | F     | G         | H         | I  | J       | K           | L     | M              |
|----|------------|------|---------|------|-------|-----------|-----------|----|---------|-------------|-------|----------------|
| ID | DataInser. | Nome | Cognome | Zona | Email | DataSpesa | Tipologia | Km | Importo | Note agente | Stato | Note revisione |

- **Il mese NON è una colonna**: si ricava dalla `DataSpesa` (formato
  `yyyy-MM-dd`). Il filtro "mese corrente" usa `MM-YYYY`.
- **`Stato`** (L) e **`Note revisione`** (M) sono gli unici campi che Cristiana
  modifica a mano.

## Stati (uguali in foglio, app e riepilogo)

`IN ATTESA` · `DA AUTORIZZARE` · `APPROVATA` · `RIFIUTATA`

Sono i valori del menu a tendina sulla colonna `Stato`. L'app li riconosce e li
mostra colorati; il riepilogo somma per ciascuno di questi stati.

## Come "parlano" quando Cristiana cambia uno stato

1. Cristiana sceglie un nuovo `Stato` (o scrive una `Note revisione`) in `SPESE`.
2. Il trigger `onEdit` **propaga** il valore alla riga corrispondente in
   `STORICO ANNUALE` e **ricalcola** il `RIEPILOGO MENSILE`.
3. L'agente, aprendo "Le mie spese", vede lo stato aggiornato e — se presente —
   la **nota di revisione** (es. il motivo di un rifiuto).

## Deploy del backend (Apps Script)

1. Apri il foglio Google → **Estensioni → Apps Script**.
2. Sostituisci tutto il contenuto con `spese-agenti.gs` e salva.
3. **Distribuisci → Nuova distribuzione → Tipo: App web**
   - *Esegui come:* **Me**
   - *Chi ha accesso:* **Chiunque**
4. Copia l'URL `…/exec` e incollalo in `index.html` → `CONFIG.SCRIPT_URL`
   (se cambia rispetto a prima).
5. Ricarica il foglio: comparirà il menu **💼 Note Spese**.
6. Dal menu esegui una volta **🎛️ Imposta menu a tendina Stato** per applicare
   la tendina + colori con i 4 stati sopra.

## Menu foglio «💼 Note Spese» (per Cristiana)

- **🔄 Aggiorna Riepilogo Mensile** — ricalcola i totali.
- **🎛️ Imposta menu a tendina Stato** — (ri)applica la tendina dei 4 stati.
- **🧹 Azzera spese mensili** — svuota `SPESE` a fine mese (lo `STORICO` resta).

## Problemi risolti / funzioni

1. **Righe in posizione sbagliata** — `getFirstEmptyDataRow()` sostituisce
   `appendRow`: scrive nella prima riga con **colonna A (ID) vuota** (dati dalla
   riga 4). Scrittura su `SPESE` **e** `STORICO`, protetta da `LockService`.

2. **"Riepilogo Mensile" vuoto** — `aggiornaRiepilogoMensile()` compila il layout
   esistente (16 agenti + TOTALE GENERALE), aggregando per agente i totali del
   mese per stato. Si aggiorna a ogni nuova spesa, a ogni cambio stato e dal menu.

3. **"Azzera spese mensili"** — voce di menu (solo Cristiana). Con conferma,
   verifica che ogni riga sia già in `STORICO ANNUALE` (nessuna perdita dati) e
   poi svuota `SPESE`.

> L'azzeramento è volutamente **lato foglio** (non nell'app agenti): gli agenti
> non devono poter cancellare le spese di tutti. Lo `STORICO ANNUALE` non viene
> mai toccato: resta l'archivio completo dell'anno.
