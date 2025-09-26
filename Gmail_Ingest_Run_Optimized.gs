/**
 * Module: Gmail_Ingest_Run_Optimized
 * Rôle: version optimisée de l'ingestion Gmail (batch, cache, pagination, idempotence avancée).
 * Entrées publiques: ingestAllLabelsFast() et wrappers internes ingestStockJsonFast_(), ingestSalesFast_(), ingestPurchasesVintedFast_(), ingestFavsOffersFast_().
 * Dépendances: GmailApp, CacheService/PropertiesService (stateGet_/statePut_), parseurs existants, SpreadsheetApp (Stock/Ventes/Achats).
 * Effets de bord: met à jour labels, remplit les feuilles, persiste des curseurs/procIds dans l'état utilisateur.
 * Pièges: veillez à purger les caches via step10ClearCaches(), quotas Gmail/UrlFetch selon volume, complexité accrue de pagination.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: instrumentation console.time, backoff partagé et utilisation des helpers batch pour les écritures.
 */

function ingestAllLabelsFast() {
  console.time('ingestAllLabelsFast');
  try {
    const L = labels_();
    ingestStockJsonFast_(L.INGEST_STOCK);
    ingestSalesFast_([
      { label: L.SALES_VINTED, platform: 'Vinted' },
      { label: L.SALES_VESTIAIRE, platform: 'Vestiaire' },
      { label: L.SALES_EBAY, platform: 'eBay' },
      { label: L.SALES_LEBONCOIN, platform: 'Leboncoin' },
      { label: L.SALES_WHATNOT, platform: 'Whatnot' }
    ]);
    ingestPurchasesVintedFast_(L.PUR_VINTED);
    ingestFavsOffersFast_([
      { label: L.FAV_VINTED, type: 'fav' },
      { label: L.OFF_VINTED, type: 'offer' }
    ]);
    logE_('INFO', 'IngestFast', 'Terminé', '');
  } finally {
    console.timeEnd('ingestAllLabelsFast');
  }
}

// --- Proc IDs (idempotence mémoire + persistance légère) ---
const PROC_IDS_FAST_KEY = 'PROC_IDS';
let PROC_IDS_FAST_CACHE = null;

function getProcIds_() {
  if (!PROC_IDS_FAST_CACHE) {
    PROC_IDS_FAST_CACHE = stateGet_(PROC_IDS_FAST_KEY, {}) || {};
  }
  return PROC_IDS_FAST_CACHE;
}

function addProcId_(id) {
  if (!id) return;
  const map = getProcIds_();
  map[id] = Date.now();
  pruneProcIdsFast_(map);
  statePut_(PROC_IDS_FAST_KEY, map);
}

function seenProcId_(id) {
  const map = getProcIds_();
  return !!map[id];
}

function pruneProcIdsFast_(map) {
  const keys = Object.keys(map);
  const LIMIT = 500;
  if (keys.length <= LIMIT) return;
  keys.sort((a, b) => Number(map[a] || 0) - Number(map[b] || 0));
  while (keys.length > LIMIT) {
    const key = keys.shift();
    delete map[key];
  }
}

// --- Pagination threads (curseur en state) ---
function nextThreads_(query, batchSize) {
  const cursorKey = 'THREAD_CURSOR::' + query;
  const now = Date.now();
  let cursor = stateGet_(cursorKey, null);
  if (typeof cursor === 'number') {
    cursor = { page: cursor, ts: 0, done: false };
  }
  if (!cursor) {
    cursor = { page: 0, ts: now, done: false };
  } else if (cursor.done) {
    stateDel_(cursorKey);
    return [];
  } else if (cursor.ts && now - cursor.ts > 3600000) {
    cursor = { page: 0, ts: now, done: false };
  }

  const page = cursor.page || 0;
  const threads = searchThreads_(query, page * batchSize, batchSize);
  if (threads.length === 0) {
    stateDel_(cursorKey);
    return [];
  }

  cursor = { page: page + 1, ts: now, done: threads.length < batchSize };
  statePut_(cursorKey, cursor);
  return threads;
}

// ========== STOCK JSON ==========
function ingestStockJsonFast_(label) {
  console.time('ingestStockJsonFast');
  try {
    const done = ensureLabel_(DEFAULT_LABEL_DONE);
    const err = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(STOCK_SHEET_NAME);
    if (!sh) {
      return;
    }
    const query = 'label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR;
    let threads;
    while ((threads = nextThreads_(query, 25)).length) {
      for (const t of threads) {
        const msgs = threadMessages_(t);
        for (const m of msgs) {
          const id = m.getId();
          if (seenProcId_(id)) continue;
          const parsed = parseStockJsonMessage_(m);
          if (!parsed) {
            addProcId_(id);
            continue;
          }
          try {
            upsertStock_(sh, parsed.data);
            threadAddLabel_(t, done);
            addProcId_(id);
          } catch (e) {
            threadAddLabel_(t, err);
            logE_('ERROR', 'ingestStockJsonFast', String(e), id);
          }
        }
      }
    }
  } finally {
    console.timeEnd('ingestStockJsonFast');
  }
}

// ========== VENTES ==========
function ingestSalesFast_(defs) {
  console.time('ingestSalesFast');
  try {
    const done = ensureLabel_(DEFAULT_LABEL_DONE);
    const err = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(SALES_SHEET_NAME);
    if (!sh) {
      return;
    }

    defs.forEach(({ label, platform }) => {
      const query = 'label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR;
      let threads;
      while ((threads = nextThreads_(query, 20)).length) {
        for (const t of threads) {
          const msgs = threadMessages_(t);
          for (const m of msgs) {
            const id = m.getId();
            if (seenProcId_(id)) continue;
            const parsed = parseSaleMessage_(platform, m);
            if (!parsed) {
              addProcId_(id);
              continue;
            }
            try {
              insertSale_(sh, parsed.data);
              threadAddLabel_(t, done);
              addProcId_(id);
            } catch (e) {
              threadAddLabel_(t, err);
              logE_('ERROR', 'ingestSalesFast', String(e), id);
            }
          }
        }
      }
    });
  } finally {
    console.timeEnd('ingestSalesFast');
  }
}

// ========== ACHATS ==========
function ingestPurchasesVintedFast_(label) {
  console.time('ingestPurchasesVintedFast');
  try {
    const done = ensureLabel_(DEFAULT_LABEL_DONE);
    const err = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(PURCHASES_SHEET_NAME);
    if (!sh) {
      return;
    }
    const query = 'label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR;
    let threads;
    while ((threads = nextThreads_(query, 20)).length) {
      for (const t of threads) {
        const msgs = threadMessages_(t);
        for (const m of msgs) {
          const id = m.getId();
          if (seenProcId_(id)) continue;
          const parsed = parsePurchaseVinted_(m);
          if (!parsed) {
            addProcId_(id);
            continue;
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
            threadAddLabel_(t, done);
            addProcId_(id);
          } catch (e) {
            threadAddLabel_(t, err);
            logE_('ERROR', 'ingestPurchasesFast', String(e), id);
          }
        }
      }
    }
  } finally {
    console.timeEnd('ingestPurchasesVintedFast');
  }
}

// ========== FAVORIS / OFFRES ==========
function ingestFavsOffersFast_(defs) {
  console.time('ingestFavsOffersFast');
  try {
    const done = ensureLabel_(DEFAULT_LABEL_DONE);
    const err = ensureLabel_(DEFAULT_LABEL_ERROR);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName(STOCK_SHEET_NAME);
    if (!sh) {
      return;
    }

    defs.forEach(({ label, type }) => {
      const query = 'label:"' + label + '" -label:' + DEFAULT_LABEL_DONE + ' -label:' + DEFAULT_LABEL_ERROR;
      let threads;
      while ((threads = nextThreads_(query, 20)).length) {
        for (const t of threads) {
          const msgs = threadMessages_(t);
          for (const m of msgs) {
            const id = m.getId();
            if (seenProcId_(id)) continue;
            const parsed = parseFavOfferMessage_(type, m);
            if (!parsed) {
              addProcId_(id);
              continue;
            }
            try {
              bumpCounter_(sh, parsed.data);
              threadAddLabel_(t, done);
              addProcId_(id);
            } catch (e) {
              threadAddLabel_(t, err);
              logE_('ERROR', 'ingestFavOfferFast', String(e), id);
            }
          }
        }
      }
    });
  } finally {
    console.timeEnd('ingestFavsOffersFast');
  }
}
