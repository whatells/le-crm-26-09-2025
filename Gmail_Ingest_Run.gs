/**
 * Module: Gmail_Ingest_Run
 * Rôle: orchestrer l'ingestion Gmail en version standard (stock JSON, ventes, favoris/offres, achats).
 * Entrées publiques: ingestAllLabels(), ingestStockJson(), ingestSales(), ingestFavsOffersVinted(), ingestPurchasesVinted().
 * Dépendances: GmailApp (labels), SpreadsheetApp (Stock, Ventes, Achats), parseurs de Gmail_Ingest_Parsers, getConfig_().
 * Effets de bord: marque les threads Traite/Erreur, upsert des lignes dans Stock/Ventes/Achats, incrémente compteurs.
 * Pièges: accès cellule par cellule (risque quotas), cohérence avec Step8 override insertSale_(), labels config sensibles à la casse.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: écriture batch setValues, instrumentation console.time et backoff unifié pour Gmail.
 */

const STOCK_SHEET_NAME = 'Stock';
const SALES_SHEET_NAME = 'Ventes';
const PURCHASES_SHEET_NAME = 'Achats';
const DEFAULT_LABEL_DONE = 'Traite';
const DEFAULT_LABEL_ERROR = 'Erreur';

// ---- Raccourcis labels (avec valeurs par défaut si la Config est vide) ----
function labels_() {
  return {
    INGEST_STOCK: String(cfg_('GMAIL_LABEL_INGEST_STOCK', 'Ingestion/Stock')),
    SALES_VINTED: String(cfg_('GMAIL_LABEL_SALES_VINTED', 'Sales/Vinted')),
    SALES_VESTIAIRE: String(cfg_('GMAIL_LABEL_SALES_VESTIAIRE', 'Sales/Vestiaire')),
    SALES_EBAY: String(cfg_('GMAIL_LABEL_SALES_EBAY', 'Sales/eBay')),
    SALES_LEBONCOIN: String(cfg_('GMAIL_LABEL_SALES_LEBONCOIN', 'Sales/Leboncoin')),
    SALES_WHATNOT: String(cfg_('GMAIL_LABEL_SALES_WHATNOT', 'Sales/Whatnot')),
    FAV_VINTED: String(cfg_('GMAIL_LABEL_FAVORITES_VINTED', 'Favorites/Vinted')),
    OFF_VINTED: String(cfg_('GMAIL_LABEL_OFFERS_VINTED', 'Offers/Vinted')),
    PUR_VINTED: String(cfg_('GMAIL_LABEL_PURCHASES_VINTED', 'Purchases/Vinted'))
  };
}

// ---- Helpers backoff ----
function ensureLabel_(name) {
  const existing = withBackoff_(() => GmailApp.getUserLabelByName(name));
  return existing || withBackoff_(() => GmailApp.createLabel(name));
}

function searchThreads_(query, start, max) {
  return withBackoff_(() => GmailApp.search(query, start, max));
}

function threadMessages_(thread) {
  return withBackoff_(() => thread.getMessages());
}

function threadAddLabel_(thread, label) {
  return withBackoff_(() => thread.addLabel(label));
}

// ---- Orchestrateur ----
function ingestAllLabels() {
  console.time('ingestAllLabels');
  try {
    ingestStockJson();
    ingestSales();
    ingestPurchasesVinted();
    ingestFavsOffersVinted();
  } finally {
    console.timeEnd('ingestAllLabels');
  }
}

// ---- STOCK via JSON ----
function ingestStockJson() {
  console.time('ingestStockJson');
  try {
    const l = labels_().INGEST_STOCK;
    const threadQuery = 'label:"' + l + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR;
    const threads = searchThreads_(threadQuery, 0, 50);
    if (!threads.length) {
      return;
    }

    const labelDone = ensureLabel_(DEFAULT_LABEL_DONE);
    const labelErr = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(STOCK_SHEET_NAME);
    if (!sh) {
      return;
    }

    threads.forEach(thread => {
      const msgs = threadMessages_(thread);
      msgs.forEach(msg => {
        const parsed = parseStockJsonMessage_(msg);
        if (!parsed) {
          return;
        }
        try {
          upsertStock_(sh, parsed.data);
          threadAddLabel_(thread, labelDone);
          markProcessed_('INFO', 'ingestStockJson', 'OK', '', parsed.id);
        } catch (err) {
          threadAddLabel_(thread, labelErr);
          markProcessed_('ERROR', 'ingestStockJson', 'KO', String(err), parsed.id);
        }
      });
    });
  } finally {
    console.timeEnd('ingestStockJson');
  }
}

function upsertStock_(sh, obj) {
  const headers = { sku: 2, title: 3, photos: 4, category: 5, brand: 6, size: 7, condition: 8, platform: 12 };
  const last = sh.getLastRow();
  let row = 0;
  if (last >= 2) {
    const rng = sh.getRange(2, headers.sku, last - 1, 1).getValues();
    for (let i = 0; i < rng.length; i++) {
      if (String(rng[i][0]).toUpperCase() === String(obj.sku).toUpperCase()) {
        row = i + 2;
        break;
      }
    }
  }
  if (!row) {
    row = Math.max(2, last + 1);
  }

  const width = Math.max(15, sh.getLastColumn());
  const current = sh.getRange(row, 1, 1, width).getValues()[0];
  if (!current[0]) {
    current[0] = new Date();
  }
  if (obj.sku) {
    current[headers.sku - 1] = String(obj.sku).toUpperCase();
  }
  if (obj.title) {
    current[headers.title - 1] = obj.title;
  }
  if (obj.photos) {
    current[headers.photos - 1] = Array.isArray(obj.photos) ? obj.photos.join('\n') : obj.photos;
  }
  if (obj.category) {
    current[headers.category - 1] = obj.category;
  }
  if (obj.brand) {
    current[headers.brand - 1] = obj.brand;
  }
  if (obj.size) {
    current[headers.size - 1] = obj.size;
  }
  if (obj.condition) {
    current[headers.condition - 1] = obj.condition;
  }
  if (obj.platform) {
    current[headers.platform - 1] = obj.platform;
  }

  sh.getRange(row, 1, 1, width).setValues([current]);
}

// ---- VENTES ----
function ingestSales() {
  console.time('ingestSales');
  try {
    const L = labels_();
    const map = [
      { label: L.SALES_VINTED, platform: 'Vinted' },
      { label: L.SALES_VESTIAIRE, platform: 'Vestiaire' },
      { label: L.SALES_EBAY, platform: 'eBay' },
      { label: L.SALES_LEBONCOIN, platform: 'Leboncoin' },
      { label: L.SALES_WHATNOT, platform: 'Whatnot' }
    ];
    const labelDone = ensureLabel_(DEFAULT_LABEL_DONE);
    const labelErr = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(SALES_SHEET_NAME);
    if (!sh) {
      return;
    }

    map.forEach(({ label, platform }) => {
      const threads = searchThreads_('label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR, 0, 50);
      threads.forEach(thread => {
        const msgs = threadMessages_(thread);
        msgs.forEach(msg => {
          const parsed = parseSaleMessage_(platform, msg);
          if (!parsed) {
            return;
          }
          try {
            insertSale_(sh, parsed.data);
            threadAddLabel_(thread, labelDone);
            markProcessed_('INFO', 'ingestSales', 'OK', '', parsed.id);
          } catch (err) {
            threadAddLabel_(thread, labelErr);
            markProcessed_('ERROR', 'ingestSales', 'KO', String(err), parsed.id);
          }
        });
      });
    });
  } finally {
    console.timeEnd('ingestSales');
  }
}

function insertSale_(sh, d) {
  const conf = typeof getConfig_ === 'function' ? getConfig_() : {};
  const pctKey = 'COMMISSION_' + String(d.platform || '').toUpperCase();
  const pct = Number(conf[pctKey] || 0);
  const last = sh.getLastRow();
  const row = Math.max(2, last + 1);
  const width = Math.max(10, sh.getLastColumn());
  const values = new Array(width).fill('');
  values[0] = new Date();
  values[1] = d.platform;
  values[2] = d.title;
  values[3] = d.price;
  values[4] = d.price * pct;
  values[7] = d.sku || '';
  sh.getRange(row, 1, 1, width).setValues([values]);
}

// ---- FAVORIS & OFFRES Vinted ----
function ingestFavsOffersVinted() {
  console.time('ingestFavsOffersVinted');
  try {
    const L = labels_();
    const defs = [
      { label: L.FAV_VINTED, type: 'fav' },
      { label: L.OFF_VINTED, type: 'offer' }
    ];
    const labelDone = ensureLabel_(DEFAULT_LABEL_DONE);
    const labelErr = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(STOCK_SHEET_NAME);
    if (!sh) {
      return;
    }

    defs.forEach(({ label, type }) => {
      const threads = searchThreads_('label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR, 0, 50);
      threads.forEach(thread => {
        const msgs = threadMessages_(thread);
        msgs.forEach(msg => {
          const parsed = parseFavOfferMessage_(type, msg);
          if (!parsed) {
            return;
          }
          try {
            bumpCounter_(sh, parsed.data);
            threadAddLabel_(thread, labelDone);
            markProcessed_('INFO', 'ingestFavOffer', 'OK', '', parsed.id);
          } catch (err) {
            threadAddLabel_(thread, labelErr);
            markProcessed_('ERROR', 'ingestFavOffer', 'KO', String(err), parsed.id);
          }
        });
      });
    });
  } finally {
    console.timeEnd('ingestFavsOffersVinted');
  }
}

function bumpCounter_(sh, d) {
  const last = sh.getLastRow();
  if (last < 2) {
    return;
  }
  const rng = sh.getRange(2, 2, last - 1, 1).getValues();
  let row = 0;
  for (let i = 0; i < rng.length; i++) {
    if (String(rng[i][0]).toUpperCase() === String(d.sku).toUpperCase()) {
      row = i + 2;
      break;
    }
  }
  if (!row) {
    return;
  }
  const col = d.type === 'fav' ? 14 : 15;
  const current = Number(sh.getRange(row, col).getValue() || 0);
  sh.getRange(row, col, 1, 1).setValues([[current + 1]]);
}

// ---- ACHATS Vinted ----
function ingestPurchasesVinted() {
  console.time('ingestPurchasesVinted');
  try {
    const label = labels_().PUR_VINTED;
    const threads = searchThreads_('label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR, 0, 50);
    if (!threads.length) {
      return;
    }
    const labelDone = ensureLabel_(DEFAULT_LABEL_DONE);
    const labelErr = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(PURCHASES_SHEET_NAME);
    if (!sh) {
      return;
    }

    threads.forEach(thread => {
      const msgs = threadMessages_(thread);
      msgs.forEach(msg => {
        const parsed = parsePurchaseVinted_(msg);
        if (!parsed) {
          return;
        }
        try {
          const last = sh.getLastRow();
          const row = Math.max(2, last + 1);
          const width = Math.max(6, sh.getLastColumn());
          const values = new Array(width).fill('');
          values[0] = parsed.data.date;
          values[1] = parsed.data.fournisseur;
          values[2] = parsed.data.price;
          values[4] = parsed.data.brand;
          values[5] = parsed.data.size;
          sh.getRange(row, 1, 1, width).setValues([values]);
          threadAddLabel_(thread, labelDone);
          markProcessed_('INFO', 'ingestPurchases', 'OK', '', parsed.id);
        } catch (err) {
          threadAddLabel_(thread, labelErr);
          markProcessed_('ERROR', 'ingestPurchases', 'KO', String(err), parsed.id);
        }
      });
    });
  } finally {
    console.timeEnd('ingestPurchasesVinted');
  }
}
