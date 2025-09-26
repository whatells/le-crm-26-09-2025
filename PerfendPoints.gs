// ===== PerfEndpoints.gs — Full preload + multi-cache + diag =====

// --- Clés de cache
const BOOTSTRAP_KEY         = 'BOOTSTRAP_JSON_v1';
const BOOTSTRAP_CACHE_KEY   = 'cache:bootstrap_json:v1';
const DASHBOARD_CACHE_KEY   = 'cache:dashboard:v1';
const STOCK_CACHE_KEY       = 'cache:stock_all:v1';
const VENTES_CACHE_KEY      = 'cache:ventes_all:v1';

// --- TTL (secondes)
const HOT_TTL   = 120;   // ScriptCache (chaud, super-rapide)
const WARM_TTL  = 600;   // DocumentCache (chaud 10 min)
const PROP_TTL  = 0;     // Properties (pas de TTL; persistant)

// --- Entetes de colonnes attendues
const STOCK_HEADERS  = ['Date entree','SKU','Titre','Photos','Categorie','Marque','Taille','Etat','Prix achat (link)','Statut','Plateforme','Ref Achat','Favoris','Offres','Notes'];
const VENTES_HEADERS = ['Date','Plateforme','Titre','Prix','Frais/Comm','Frais port','Acheteur','SKU','Marge brute','Marge nette'];

/* ======================= Utils ======================= */
function timed(label, fn) {
  const t0 = Date.now();
  try { return fn(); }
  finally { console.log('[perf]', label, 'ms=', (Date.now() - t0)); }
}
function hotCache(){ try { return CacheService.getScriptCache(); } catch(_) { return null; } }
function warmCache(){ try { return CacheService.getDocumentCache(); } catch(_) { return null; } }

function cacheGetStr_(key){
  const hot = hotCache(); if (hot){ const v = hot.get(key); if (v!=null) return v; }
  const warm = warmCache(); if (warm){ const v = warm.get(key); if (v!=null){ if (hot) hot.put(key, v, HOT_TTL); return v; } }
  return null;
}
function cachePutStr_(key, value){
  if (typeof value !== 'string') return;
  const hot = hotCache();  if (hot)  hot.put(key, value, HOT_TTL);
  const warm = warmCache();if (warm) warm.put(key, value, WARM_TTL);
}
function cacheDel_(key){
  const hot = hotCache();  if (hot)  try{ hot.remove(key); }catch(_) {}
  const warm = warmCache();if (warm) try{ warm.remove(key); }catch(_) {}
}
function jsonGet_(key){
  const s = cacheGetStr_(key);
  if (s) { try { return JSON.parse(s); } catch(_) { cacheDel_(key); } }
  return null;
}
function jsonPut_(key, obj){ try { cachePutStr_(key, JSON.stringify(obj)); } catch(_) {} }

function makePicker_(headers, wanted) {
  // Normalise accents de base (Stock headers doivent etre FR mais sans accent pour robustesse)
  const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const map = wanted.map(w => {
    const target = norm(w);
    const idx = headers.findIndex(h => norm(h) === target);
    return idx;
  });
  return row => wanted.map((_, i) => (map[i] >= 0 ? row[map[i]] : ''));
}

/* ======================= UI / HTML ======================= */
function openCRM() {
  const html = buildUiHtml_()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setWidth(1200).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🚀 CRM - Interface Principale');
}

function buildUiHtml_() {
  // On lit le bootstrap JSON (chaine) puis on sanitise les ellipses si jamais
  const raw = getBootstrapJson_(); // string ou 'null'
  const safe = (typeof raw === 'string' && raw.length)
    ? raw.replace(/\u2026/g, '...')
    : 'null';

  const t = HtmlService.createTemplateFromFile('Index');
  t.BOOTSTRAP_JSON = safe; // injecte tel quel (UNESCAPED dans Index)

  return t.evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setWidth(1200).setHeight(700);
}

/* ======================= Bootstrap ======================= */
function getBootstrapJson_() {
  // 1) caches
  const cached = cacheGetStr_(BOOTSTRAP_CACHE_KEY);
  if (cached) return cached;

  // 2) properties
  const props = PropertiesService.getDocumentProperties();
  const stored = props.getProperty(BOOTSTRAP_KEY);
  if (stored){
    cachePutStr_(BOOTSTRAP_CACHE_KEY, stored);
    return stored;
  }

  // 3) compute
  const json = JSON.stringify(buildBootstrapPayload_());
  setBootstrapJson_(json);
  cachePutStr_(BOOTSTRAP_CACHE_KEY, json);
  return json;
}

function setBootstrapJson_(json) {
  PropertiesService.getDocumentProperties().setProperty(BOOTSTRAP_KEY, json);
  cachePutStr_(BOOTSTRAP_CACHE_KEY, json);

  // seed KPI cache
  try {
    const obj = JSON.parse(json);
    const kpis = Array.isArray(obj?.kpis) ? obj.kpis : [];
    jsonPut_(DASHBOARD_CACHE_KEY, { kpis: kpis });
  } catch(e) {
    console.warn('seed dashboard cache failed', e);
  }
}

function buildBootstrapPayload_() {
  const ss = SpreadsheetApp.getActive();

  const kpis   = timed('bootstrap:dashboard', () => ui_getDashboard().kpis);
  const stockR = timed('bootstrap:stock',     () => ui_getStockAll());
  const ventR  = timed('bootstrap:ventes',    () => ui_getVentesAll());
  const cfg    = timed('bootstrap:config',    () => ui_getConfig());
  const logs   = timed('bootstrap:logs',      () => ui_getLogsTail(50));

  return {
    ts: Date.now(),
    kpis: kpis,
    stock:  { total: stockR.total, page1: stockR.rows, headers: stockR.headers },
    ventes: { total: ventR.total,  page1: ventR.rows,  headers: ventR.headers  },
    config: cfg,
    logs: logs
  };
}

/* ======================= Endpoints (avec cache) ======================= */
// Dashboard
function ui_getDashboard(){
  return timed('ui_getDashboard', () => {
    const hit = jsonGet_(DASHBOARD_CACHE_KEY);
    if (hit) return hit;

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Dashboard');
    if (!sh) { const res = { kpis: [] }; jsonPut_(DASHBOARD_CACHE_KEY, res); return res; }

    const vals = sh.getDataRange().getValues();
    if (!vals || vals.length <= 1) { const res = { kpis: [] }; jsonPut_(DASHBOARD_CACHE_KEY, res); return res; }

    const rows = [];
    for (let i=1;i<vals.length;i++){
      const k = vals[i][0];
      if (k!=null && k!=='') rows.push([k, vals[i][1]]);
    }
    const res = { kpis: rows };
    jsonPut_(DASHBOARD_CACHE_KEY, res);
    return res;
  });
}

// Stock (ALL)
function ui_getStockAll(){
  return timed('ui_getStockAll', () => {
    const hit = jsonGet_(STOCK_CACHE_KEY);
    if (hit) return Object.assign({ headers: STOCK_HEADERS }, hit);

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Stock');
    if (!sh) { const empty = { total: 0, rows: [], headers: STOCK_HEADERS }; jsonPut_(STOCK_CACHE_KEY, { total: 0, rows: [] }); return empty; }

    const values = sh.getDataRange().getValues();
    if (!values || values.length <= 1) { const empty = { total: 0, rows: [], headers: STOCK_HEADERS }; jsonPut_(STOCK_CACHE_KEY, { total: 0, rows: [] }); return empty; }

    const headers = values[0].map(h => String(h||'').trim());
    const pick = makePicker_(headers, STOCK_HEADERS);
    const rows = values.slice(1).map(pick);
    const res = { total: rows.length, rows: rows };
    jsonPut_(STOCK_CACHE_KEY, res);
    return Object.assign({ headers: STOCK_HEADERS }, res);
  });
}

// Ventes (ALL)
function ui_getVentesAll(){
  return timed('ui_getVentesAll', () => {
    const hit = jsonGet_(VENTES_CACHE_KEY);
    if (hit) return Object.assign({ headers: VENTES_HEADERS }, hit);

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Ventes');
    if (!sh) { const empty = { total: 0, rows: [], headers: VENTES_HEADERS }; jsonPut_(VENTES_CACHE_KEY, { total: 0, rows: [] }); return empty; }

    const values = sh.getDataRange().getValues();
    if (!values || values.length <= 1) { const empty = { total: 0, rows: [], headers: VENTES_HEADERS }; jsonPut_(VENTES_CACHE_KEY, { total: 0, rows: [] }); return empty; }

    const headers = values[0].map(h => String(h||'').trim());
    const pick = makePicker_(headers, VENTES_HEADERS);
    const rows = values.slice(1).map(pick);
    const res = { total: rows.length, rows: rows };
    jsonPut_(VENTES_CACHE_KEY, res);
    return Object.assign({ headers: VENTES_HEADERS }, res);
  });
}

// Config
function ui_getConfig(){
  return timed('ui_getConfig', () => {
    if (typeof getKnownConfig === 'function'){
      try { return getKnownConfig(); } catch(e){ console.warn('getKnownConfig failed', e); }
    }
    return [];
  });
}

// Logs tail
function ui_getLogsTail(n){
  return timed('ui_getLogsTail', () => {
    const take = Math.max(1, Number(n)||50);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Logs');
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    const count = Math.min(take, last - 1);
    const start = last - count + 1;
    return sh.getRange(start, 1, count, 5).getValues();
  });
}

/* ======================= Actions (si existantes) ======================= */
function ui_step3RefreshRefs(){ return timed('ui_step3RefreshRefs', ()=> { if (typeof step3RefreshRefs==='function') return step3RefreshRefs(); }); }
function ui_step8RecalcAll(){  return timed('ui_step8RecalcAll',  ()=> { if (typeof step8RecalcAll==='function')  return step8RecalcAll();  }); }
function ui_saveConfig(rows){  return timed('ui_saveConfig',      ()=> { if (typeof saveConfig==='function')      return saveConfig(rows); }); }
function ui_ingestFast(){      return timed('ui_ingestFast',      ()=> { if (typeof ingestFast==='function')      return ingestFast();      }); }

/* ======================= Invalidation / Maintenance ======================= */
// Purges fines (appelle-les apres une modif de donnees)
function purgeDashboardCache(){ cacheDel_(DASHBOARD_CACHE_KEY); }
function purgeStockCache(){     cacheDel_(STOCK_CACHE_KEY); }
function purgeVentesCache(){    cacheDel_(VENTES_CACHE_KEY); }

function purgeAllCaches(){
  cacheDel_(DASHBOARD_CACHE_KEY);
  cacheDel_(STOCK_CACHE_KEY);
  cacheDel_(VENTES_CACHE_KEY);
  cacheDel_(BOOTSTRAP_CACHE_KEY);
}

function cronRecomputeBootstrap() {
  return timed('cronRecomputeBootstrap', () => {
    const json = JSON.stringify(buildBootstrapPayload_());
    setBootstrapJson_(json);
    purgeAllCaches();
    // Re-seed caches chauds pour l'ouverture suivante
    cachePutStr_(BOOTSTRAP_CACHE_KEY, json);
    return { ok: true, ts: Date.now() };
  });
}

function setupTriggers() {
  // Recompute bootstrap chaque heure
  ScriptApp.newTrigger('cronRecomputeBootstrap').timeBased().everyHours(1).create();
}

/* ======================= Helpers optionnels ======================= */
function toNum_(v){ if (v==null || v==='') return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function fmtEuro_(v){
  const n = toNum_(v); if (!n) return '';
  return Utilities.formatString('%s €', n.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:2}));
}

/* ======================= DIAG SERVER: wrappers de log ======================= */
function _logHit(name, extra){ console.log('[HIT]', name, extra||''); }

try {
  if (typeof ui_getStockAll === 'function') {
    var _ui_getStockAll = ui_getStockAll;
    ui_getStockAll = function(){
      _logHit('ui_getStockAll');
      return _ui_getStockAll.apply(this, arguments);
    };
  }
} catch(e){ console.warn('wrapper ui_getStockAll failed', e); }

try {
  if (typeof ui_getVentesAll === 'function') {
    var _ui_getVentesAll = ui_getVentesAll;
    ui_getVentesAll = function(){
      _logHit('ui_getVentesAll');
      return _ui_getVentesAll.apply(this, arguments);
    };
  }
} catch(e){ console.warn('wrapper ui_getVentesAll failed', e); }

try {
  if (typeof ui_getDashboard === 'function') {
    var _ui_getDashboard = ui_getDashboard;
    ui_getDashboard = function(){
      _logHit('ui_getDashboard');
      return _ui_getDashboard.apply(this, arguments);
    };
  }
} catch(e){ console.warn('wrapper ui_getDashboard failed', e); }

try {
  if (typeof ui_getLogsTail === 'function') {
    var _ui_getLogsTail = ui_getLogsTail;
    ui_getLogsTail = function(n){
      _logHit('ui_getLogsTail', 'n='+n);
      return _ui_getLogsTail.apply(this, arguments);
    };
  }
} catch(e){ console.warn('wrapper ui_getLogsTail failed', e); }
