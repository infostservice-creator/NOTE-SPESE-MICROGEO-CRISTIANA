// ================================================================
//  NOTE SPESE — Microgeo S.r.l. & Dynatech S.r.l.
//  Google Apps Script — Backend sicuro per Google Sheets
//  Da deployare come Web App:
//    - Esegui come: Me (proprietario del foglio)
//    - Chi può accedere: Chiunque
//
//  Fogli usati:
//    SPESE            → spese del mese corrente (viene azzerato ogni mese)
//    STORICO ANNUALE  → archivio permanente (ogni spesa ci finisce sempre)
//    Riepilogo Mensile→ totali per agente del mese corrente (auto-generato)
//
//  Fix inclusi:
//    1) appendRow scriveva in posizioni sbagliate → getFirstEmptyDataRow()
//    2) "Riepilogo Mensile" vuoto                 → aggiornaRiepilogoMensile()
//    3) Manca "Azzera spese mensili" per Cristiana → menu onOpen() + azzeraSpeseMensili()
// ================================================================

const SHEET_ID        = '1sSEKcElDBML4QJfl1yEVC1YCptBbogqMDlJ-5ZmsPQI';
const SHEET_SPESE     = 'SPESE';
const SHEET_STORICO   = 'STORICO ANNUALE';
const SHEET_RIEPILOGO = 'Riepilogo Mensile';

// Numero di colonne dati (A-M)
const N_COL = 13;

// Lista email autorizzate (aggiornare quando cambiano gli agenti)
const ALLOWED_EMAILS = [
  // Microgeo
  'd.battaglia@microgeo.it',
  'a.carraro@microgeo.it',
  'c.ferrara@microgeo.it',
  'm.friggi@microgeo.it',
  'd.guidotti@microgeo.it',
  'i.racu@microgeo.it',
  's.solda@microgeo.it',
  'a.deamicis@microgeo.it',
  'm.costantino@microgeo.it',
  'f.conti@microgeo.it',
  'g.palmer@microgeo.it',
  'g.russo@microgeo.it',
  // Dynatech
  'f.damiani@dynatech.it',
  's.toccaceli@dynatech.it',
  'g.servodio@dynatech.it',
  'a.raimondi@dynatech.it',
  // Gmail personali (test / backup)
  'info.stservice@gmail.com',
  'serradiosurf@gmail.com',
  'giampaolo.servodio@gmail.com',
  'raimondiandrea9@gmail.com',
  'damianifrancesco25@gmail.com',
];

// ── Risposta JSON ────────────────────────────────────────────────
function jsonOk(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(msg, code) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: msg, code: code || 400 }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Entry point POST ─────────────────────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var email   = (payload.email || '').toLowerCase().trim();

    // Sicurezza: verifica che l'email sia nella lista autorizzata
    if (ALLOWED_EMAILS.indexOf(email) === -1) {
      return jsonError('Email non autorizzata: ' + email, 403);
    }

    var action = payload.action;

    if (action === 'append') {
      return handleAppend(payload);
    }

    if (action === 'read') {
      return handleRead(email, payload.meseAnno);
    }

    return jsonError('Azione non riconosciuta: ' + action);

  } catch (err) {
    return jsonError('Errore server: ' + err.toString(), 500);
  }
}

// ── GET di controllo (per verificare che lo script sia attivo) ──
function doGet(e) {
  return jsonOk({ status: 'ok', version: '2.0' });
}

// ================================================================
//  APPEND — scrive una riga su SPESE e STORICO ANNUALE
//  Struttura row (colonne A-M):
//  [ID, Timestamp, Nome, Cognome, Zona, Email, DataSpesa, Tipo, Km, Importo, Note, Stato, MeseAnno]
// ================================================================
function handleAppend(payload) {
  var row = payload.row;
  if (!row || row.length < N_COL) {
    return jsonError('Riga non valida', 400);
  }
  row = row.slice(0, N_COL);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // evita che invii simultanei finiscano sulla stessa riga
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);

    // Foglio mese corrente
    var sheetSpese = ss.getSheetByName(SHEET_SPESE);
    if (!sheetSpese) return jsonError('Foglio "' + SHEET_SPESE + '" non trovato', 404);
    writeRow_(sheetSpese, row);

    // Archivio annuale
    var sheetStorico = ss.getSheetByName(SHEET_STORICO);
    if (sheetStorico) writeRow_(sheetStorico, row);

    SpreadsheetApp.flush();

    // Tiene il riepilogo sempre aggiornato
    try { aggiornaRiepilogoMensile(); } catch (e2) {}

    return jsonOk({ success: true, id: row[0] });
  } finally {
    lock.releaseLock();
  }
}

// Scrive la riga nella prima riga dati realmente vuota
function writeRow_(sheet, row) {
  var r = getFirstEmptyDataRow(sheet);
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
}

/*
  FIX del bug appendRow: appendRow()/getLastRow() calcolano l'ultima riga in base
  a QUALSIASI colonna con contenuto (formule, celle residue, ecc.), quindi possono
  scrivere in posizioni sbagliate. Qui cerchiamo la prima riga in cui la colonna A
  (ID) è vuota, saltando l'intestazione (riga 1).
*/
function getFirstEmptyDataRow(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return 2; // foglio vuoto: scrive sotto l'eventuale intestazione

  var ids = sheet.getRange(1, 1, lastRow, 1).getValues();
  for (var i = 1; i < ids.length; i++) {      // i=1 → salta l'intestazione
    if (ids[i][0] === '' || ids[i][0] === null) return i + 1;
  }
  return lastRow + 1;
}

// ================================================================
//  READ — spese di un agente per il mese corrente
// ================================================================
function handleRead(email, meseAnno) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SPESE);
  if (!sheet) return jsonError('Foglio "' + SHEET_SPESE + '" non trovato', 404);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOk({ values: [] });

  var values = sheet.getRange(2, 1, lastRow - 1, N_COL).getValues();

  // Filtra per email (col F = 5) e mese-anno (col M = 12)
  var filtered = values.filter(function(row) {
    if (row[0] === '' || row[0] === null) return false; // salta righe vuote
    var rowEmail = (row[5] || '').toString().toLowerCase().trim();
    var rowMese  = normMese_(row[12]);
    return rowEmail === email && (!meseAnno || rowMese === meseAnno);
  });

  // Converti Date/valori in stringhe (coerenza con l'HTML)
  filtered = filtered.map(function(row) {
    return row.map(function(cell, i) {
      if (cell instanceof Date) {
        return (i === 6)
          ? Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : cell.toISOString();
      }
      return cell === null || cell === undefined ? '' : cell.toString();
    });
  });

  return jsonOk({ values: filtered });
}

// ================================================================
//  RIEPILOGO MENSILE — totali per agente del mese corrente
// ================================================================
function aggiornaRiepilogoMensile() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var spese = ss.getSheetByName(SHEET_SPESE);
  if (!spese) throw new Error('Foglio "' + SHEET_SPESE + '" non trovato');

  var riep = ss.getSheetByName(SHEET_RIEPILOGO);
  if (!riep) riep = ss.insertSheet(SHEET_RIEPILOGO);

  var meseAnno = meseAnnoCorrente_();
  var lastRow = spese.getLastRow();
  var data = lastRow >= 2 ? spese.getRange(2, 1, lastRow - 1, N_COL).getValues() : [];

  // Aggrega per agente (chiave = email) le sole righe del mese corrente
  var map = {};
  data.forEach(function(r) {
    if (r[0] === '' || r[0] === null) return;
    if (normMese_(r[12]) !== meseAnno) return;

    var email = (r[5] || '').toString().toLowerCase().trim();
    if (!email) return;

    if (!map[email]) {
      map[email] = {
        agente: ((r[2] || '') + ' ' + (r[3] || '')).toString().trim(),
        zona:   (r[4] || '').toString(),
        n: 0, tot: 0, appr: 0, auth: 0, attesa: 0
      };
    }
    var imp = parseFloat(r[9]) || 0;
    var stato = (r[11] || '').toString().toUpperCase();
    var a = map[email];
    a.n   += 1;
    a.tot += imp;
    if (stato === 'APPROVATA')           a.appr   += imp;
    else if (stato === 'DA AUTORIZZARE') a.auth   += imp;
    else                                 a.attesa += imp; // IN ATTESA / altro
  });

  // Ordina per totale decrescente
  var righe = Object.keys(map).map(function(email) {
    var a = map[email];
    return [a.agente, email, a.zona, a.n, a.tot, a.appr, a.auth, a.attesa];
  }).sort(function(x, y) { return y[4] - x[4]; });

  // Ricostruisce il foglio
  riep.clear();

  var titolo = 'RIEPILOGO MENSILE — ' + nomeMese_(meseAnno) + '  (agg. ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') + ')';
  riep.getRange(1, 1).setValue(titolo).setFontWeight('bold').setFontSize(12);

  var intest = ['Agente', 'Email', 'Zona', 'N. Spese',
                'Totale €', 'Approvate €', 'Da autorizzare €', 'In attesa €'];
  riep.getRange(2, 1, 1, intest.length).setValues([intest])
      .setFontWeight('bold').setBackground('#1565c0').setFontColor('#ffffff');

  if (righe.length > 0) {
    riep.getRange(3, 1, righe.length, intest.length).setValues(righe);

    // Riga totali generali
    var totRow = righe.length + 3;
    var sum = function(i) { return righe.reduce(function(s, r) { return s + r[i]; }, 0); };
    riep.getRange(totRow, 1, 1, intest.length)
        .setValues([['TOTALE', '', '', sum(3), sum(4), sum(5), sum(6), sum(7)]])
        .setFontWeight('bold').setBackground('#e3f2fd');

    // Formato valuta colonne E→H
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

// ================================================================
//  AZZERA SPESE MENSILI — svuota SPESE (lo STORICO resta intatto)
//  Accessibile a Cristiana dal menu "Note Spese" nel foglio.
// ================================================================
function azzeraSpeseMensili() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var spese = ss.getSheetByName(SHEET_SPESE);
  var ui = SpreadsheetApp.getUi();

  if (!spese) { ui.alert('Foglio "' + SHEET_SPESE + '" non trovato.'); return; }

  var lastRow = spese.getLastRow();
  var n = Math.max(0, lastRow - 1);
  if (n === 0) {
    ui.alert('Azzera spese', 'Non ci sono spese da azzerare nel foglio "' + SHEET_SPESE + '".', ui.ButtonSet.OK);
    return;
  }

  var resp = ui.alert(
    '⚠️ Azzera spese mensili',
    'Stai per svuotare il foglio "' + SHEET_SPESE + '" (' + n + ' righe).\n\n' +
    'Le spese restano comunque salvate nello "' + SHEET_STORICO + '".\n\n' +
    'Vuoi procedere?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Sicurezza: prima di svuotare, assicura che ogni riga di SPESE sia nello STORICO
    var dati = spese.getRange(2, 1, n, N_COL).getValues()
                    .filter(function(r) { return r[0] !== '' && r[0] !== null; });

    var storico = ss.getSheetByName(SHEET_STORICO);
    if (storico) {
      var idsStorico = {};
      var sLast = storico.getLastRow();
      if (sLast >= 2) {
        storico.getRange(2, 1, sLast - 1, 1).getValues().forEach(function(r) {
          if (r[0] !== '' && r[0] !== null) idsStorico[r[0].toString()] = true;
        });
      }
      dati.forEach(function(r) {
        if (!idsStorico[r[0].toString()]) writeRow_(storico, r);
      });
      SpreadsheetApp.flush();
    }

    // Svuota le righe dati di SPESE (mantiene l'intestazione)
    spese.getRange(2, 1, n, N_COL).clearContent();
    SpreadsheetApp.flush();

    // Rigenera il riepilogo (ora vuoto per il mese)
    aggiornaRiepilogoMensile();

    ui.alert('✅ Fatto',
      n + ' spese azzerate dal foglio "' + SHEET_SPESE + '".\nLo storico annuale è intatto.',
      ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
//  MENU nel foglio (per Cristiana)
// ================================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💼 Note Spese')
    .addItem('🔄 Aggiorna Riepilogo Mensile', 'aggiornaRiepilogoMensile')
    .addSeparator()
    .addItem('🧹 Azzera spese mensili', 'azzeraSpeseMensili')
    .addToUi();
}

// ================================================================
//  HELPERS
// ================================================================
// "MM-YYYY" del mese corrente (allineato a getMeseAnno() dell'HTML)
function meseAnnoCorrente_() {
  var d = new Date();
  return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + d.getFullYear();
}

// Normalizza il valore MeseAnno a "MM-YYYY" (gestisce Date o stringhe)
function normMese_(v) {
  if (v instanceof Date) return ('0' + (v.getMonth() + 1)).slice(-2) + '-' + v.getFullYear();
  return (v || '').toString().trim();
}

// "Luglio 2026" da "07-2026"
function nomeMese_(meseAnno) {
  var nomi = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
              'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  var p = meseAnno.toString().split('-');
  var m = parseInt(p[0], 10);
  return (m >= 1 && m <= 12) ? (nomi[m - 1] + ' ' + (p[1] || '')) : meseAnno;
}
