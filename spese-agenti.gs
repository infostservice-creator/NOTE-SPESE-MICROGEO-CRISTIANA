/*───────────────────────────────────────────────────────────────────────────
  NOTE SPESE — Microgeo S.r.l. & Dynatech S.r.l.
  Backend Google Apps Script Web App

  Foglio Google:  1sSEKcElDBML4QJfl1yEVC1YCptBbogqMDlJ-5ZmsPQI

  DEPLOY (Web App):
    • Esegui come:        Me (proprietario del foglio)
    • Chi può accedere:   Chiunque
    Copiare l'URL /exec risultante in CONFIG.SCRIPT_URL dentro index.html.

  Struttura foglio "Spese" (una riga per spesa) — colonne A→M:
    A  ID          F  Email       K  Note
    B  Timestamp   G  DataSpesa   L  Stato
    C  Nome        H  Tipo        M  MeseAnno (MM-YYYY)
    D  Cognome     I  Km
    E  Zona        J  Importo

  Questo file risolve i tre problemi noti:
    1) appendRow scriveva in posizioni sbagliate  → getFirstEmptyDataRow()
    2) "Riepilogo Mensile" vuoto                   → aggiornaRiepilogoMensile()
    3) Manca "Azzera spese mensili" per Cristiana  → menu onOpen() + azzeraSpeseMensili()
───────────────────────────────────────────────────────────────────────────*/

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURAZIONE
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  SHEET_ID:      '1sSEKcElDBML4QJfl1yEVC1YCptBbogqMDlJ-5ZmsPQI',
  TAB_SPESE:     'Spese',              // foglio dati principale
  TAB_RIEPILOGO: 'Riepilogo Mensile',  // foglio riepilogo per agente
  TAB_ARCHIVIO:  'Archivio',           // dove finiscono le spese azzerate
};

// Intestazioni colonne A→M del foglio "Spese"
const HEADERS = [
  'ID', 'Timestamp', 'Nome', 'Cognome', 'Zona', 'Email',
  'DataSpesa', 'Tipo', 'Km', 'Importo', 'Note', 'Stato', 'MeseAnno',
];

// Indici di colonna (0-based) — devono restare allineati a index.html
const COL = {
  ID: 0, TIMESTAMP: 1, NOME: 2, COGNOME: 3, ZONA: 4, EMAIL: 5,
  DATA: 6, TIPO: 7, KM: 8, IMPORTO: 9, NOTE: 10, STATO: 11, MESE: 12,
};


// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT WEB APP
// ═══════════════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;

    switch (action) {
      case 'append': return json_(handleAppend_(body));
      case 'read':   return json_(handleRead_(body));
      default:       return json_({ error: 'Azione non riconosciuta: ' + action });
    }
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

// Health-check nel browser
function doGet() {
  return json_({ ok: true, service: 'Note Spese Microgeo/Dynatech', ts: new Date().toISOString() });
}


// ═══════════════════════════════════════════════════════════════════════════
//  AZIONE: APPEND  —  scrive una nuova spesa nella prima riga libera
// ═══════════════════════════════════════════════════════════════════════════
function handleAppend_(body) {
  const row = body.row;
  if (!Array.isArray(row) || row.length < HEADERS.length) {
    return { error: 'Riga non valida' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // evita scritture concorrenti su righe sovrapposte
  try {
    const sheet = getSpeseSheet_();
    const targetRow = getFirstEmptyDataRow(sheet);
    sheet.getRange(targetRow, 1, 1, HEADERS.length).setValues([row.slice(0, HEADERS.length)]);
    SpreadsheetApp.flush();

    // Tiene il riepilogo sempre aggiornato dopo ogni inserimento
    try { aggiornaRiepilogoMensile(); } catch (_) {}

    return { ok: true, row: targetRow };
  } finally {
    lock.releaseLock();
  }
}

/*
  FIX del bug appendRow: getLastRow()/appendRow() calcolano l'ultima riga in base
  a QUALSIASI colonna con contenuto (formule, celle residue, ecc.), quindi possono
  scrivere in posizioni sbagliate. Qui cerchiamo la prima riga in cui la colonna A
  (ID) è vuota, saltando l'intestazione.
*/
function getFirstEmptyDataRow(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 2; // solo intestazione da creare / foglio nuovo

  const ids = sheet.getRange(1, COL.ID + 1, lastRow, 1).getValues();
  for (let i = 1; i < ids.length; i++) {        // i=1 → salta la riga intestazione
    const v = ids[i][0];
    if (v === '' || v === null) return i + 1;   // riga 1-based
  }
  return lastRow + 1;
}


// ═══════════════════════════════════════════════════════════════════════════
//  AZIONE: READ  —  restituisce le righe dati (opzionalmente filtrate per mese)
// ═══════════════════════════════════════════════════════════════════════════
function handleRead_(body) {
  const sheet = getSpeseSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { values: [] };

  const all = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();

  // Solo righe reali (con ID) — scarta righe vuote intermedie
  let values = all.filter(r => r[COL.ID] !== '' && r[COL.ID] !== null);

  // Filtro per mese, se richiesto
  if (body.meseAnno) {
    values = values.filter(r => normMese_(r[COL.MESE]) === body.meseAnno);
  }

  // Normalizza data e timestamp a stringa (evita oggetti Date serializzati male)
  values = values.map(r => r.map((v, i) => {
    if (v instanceof Date) {
      return (i === COL.DATA) ? toISODate_(v) : v.toISOString();
    }
    return v;
  }));

  return { values };
}


// ═══════════════════════════════════════════════════════════════════════════
//  RIEPILOGO MENSILE  —  totali per agente del mese corrente
// ═══════════════════════════════════════════════════════════════════════════
function aggiornaRiepilogoMensile() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const spese = getSpeseSheet_();
  const riep = getOrCreateSheet_(ss, CONFIG.TAB_RIEPILOGO);

  const meseAnno = meseAnnoCorrente_();
  const lastRow = spese.getLastRow();
  const data = lastRow >= 2
    ? spese.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
    : [];

  // Aggrega per agente (chiave = email) le sole righe del mese corrente
  const map = {}; // email → { nome, zona, n, tot, appr, auth, attesa }
  data.forEach(r => {
    if (r[COL.ID] === '' || r[COL.ID] === null) return;
    if (normMese_(r[COL.MESE]) !== meseAnno) return;

    const email = String(r[COL.EMAIL] || '').toLowerCase();
    if (!email) return;

    if (!map[email]) {
      map[email] = {
        agente: (String(r[COL.NOME] || '') + ' ' + String(r[COL.COGNOME] || '')).trim(),
        zona:   String(r[COL.ZONA] || ''),
        n: 0, tot: 0, appr: 0, auth: 0, attesa: 0,
      };
    }
    const imp = parseFloat(r[COL.IMPORTO]) || 0;
    const stato = String(r[COL.STATO] || '').toUpperCase();
    const a = map[email];
    a.n   += 1;
    a.tot += imp;
    if (stato === 'APPROVATA')            a.appr   += imp;
    else if (stato === 'DA AUTORIZZARE')  a.auth   += imp;
    else                                  a.attesa += imp; // IN ATTESA / altro
  });

  // Ordina per totale decrescente
  const righe = Object.keys(map).map(email => {
    const a = map[email];
    return [a.agente, email, a.zona, a.n, a.tot, a.appr, a.auth, a.attesa];
  }).sort((x, y) => y[4] - x[4]);

  // Ricostruisce il foglio riepilogo
  riep.clear();

  const titolo = 'RIEPILOGO MENSILE — ' + nomeMese_(meseAnno) + '  (agg. ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') + ')';
  riep.getRange(1, 1).setValue(titolo).setFontWeight('bold').setFontSize(12);

  const intest = ['Agente', 'Email', 'Zona', 'N. Spese',
                  'Totale €', 'Approvate €', 'Da autorizzare €', 'In attesa €'];
  riep.getRange(2, 1, 1, intest.length).setValues([intest])
      .setFontWeight('bold').setBackground('#1565c0').setFontColor('#ffffff');

  if (righe.length > 0) {
    riep.getRange(3, 1, righe.length, intest.length).setValues(righe);

    // Riga totali generali
    const totRow = righe.length + 3;
    const tot   = righe.reduce((s, r) => s + r[4], 0);
    const appr  = righe.reduce((s, r) => s + r[5], 0);
    const auth  = righe.reduce((s, r) => s + r[6], 0);
    const att   = righe.reduce((s, r) => s + r[7], 0);
    const nTot  = righe.reduce((s, r) => s + r[3], 0);
    riep.getRange(totRow, 1, 1, intest.length)
        .setValues([['TOTALE', '', '', nTot, tot, appr, auth, att]])
        .setFontWeight('bold').setBackground('#e3f2fd');

    // Formattazione valuta sulle colonne E→H
    riep.getRange(3, 5, righe.length + 1, 4).setNumberFormat('€ #,##0.00');
  } else {
    riep.getRange(3, 1).setValue('Nessuna spesa registrata questo mese.')
        .setFontStyle('italic').setFontColor('#5f6368');
  }

  riep.setColumnWidths(1, intest.length, 130);
  riep.setColumnWidth(2, 220); // email
  riep.setFrozenRows(2);

  return righe.length;
}


// ═══════════════════════════════════════════════════════════════════════════
//  AZZERA SPESE MENSILI  —  archivia e ripulisce il foglio "Spese"
//  (accessibile a Cristiana dal menu "Note Spese" nel foglio)
// ═══════════════════════════════════════════════════════════════════════════
function azzeraSpeseMensili() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const spese = getSpeseSheet_();
  const ui = SpreadsheetApp.getUi();

  const lastRow = spese.getLastRow();
  const nRighe = Math.max(0, lastRow - 1);
  if (nRighe === 0) {
    ui.alert('Azzera spese', 'Non ci sono spese da azzerare.', ui.ButtonSet.OK);
    return;
  }

  const risposta = ui.alert(
    '⚠️ Azzera spese mensili',
    'Stai per ARCHIVIARE e AZZERARE ' + nRighe + ' spese dal foglio "' + CONFIG.TAB_SPESE + '".\n\n' +
    'Le righe verranno copiate nel foglio "' + CONFIG.TAB_ARCHIVIO + '" prima della cancellazione.\n\n' +
    'Vuoi procedere?',
    ui.ButtonSet.YES_NO
  );
  if (risposta !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const dati = spese.getRange(2, 1, nRighe, HEADERS.length).getValues()
                      .filter(r => r[COL.ID] !== '' && r[COL.ID] !== null);

    // 1) Archivia (con timestamp di archiviazione in coda)
    if (dati.length > 0) {
      const arch = getOrCreateSheet_(ss, CONFIG.TAB_ARCHIVIO);
      if (arch.getLastRow() === 0) {
        arch.getRange(1, 1, 1, HEADERS.length + 1)
            .setValues([HEADERS.concat(['DataArchiviazione'])])
            .setFontWeight('bold');
      }
      const stamp = new Date();
      const conStamp = dati.map(r => r.concat([stamp]));
      arch.getRange(arch.getLastRow() + 1, 1, conStamp.length, HEADERS.length + 1)
          .setValues(conStamp);
    }

    // 2) Cancella le righe dati dal foglio Spese (mantiene l'intestazione)
    spese.getRange(2, 1, nRighe, HEADERS.length).clearContent();
    SpreadsheetApp.flush();

    // 3) Rigenera il riepilogo (ora vuoto)
    aggiornaRiepilogoMensile();

    ui.alert('✅ Fatto',
      dati.length + ' spese archiviate in "' + CONFIG.TAB_ARCHIVIO + '" e azzerate.',
      ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  MENU nel foglio (per Cristiana)
// ═══════════════════════════════════════════════════════════════════════════
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💼 Note Spese')
    .addItem('🔄 Aggiorna Riepilogo Mensile', 'aggiornaRiepilogoMensile')
    .addSeparator()
    .addItem('🧹 Azzera spese mensili', 'azzeraSpeseMensili')
    .addToUi();
}


// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getSpeseSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.TAB_SPESE);

  // Retro-compatibilità: se il foglio dedicato non esiste, usa il primo foglio
  if (!sheet) sheet = ss.getSheets()[0];

  // Garantisce l'intestazione corretta in riga 1
  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  const first = sheet.getRange(1, 1).getValue();
  if (first === '' || first === null) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
         .setFontWeight('bold').setBackground('#1565c0').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// "MM-YYYY" del mese corrente (allineato a getMeseAnno() dell'HTML)
function meseAnnoCorrente_() {
  const d = new Date();
  return pad2_(d.getMonth() + 1) + '-' + d.getFullYear();
}

// Normalizza il valore della colonna MeseAnno a "MM-YYYY" (gestisce Date/stringhe)
function normMese_(v) {
  if (v instanceof Date) return pad2_(v.getMonth() + 1) + '-' + v.getFullYear();
  return String(v || '').trim();
}

function nomeMese_(meseAnno) {
  const nomi = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const parts = String(meseAnno).split('-');
  const m = parseInt(parts[0], 10);
  const y = parts[1] || '';
  return (m >= 1 && m <= 12) ? (nomi[m - 1] + ' ' + y) : meseAnno;
}

function toISODate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function pad2_(n) { return String(n).padStart(2, '0'); }

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
