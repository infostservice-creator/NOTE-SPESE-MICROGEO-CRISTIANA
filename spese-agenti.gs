// ================================================================
//  NOTE SPESE — Microgeo S.r.l. & Dynatech S.r.l.
//  Google Apps Script — Backend sicuro per Google Sheets
//  Da deployare come Web App:
//    - Esegui come: Me (proprietario del foglio)
//    - Chi può accedere: Chiunque
//
//  Fogli (intestazioni su RIGA 3, dati dalla RIGA 4):
//    SPESE            → spese del mese corrente (viene azzerato ogni mese)
//    STORICO ANNUALE  → archivio permanente (ogni spesa ci finisce sempre)
//    RIEPILOGO MENSILE→ totali per agente (16 righe già presenti + TOTALE GENERALE)
//    ANAGRAFICA       → elenco agenti (non gestito da qui)
//
//  Struttura colonne SPESE / STORICO (A→M):
//    A ID           F Email        K Note agente
//    B DataInseri.  G Data spesa   L Stato        (menu a tendina — Cristiana)
//    C Nome         H Tipologia    M Note revisione (Cristiana)
//    D Cognome      I Km
//    E Zona         J Importo
//  → Il MeseAnno NON è una colonna: si ricava dalla "Data spesa".
//
//  Stati ammessi:  IN ATTESA · DA AUTORIZZARE · APPROVATA · RIFIUTATA
// ================================================================

const SHEET_ID        = '1sSEKcElDBML4QJfl1yEVC1YCptBbogqMDlJ-5ZmsPQI';
const SHEET_SPESE     = 'SPESE';
const SHEET_STORICO   = 'STORICO ANNUALE';
const SHEET_RIEPILOGO = 'RIEPILOGO MENSILE';

const N_COL          = 13; // colonne A-M
const FIRST_DATA_ROW = 4;  // in SPESE/STORICO i dati iniziano a riga 4 (header = riga 3)

// Colonne (1-based) modificabili da Cristiana
const COL_STATO   = 12; // L
const COL_NOTEREV = 13; // M

const STATI = ['IN ATTESA', 'DA AUTORIZZARE', 'APPROVATA', 'RIFIUTATA'];

// Lista email autorizzate (aggiornare quando cambiano gli agenti)
const ALLOWED_EMAILS = [
  // Microgeo
  'd.battaglia@microgeo.it', 'a.carraro@microgeo.it', 'c.ferrara@microgeo.it',
  'm.friggi@microgeo.it', 'd.guidotti@microgeo.it', 'i.racu@microgeo.it',
  's.solda@microgeo.it', 'a.deamicis@microgeo.it', 'm.costantino@microgeo.it',
  'f.conti@microgeo.it', 'g.palmer@microgeo.it', 'g.russo@microgeo.it',
  // Dynatech
  'f.damiani@dynatech.it', 's.toccaceli@dynatech.it', 'g.servodio@dynatech.it',
  'a.raimondi@dynatech.it',
  // Gmail personali (test / backup)
  'info.stservice@gmail.com', 'serradiosurf@gmail.com', 'giampaolo.servodio@gmail.com',
  'raimondiandrea9@gmail.com', 'damianifrancesco25@gmail.com',
];

// ── Risposta JSON ────────────────────────────────────────────────
function jsonOk(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonError(msg, code) {
  return ContentService.createTextOutput(JSON.stringify({ error: msg, code: code || 400 }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Entry point POST ─────────────────────────────────────────────
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var email   = (payload.email || '').toLowerCase().trim();

    if (ALLOWED_EMAILS.indexOf(email) === -1) {
      return jsonError('Email non autorizzata: ' + email, 403);
    }

    if (payload.action === 'append') return handleAppend(payload);
    if (payload.action === 'read')   return handleRead(email, payload.meseAnno);

    return jsonError('Azione non riconosciuta: ' + payload.action);
  } catch (err) {
    return jsonError('Errore server: ' + err.toString(), 500);
  }
}

function doGet(e) {
  return jsonOk({ status: 'ok', version: '3.0' });
}

// ================================================================
//  APPEND — scrive una riga su SPESE e STORICO ANNUALE
// ================================================================
function handleAppend(payload) {
  var row = payload.row;
  if (!row || row.length < N_COL) return jsonError('Riga non valida', 400);
  row = row.slice(0, N_COL);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // evita che invii simultanei finiscano sulla stessa riga
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);

    var sheetSpese = ss.getSheetByName(SHEET_SPESE);
    if (!sheetSpese) return jsonError('Foglio "' + SHEET_SPESE + '" non trovato', 404);
    writeRow_(sheetSpese, row);

    var sheetStorico = ss.getSheetByName(SHEET_STORICO);
    if (sheetStorico) writeRow_(sheetStorico, row);

    SpreadsheetApp.flush();
    try { aggiornaRiepilogoMensile(ss); } catch (e2) {}

    return jsonOk({ success: true, id: row[0] });
  } finally {
    lock.releaseLock();
  }
}

// Scrive nella prima riga dati realmente vuota (col A / ID vuota)
function writeRow_(sheet, row) {
  var r = getFirstEmptyDataRow(sheet);
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
}

/*
  FIX del bug appendRow: appendRow()/getLastRow() calcolano l'ultima riga in base
  a QUALSIASI colonna con contenuto, quindi possono scrivere in posizioni sbagliate.
  Qui cerchiamo la prima riga (dalla FIRST_DATA_ROW) con la colonna A (ID) vuota.
*/
function getFirstEmptyDataRow(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return FIRST_DATA_ROW;

  var n   = lastRow - FIRST_DATA_ROW + 1;
  var ids = sheet.getRange(FIRST_DATA_ROW, 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === '' || ids[i][0] === null) return FIRST_DATA_ROW + i;
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
  if (lastRow < FIRST_DATA_ROW) return jsonOk({ values: [] });

  var tz = ss.getSpreadsheetTimeZone();
  var values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, N_COL).getValues();

  // Filtra solo per email (col F = 5): SPESE contiene già il mese corrente.
  var filtered = values.filter(function(r) {
    if (r[0] === '' || r[0] === null) return false;
    return (r[5] || '').toString().toLowerCase().trim() === email;
  });

  // Converti Date/valori in stringhe (coerenza con l'HTML), col fuso del foglio
  filtered = filtered.map(function(r) {
    return r.map(function(cell, i) {
      if (cell instanceof Date) {
        return (i === 6)
          ? Utilities.formatDate(cell, tz, 'yyyy-MM-dd')
          : cell.toISOString();
      }
      return cell === null || cell === undefined ? '' : cell.toString();
    });
  });

  return jsonOk({ values: filtered });
}

// ================================================================
//  RIEPILOGO MENSILE — riempie il layout esistente (16 agenti + TOTALE)
//  Colonne: A Agente · B Zona · C Mese · D Approvato · E In Attesa
//           F Rifiutato · G Da Autor. · H TOTALE
// ================================================================
function aggiornaRiepilogoMensile(ss) {
  ss = ss || SpreadsheetApp.openById(SHEET_ID);
  var spese = ss.getSheetByName(SHEET_SPESE);
  var riep  = ss.getSheetByName(SHEET_RIEPILOGO);
  if (!spese || !riep) return 0;

  var meseAnno  = meseAnnoCorrente_();
  var meseLabel = nomeMese_(meseAnno);

  // Aggrega le spese del mese corrente per agente (chiave = nome normalizzato)
  var lastRow = spese.getLastRow();
  var data = lastRow >= FIRST_DATA_ROW
    ? spese.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, N_COL).getValues()
    : [];

  var map = {};
  data.forEach(function(r) {
    if (r[0] === '' || r[0] === null) return;
    // SPESE contiene già solo il mese corrente (viene azzerato ogni mese):
    // nessun filtro sul mese, così evitiamo problemi di fuso/formato della data.
    var key = normName_((r[2] || '') + ' ' + (r[3] || ''));
    if (!map[key]) map[key] = { appr: 0, attesa: 0, rifiut: 0, auth: 0 };
    var imp = parseFloat(r[9]) || 0;
    var st  = (r[11] || '').toString().toUpperCase().trim();
    if (st === 'APPROVATA')           map[key].appr   += imp;
    else if (st === 'RIFIUTATA')      map[key].rifiut += imp;
    else if (st === 'DA AUTORIZZARE') map[key].auth   += imp;
    else                              map[key].attesa += imp; // IN ATTESA
  });

  // Individua le righe agenti e la riga "TOTALE GENERALE"
  var lastR = riep.getLastRow();
  var colA  = riep.getRange(1, 1, lastR, 1).getValues();
  var totRow = -1;
  for (var i = 0; i < colA.length; i++) {
    if ((colA[i][0] || '').toString().toUpperCase().indexOf('TOTALE GENERALE') >= 0) {
      totRow = i + 1; break;
    }
  }
  var firstAgentRow = 3;
  var lastAgentRow  = (totRow > 0) ? totRow - 1 : lastR;
  if (lastAgentRow < firstAgentRow) return 0;

  var names = riep.getRange(firstAgentRow, 1, lastAgentRow - firstAgentRow + 1, 1).getValues();

  // Costruisce i valori C..H per ogni riga agente
  var out = [];
  var sAppr = 0, sAtt = 0, sRif = 0, sAuth = 0, sTot = 0;
  names.forEach(function(n) {
    var name = (n[0] || '').toString();
    if (!name.trim()) { out.push(['', '', '', '', '', '']); return; }
    var m = map[normName_(name)] || { appr: 0, attesa: 0, rifiut: 0, auth: 0 };
    var tot = m.appr + m.attesa + m.rifiut + m.auth;
    out.push([meseLabel, m.appr, m.attesa, m.rifiut, m.auth, tot]);
    sAppr += m.appr; sAtt += m.attesa; sRif += m.rifiut; sAuth += m.auth; sTot += tot;
  });

  if (out.length > 0) {
    riep.getRange(firstAgentRow, 3, out.length, 6).setValues(out); // C..H
  }
  if (totRow > 0) {
    riep.getRange(totRow, 3, 1, 6).setValues([['', sAppr, sAtt, sRif, sAuth, sTot]]);
  }
  return out.length;
}

// ================================================================
//  AZZERA SPESE MENSILI — svuota SPESE (lo STORICO resta intatto)
// ================================================================
function azzeraSpeseMensili() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var spese = ss.getSheetByName(SHEET_SPESE);
  var ui = SpreadsheetApp.getUi();
  if (!spese) { ui.alert('Foglio "' + SHEET_SPESE + '" non trovato.'); return; }

  var lastRow = spese.getLastRow();
  var n = Math.max(0, lastRow - FIRST_DATA_ROW + 1);
  if (n === 0) {
    ui.alert('Azzera spese', 'Non ci sono spese da azzerare.', ui.ButtonSet.OK);
    return;
  }

  var resp = ui.alert('⚠️ Azzera spese mensili',
    'Stai per svuotare il foglio "' + SHEET_SPESE + '" (' + n + ' righe).\n\n' +
    'Le spese restano comunque salvate nello "' + SHEET_STORICO + '".\n\nVuoi procedere?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Sicurezza: assicura che ogni riga di SPESE sia già nello STORICO
    var dati = spese.getRange(FIRST_DATA_ROW, 1, n, N_COL).getValues()
                    .filter(function(r) { return r[0] !== '' && r[0] !== null; });

    var storico = ss.getSheetByName(SHEET_STORICO);
    if (storico) {
      var idsStorico = {};
      var sLast = storico.getLastRow();
      if (sLast >= FIRST_DATA_ROW) {
        storico.getRange(FIRST_DATA_ROW, 1, sLast - FIRST_DATA_ROW + 1, 1).getValues()
          .forEach(function(r) { if (r[0]) idsStorico[r[0].toString()] = true; });
      }
      dati.forEach(function(r) { if (!idsStorico[r[0].toString()]) writeRow_(storico, r); });
      SpreadsheetApp.flush();
    }

    // Svuota le righe dati di SPESE (mantiene intestazione e menu a tendina)
    spese.getRange(FIRST_DATA_ROW, 1, n, N_COL).clearContent();
    SpreadsheetApp.flush();

    aggiornaRiepilogoMensile(ss);

    ui.alert('✅ Fatto',
      n + ' spese azzerate da "' + SHEET_SPESE + '".\nLo storico annuale è intatto.',
      ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
//  MENU A TENDINA "STATO" — imposta validazione + colori su SPESE!L
// ================================================================
function impostaMenuStato() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_SPESE);
  if (!sh) { SpreadsheetApp.getUi().alert('Foglio "' + SHEET_SPESE + '" non trovato.'); return; }

  var nRows = sh.getMaxRows() - FIRST_DATA_ROW + 1;
  var rangeL = sh.getRange(FIRST_DATA_ROW, COL_STATO, nRows, 1);

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATI, true)
    .setAllowInvalid(false)
    .build();
  rangeL.setDataValidation(rule);

  // Colori (formattazione condizionale) — rimuove eventuali regole vecchie su col L
  var kept = sh.getConditionalFormatRules().filter(function(r) {
    var rs = r.getRanges();
    for (var i = 0; i < rs.length; i++) if (rs[i].getColumn() === COL_STATO) return false;
    return true;
  });
  function mk(val, bg, fc) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(val).setBackground(bg).setFontColor(fc).setRanges([rangeL]).build();
  }
  kept.push(mk('IN ATTESA',      '#fff8e1', '#e65100'));
  kept.push(mk('DA AUTORIZZARE', '#ffebee', '#c62828'));
  kept.push(mk('APPROVATA',      '#e8f5e9', '#2e7d32'));
  kept.push(mk('RIFIUTATA',      '#f5f5f5', '#757575'));
  sh.setConditionalFormatRules(kept);

  SpreadsheetApp.getUi().alert('✅ Menu a tendina "Stato" impostato',
    'Valori: ' + STATI.join(' · '), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ================================================================
//  onEdit — quando Cristiana cambia Stato o Note revisione in SPESE:
//    · propaga il valore allo STORICO ANNUALE (stessa ID)
//    · ricalcola il RIEPILOGO MENSILE
// ================================================================
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEET_SPESE) return;

    var col = e.range.getColumn();
    var row = e.range.getRow();
    if (row < FIRST_DATA_ROW) return;
    if (col !== COL_STATO && col !== COL_NOTEREV) return;

    var ss = e.source;
    var vals = sh.getRange(row, 1, 1, N_COL).getValues()[0];
    var id = vals[0];

    // Propaga allo STORICO (riga con stessa ID)
    if (id) {
      var stor = ss.getSheetByName(SHEET_STORICO);
      if (stor) {
        var last = stor.getLastRow();
        if (last >= FIRST_DATA_ROW) {
          var ids = stor.getRange(FIRST_DATA_ROW, 1, last - FIRST_DATA_ROW + 1, 1).getValues();
          for (var i = 0; i < ids.length; i++) {
            if (ids[i][0] === id) {
              var tr = FIRST_DATA_ROW + i;
              stor.getRange(tr, COL_STATO).setValue(vals[COL_STATO - 1]);
              stor.getRange(tr, COL_NOTEREV).setValue(vals[COL_NOTEREV - 1]);
              break;
            }
          }
        }
      }
    }

    aggiornaRiepilogoMensile(ss);
  } catch (err) {
    // onEdit silenzioso: non bloccare l'editing di Cristiana
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
    .addItem('🎛️ Imposta menu a tendina Stato', 'impostaMenuStato')
    .addItem('🧹 Azzera spese mensili', 'azzeraSpeseMensili')
    .addToUi();
}

// ================================================================
//  HELPERS
// ================================================================
// "MM-YYYY" del mese corrente
function meseAnnoCorrente_() {
  var d = new Date();
  return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + d.getFullYear();
}

// "MM-YYYY" dal valore "Data spesa" (Date oppure "yyyy-MM-dd")
function monthFromCell_(v) {
  if (v instanceof Date) return ('0' + (v.getMonth() + 1)).slice(-2) + '-' + v.getFullYear();
  var m = (v || '').toString().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[2] + '-' + m[1]) : '';
}

// "Luglio 2026" da "07-2026"
function nomeMese_(meseAnno) {
  var nomi = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
              'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  var p = meseAnno.toString().split('-');
  var m = parseInt(p[0], 10);
  return (m >= 1 && m <= 12) ? (nomi[m - 1] + ' ' + (p[1] || '')) : meseAnno;
}

// Normalizza un nome per confronti robusti (minuscolo, senza accenti, spazi singoli)
function normName_(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}
