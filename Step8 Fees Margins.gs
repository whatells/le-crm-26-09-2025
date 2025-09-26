/**
 * Étape 8 — Calculs commissions & marges avancés
 * - Calcule la commission par plateforme: max(min, pct*prix + flat)
 * - Marge brute = PV − Prix achat − Commission − Frais port
 * - Marge nette = Marge brute − coûts fixes (si ON) − URSSAF (si ON)
 * - Fournit des actions menu: recalcul sur toute la feuille Ventes ou la ligne courante
 * - Override insertSale_ pour utiliser ces règles lors de l'ingestion
 */

// Colonnes Ventes (1-based)
var COL_V_DATE = 1;
var COL_V_PLATFORM = 2;
var COL_V_TITLE = 3;
var COL_V_PRICE = 4;
var COL_V_FEES = 5;       // Frais/Commission
var COL_V_SHIP = 6;       // Frais port
var COL_V_BUYER = 7;      // Acheteur (non utilisé ici)
var COL_V_SKU = 8;
var COL_V_MARGIN_G = 9;   // Marge brute
var COL_V_MARGIN_N = 10;  // Marge nette

// Pour remonter Prix achat depuis Stock
var SHEET_STOCK = "Stock";
var COL_S_SKU = 2;        // B
var COL_S_COST = 9;       // I Prix achat (link)

var STEP8_COST_CACHE_KEY = 'STEP8::COST_MAP';
var STEP8_COST_CACHE_TTL = 600;
var STEP8_COST_MAP_CACHE = null;
var STEP8_FLAGS_CACHE = null;

// ---- Calculs unitaires ----
function step8CommissionFor_(platform, price){
  var fees = getPlatformFees_(platform); // {pct,min,flat}
  var raw = price * (fees.pct||0) + (fees.flat||0);
  return Math.max(raw, fees.min||0);
}

function step8LookupCostBySku_(sku){
  if (!sku) return 0;
  var map = step8GetCostMap_();
  var key = String(sku).toUpperCase();
  return Number(map[key] || 0);
}

function step8ComputeMargins_(platform, price, ship, sku){
  var flags = step8GetFlags_();
  var fees = step8CommissionFor_(platform, price);
  var cost = step8LookupCostBySku_(sku);
  var gross = Number(price||0) - Number(cost||0) - Number(fees||0) - Number(ship||0);
  var fixed = flags.applyFixedCosts ? Number(flags.fixedCostPerSale||0) : 0;
  var urssaf = flags.applyUrssaf ? (Number(flags.urssafRate||0) * Math.max(gross,0)) : 0; // base: marge brute >=0
  var net = gross - fixed - urssaf;
  if (flags.roundMargins){
    gross = Math.round(gross*100)/100;
    net   = Math.round(net*100)/100;
    fees  = Math.round(fees*100)/100;
  }
  return {fees:fees, gross:gross, net:net};
}

// ---- Recalculs ----
function step8RecalcAll(){
  return timed_("step8RecalcAll", function(getMs) {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName("Ventes");
    if (!sh || sh.getLastRow()<2) return;
    var last = sh.getLastRow();
    var rows = last - 1;
    var vals = sh.getRange(2,1,rows, COL_V_MARGIN_N).getValues();
    STEP8_FLAGS_CACHE = null;
    var fees = new Array(rows);
    var gross = new Array(rows);
    var net = new Array(rows);

    for (var i=0;i<rows;i++){
      var platform = vals[i][COL_V_PLATFORM-1];
      var price    = Number(vals[i][COL_V_PRICE-1]||0);
      var ship     = Number(vals[i][COL_V_SHIP-1]||0);
      var sku      = vals[i][COL_V_SKU-1];
      var m = step8ComputeMargins_(platform, price, ship, sku);
      fees[i] = [m.fees];
      gross[i] = [m.gross];
      net[i] = [m.net];
    }

    sh.getRange(2, COL_V_FEES, rows, 1).setValues(fees);
    sh.getRange(2, COL_V_MARGIN_G, rows, 1).setValues(gross);
    sh.getRange(2, COL_V_MARGIN_N, rows, 1).setValues(net);
    log_("INFO","Étape8","Recalcul complet des marges","server ms=" + getMs());
  });
}

function step8RecalcCurrent(){
  var sh = SpreadsheetApp.getActiveSheet();
  if (!sh || sh.getName()!=="Ventes") return;
  var r = sh.getActiveRange().getRow();
  if (r<2) return;
  STEP8_FLAGS_CACHE = null;
  var width = COL_V_SKU - COL_V_PLATFORM + 1;
  var rowData = sh.getRange(r, COL_V_PLATFORM, 1, width).getValues()[0];
  var platform = rowData[0];
  var price    = Number(rowData[COL_V_PRICE - COL_V_PLATFORM] || 0);
  var ship     = Number(rowData[COL_V_SHIP - COL_V_PLATFORM] || 0);
  var sku      = String(rowData[COL_V_SKU - COL_V_PLATFORM] || "");
  var m = step8ComputeMargins_(platform, price, ship, sku);
  sh.getRange(r, COL_V_FEES).setValue(m.fees);
  sh.getRange(r, COL_V_MARGIN_G).setValue(m.gross);
  sh.getRange(r, COL_V_MARGIN_N).setValue(m.net);
}

// ---- Override de insertSale_ (l'ingestion utilisera ces règles automatiquement) ----
function insertSale_(sh, d){
  var row = Math.max(2, sh.getLastRow()+1);
  var m = step8ComputeMargins_(d.platform, Number(d.price||0), 0, d.sku||""); // frais port inconnus à l'ingest
  sh.getRange(row, COL_V_DATE).setValue(new Date());
  sh.getRange(row, COL_V_PLATFORM).setValue(d.platform);
  sh.getRange(row, COL_V_TITLE).setValue(d.title);
  sh.getRange(row, COL_V_PRICE).setValue(d.price);
  sh.getRange(row, COL_V_FEES).setValue(m.fees);
  // COL_V_SHIP laissé à 0 par défaut; tu peux remplir plus tard puis relancer step8RecalcCurrent
  sh.getRange(row, COL_V_SKU).setValue(d.sku||"");
  sh.getRange(row, COL_V_MARGIN_G).setValue(m.gross);
  sh.getRange(row, COL_V_MARGIN_N).setValue(m.net);
}

function step8GetCostMap_() {
  if (STEP8_COST_MAP_CACHE) {
    return STEP8_COST_MAP_CACHE;
  }

  var cache = CacheService.getDocumentCache();
  if (cache) {
    var cached = cache.get(STEP8_COST_CACHE_KEY);
    if (cached) {
      try {
        var payload = JSON.parse(cached);
        if (payload && typeof payload.map === 'object') {
          STEP8_COST_MAP_CACHE = payload.map || {};
        } else {
          STEP8_COST_MAP_CACHE = payload || {};
        }
        return STEP8_COST_MAP_CACHE;
      } catch (err) {
        step8InvalidateCostCache_();
      }
    }
  }

  var props = PropertiesService.getDocumentProperties();
  var stored = props.getProperty(STEP8_COST_CACHE_KEY);
  if (stored) {
    try {
      var payloadProp = JSON.parse(stored);
      if (payloadProp && typeof payloadProp.map === 'object') {
        STEP8_COST_MAP_CACHE = payloadProp.map || {};
      } else {
        STEP8_COST_MAP_CACHE = payloadProp || {};
      }
      if (cache) cache.put(STEP8_COST_CACHE_KEY, stored, STEP8_COST_CACHE_TTL);
      return STEP8_COST_MAP_CACHE;
    } catch (e) {
      step8InvalidateCostCache_();
    }
  }

  return step8PrimeCostCache_();
}

function step8ComputeCostMap_(sheet) {
  var sh = sheet || SpreadsheetApp.getActive().getSheetByName(SHEET_STOCK);
  if (!sh) return {};
  var last = sh.getLastRow();
  if (last < 2) return {};
  var rows = last - 1;
  var skus = sh.getRange(2, COL_S_SKU, rows, 1).getValues();
  var costs = sh.getRange(2, COL_S_COST, rows, 1).getValues();
  var out = {};
  for (var i = 0; i < rows; i++) {
    var sku = String(skus[i][0] || "").toUpperCase();
    if (!sku) continue;
    out[sku] = Number(costs[i][0] || 0);
  }
  return out;
}

function step8StoreCostMap_(map) {
  STEP8_COST_MAP_CACHE = map || {};
  var payload = { map: STEP8_COST_MAP_CACHE, ts: Date.now() };
  var json = JSON.stringify(payload);
  try {
    var cache = CacheService.getDocumentCache();
    if (cache) {
      cache.put(STEP8_COST_CACHE_KEY, json, STEP8_COST_CACHE_TTL);
    }
  } catch (_) {}
  try {
    PropertiesService.getDocumentProperties().setProperty(STEP8_COST_CACHE_KEY, json);
  } catch (_) {}
  return STEP8_COST_MAP_CACHE;
}

function step8InvalidateCostCache_() {
  STEP8_COST_MAP_CACHE = null;
  try {
    var cache = CacheService.getDocumentCache();
    if (cache) {
      cache.remove(STEP8_COST_CACHE_KEY);
    }
  } catch (_) {}
  try {
    PropertiesService.getDocumentProperties().deleteProperty(STEP8_COST_CACHE_KEY);
  } catch (_) {}
}

function step8PrimeCostCache_(sheet) {
  var map = step8ComputeCostMap_(sheet);
  return step8StoreCostMap_(map);
}

function step8GetFlags_() {
  if (!STEP8_FLAGS_CACHE) {
    STEP8_FLAGS_CACHE = (typeof getGlobalFlags_ === 'function') ? getGlobalFlags_() : {};
  }
  return STEP8_FLAGS_CACHE;
}

/**
 * Fonction de pré-calcul manuel (installer un trigger horaire via l'interface Apps Script).
 */
function cronRecompute() {
  return timed_("cronRecompute", function(getMs) {
    var refMap = (typeof step3PrimeRefCache_ === 'function') ? step3PrimeRefCache_() : {};
    var costMap = step8PrimeCostCache_();
    var refsCount = refMap ? Object.keys(refMap).length : 0;
    var costCount = costMap ? Object.keys(costMap).length : 0;
    log_("INFO", "Cron", "Caches pré-calculés", "refs=" + refsCount + ";costs=" + costCount + ";server ms=" + getMs());
    return { refs: refsCount, costs: costCount };
  });
}
