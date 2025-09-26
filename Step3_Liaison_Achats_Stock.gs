/**
 * Module: Step3_Liaison_Achats_Stock
 * Rôle: synchroniser Achats ↔ Stock (références automatiques et propagation des prix).
 * Entrées publiques: step3RefreshRefs(), step3PropagateAll(), step3PropagateCurrent().
 * Dépendances: SpreadsheetApp (Achats, Stock), CacheService (STEP3::REF_PRICE_MAP), log_(), Step8 invalidate.
 * Effets de bord: met à jour validations, remplit colonnes Réf Achat / Prix achat, utilise caches en Properties/Cache.
 * Pièges: invalidation nécessaire avant recalcul, attention aux appels en masse (getRange volumineux), dépend des entêtes existants.
 * MAJ: 2025-09-26 – Codex Audit
 */
// ==============================
// FICHIER 3 / 3 : Step3_Liaison_Achats_Stock.gs (COMPLET)
// ==============================

/**
 * Étape 3 — Liaison Achats ↔ Stock
 * Objectif : choisir une "Réf. Achat" (générée automatiquement) dans Stock!M
 * et propager le "Prix achat" depuis Achats!C vers Stock!I.
 *
 * Implémentation :
 * - Ajoute/maintient une colonne "Réf (auto)" en fin d’onglet Achats (colonne I)
 *   avec des IDs de type ACH-00001, ACH-00002…
 * - Fait une liste déroulante dans Stock!M basée sur Achats!I
 * - À la sélection d’une Réf, on recopie le Prix achat correspondant dans Stock!I
 */

var SHEET_ACHATS = "Achats";
var COL_ACHATS_DATE = 1;     // A
var COL_ACHATS_FOURN = 2;    // B
var COL_ACHATS_PRIX = 3;     // C
var COL_ACHATS_REF  = 9;     // I (ajouté automatiquement : "Réf (auto)")

var COL_STOCK_PRIX_ACHAT = 9; // I
var COL_STOCK_REF_ACHAT  = 13; // M

var STEP3_REF_PRICE_CACHE_KEY = 'STEP3::REF_PRICE_MAP';
var STEP3_REF_PRICE_CACHE_TTL = 600;
var STEP3_REF_PRICE_MAP_CACHE = null;

// ---- Menu actions ----
function step3RefreshRefs() {
  return timed_("step3RefreshRefs", function(getMs) {
    var ss = SpreadsheetApp.getActive();
    var shA = ss.getSheetByName(SHEET_ACHATS);
    var shS = ss.getSheetByName(SHEET_STOCK);
    if (!shA || !shS) return;

    step3InvalidateRefCache_();
    step3EnsureAchatsRefColumn_(shA);
    step3FillRefs_(shA);
    step3PrimeRefCache_(shA);
    step3ApplyStockValidation_(shS, shA);
    log_("INFO", "Étape3", "Références Achats générées + liste déroulante mise à jour", "server ms=" + getMs());
  });
}

function step3PropagateAll() {
  return timed_("step3PropagateAll", function(getMs) {
    var ss = SpreadsheetApp.getActive();
    var shA = ss.getSheetByName(SHEET_ACHATS);
    var shS = ss.getSheetByName(SHEET_STOCK);
    if (!shA || !shS) return;

    var map = step3BuildRefToPriceMap_(shA);
    var lastRow = shS.getLastRow();
    if (lastRow < 2) {
      log_("INFO", "Étape3", "Propagation complète effectuée", "server ms=" + getMs());
      return;
    }

    var rows = lastRow - 1;
    var refsRange = shS.getRange(2, COL_STOCK_REF_ACHAT, rows, 1);
    var refValues = refsRange.getValues();
    var priceRange = shS.getRange(2, COL_STOCK_PRIX_ACHAT, rows, 1);
    var priceValues = priceRange.getValues();
    var newPrices = priceValues.map(function(row) { return [row[0]]; });
    var changed = false;

    for (var i = 0; i < rows; i++) {
      var ref = String(refValues[i][0] || "").trim();
      if (!ref) continue;
      var price = map[ref];
      if (price == null || price === "") continue;
      if (String(priceValues[i][0]) !== String(price)) {
        newPrices[i][0] = price;
        changed = true;
      }
    }

    if (changed) {
      priceRange.setValues(newPrices);
      if (typeof step8InvalidateCostCache_ === 'function') {
        try {
          step8InvalidateCostCache_();
        } catch (_) {}
      }
    }

    log_("INFO", "Étape3", "Propagation complète effectuée", "server ms=" + getMs());
  });
}

function step3PropagateCurrent() {
  var shS = SpreadsheetApp.getActiveSheet();
  if (!shS || shS.getName() !== SHEET_STOCK) return;
  var r = shS.getActiveRange().getRow();
  if (r < 2) return;
  step3PropagateRow_(shS, r);
}

// ---- Cœur de la liaison ----
function step3PropagateRow_(stockSheet, row) {
  var ss = SpreadsheetApp.getActive();
  var shA = ss.getSheetByName(SHEET_ACHATS);
  if (!shA) return;
  var map = step3BuildRefToPriceMap_(shA);
  step3PropagateRowWithMap_(stockSheet, row, map);
}

function step3PropagateRowWithMap_(shS, row, map) {
  var ref = String(shS.getRange(row, COL_STOCK_REF_ACHAT).getValue() || "").trim();
  if (!ref) return;
  var price = map[ref];
  if (price == null || price === "") return;
  var cell = shS.getRange(row, COL_STOCK_PRIX_ACHAT);
  var current = cell.getValue();
  if (String(current) !== String(price)) {
    cell.setValue(price);
    if (typeof step8InvalidateCostCache_ === 'function') {
      try {
        step8InvalidateCostCache_();
      } catch (_) {}
    }
  }
}

function step3BuildRefToPriceMap_(shA) {
  if (STEP3_REF_PRICE_MAP_CACHE) {
    return STEP3_REF_PRICE_MAP_CACHE;
  }

  var cache = CacheService.getDocumentCache();
  if (cache) {
    var cached = cache.get(STEP3_REF_PRICE_CACHE_KEY);
    if (cached) {
      try {
        var payload = JSON.parse(cached);
        if (payload && typeof payload.map === 'object') {
          STEP3_REF_PRICE_MAP_CACHE = payload.map || {};
        } else {
          STEP3_REF_PRICE_MAP_CACHE = payload || {};
        }
        return STEP3_REF_PRICE_MAP_CACHE;
      } catch (e) {
        step3InvalidateRefCache_();
      }
    }
  }

  var props = PropertiesService.getDocumentProperties();
  var stored = props.getProperty(STEP3_REF_PRICE_CACHE_KEY);
  if (stored) {
    try {
      var payloadProp = JSON.parse(stored);
      if (payloadProp && typeof payloadProp.map === 'object') {
        STEP3_REF_PRICE_MAP_CACHE = payloadProp.map || {};
      } else {
        STEP3_REF_PRICE_MAP_CACHE = payloadProp || {};
      }
      if (cache) cache.put(STEP3_REF_PRICE_CACHE_KEY, stored, STEP3_REF_PRICE_CACHE_TTL);
      return STEP3_REF_PRICE_MAP_CACHE;
    } catch (err) {
      step3InvalidateRefCache_();
    }
  }

  return step3PrimeRefCache_(shA);
}

// ---- Préparation côté Achats ----
function step3EnsureAchatsRefColumn_(shA) {
  var lastCol = shA.getLastColumn();
  if (lastCol < COL_ACHATS_REF) {
    // Ajoute des colonnes jusqu’à I si besoin
    shA.insertColumnsAfter(lastCol, COL_ACHATS_REF - lastCol);
  }
  // Pose l’en-tête si manquant
  if (!String(shA.getRange(1, COL_ACHATS_REF).getValue())) {
    shA.getRange(1, COL_ACHATS_REF).setValue("Réf (auto)").setFontWeight("bold");
  }
}

function step3FillRefs_(shA) {
  var lastRow = shA.getLastRow();
  if (lastRow < 2) return;
  var rng = shA.getRange(2, COL_ACHATS_REF, lastRow - 1, 1);
  var vals = rng.getValues();
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    if (!vals[i][0]) {
      var id = "ACH-" + Utilities.formatString("%05d", (i + 1));
      vals[i][0] = id;
      changed = true;
    }
  }
  if (changed) {
    rng.setValues(vals);
  }
}

// ---- Validation côté Stock ----
function step3ApplyStockValidation_(shS, shA) {
  var lastRowA = Math.max(2, shA.getLastRow());
  var listRange = shA.getRange(2, COL_ACHATS_REF, lastRowA - 1, 1); // Achats!I2:I
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(listRange, true) // liste déroulante, cellule vide autorisée
    .setAllowInvalid(false)
    .build();
  // Applique la validation sur toute la colonne M du Stock
  var lastRowS = shS.getMaxRows();
  shS.getRange(2, COL_STOCK_REF_ACHAT, lastRowS - 1, 1).setDataValidation(rule);
}

function step3ComputeRefToPriceMap_(shA) {
  var sheet = shA || SpreadsheetApp.getActive().getSheetByName(SHEET_ACHATS);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var refs = sheet.getRange(2, COL_ACHATS_REF, lastRow - 1, 1).getValues();
  var prix = sheet.getRange(2, COL_ACHATS_PRIX, lastRow - 1, 1).getValues();
  var out = {};
  for (var i = 0; i < refs.length; i++) {
    var ref = String(refs[i][0] || "").trim();
    if (!ref) continue;
    out[ref] = prix[i][0];
  }
  return out;
}

function step3StoreRefPriceMap_(map) {
  STEP3_REF_PRICE_MAP_CACHE = map || {};
  var payload = { map: STEP3_REF_PRICE_MAP_CACHE, ts: Date.now() };
  var json = JSON.stringify(payload);
  try {
    var cache = CacheService.getDocumentCache();
    if (cache) {
      cache.put(STEP3_REF_PRICE_CACHE_KEY, json, STEP3_REF_PRICE_CACHE_TTL);
    }
  } catch (_) {}
  try {
    PropertiesService.getDocumentProperties().setProperty(STEP3_REF_PRICE_CACHE_KEY, json);
  } catch (_) {}
  return STEP3_REF_PRICE_MAP_CACHE;
}

function step3InvalidateRefCache_() {
  STEP3_REF_PRICE_MAP_CACHE = null;
  try {
    var cache = CacheService.getDocumentCache();
    if (cache) {
      cache.remove(STEP3_REF_PRICE_CACHE_KEY);
    }
  } catch (_) {}
  try {
    PropertiesService.getDocumentProperties().deleteProperty(STEP3_REF_PRICE_CACHE_KEY);
  } catch (_) {}
}

function step3PrimeRefCache_(shA) {
  var map = step3ComputeRefToPriceMap_(shA);
  return step3StoreRefPriceMap_(map);
}
