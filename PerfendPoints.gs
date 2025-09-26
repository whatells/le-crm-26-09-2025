/**
 * Module: PerfendPoints
 * Rôle: version performante des endpoints UI (bootstrap JSON, caches multi-niveaux, diagnostics).
 * Entrées publiques: openCRM(), ui_getDashboard(), ui_getStockAll(), ui_getVentesAll(), ui_getConfig(), ui_saveConfig(), ui_ingestFast(), ui_step3RefreshRefs(), ui_step8RecalcAll(), purge*(), cronRecomputeBootstrap(), setupTriggers().
 * Dépendances: CacheService (script/document), PropertiesService, SpreadsheetApp (feuilles), HtmlService (Index), Step3/Step8/Ui_Config helpers, timed().
 * Effets de bord: remplit caches chauds, écrit dans Properties, ouvre modales, peut modifier caches en enveloppant les fonctions existantes.
 * Pièges: duplication d'endpoints avec Ui_Server (risque conflits), invalidation manuelle nécessaire après modifications, attention aux quotas lors du bootstrap complet.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: centralisation endpoints UI + bootstrap page1/pageSize pour Stock & Ventes.
 */

// ===== PerfEndpoints.gs — Full preload + multi-cache + diag =====

// --- Clés de cache
const BOOTSTRAP_KEY = 'BOOTSTRAP_JSON_v1';
const BOOTSTRAP_CACHE_KEY = 'cache:bootstrap_json:v1';
const DASHBOARD_CACHE_KEY = 'cache:dashboard:v1';
const STOCK_CACHE_KEY = 'cache:stock_all:v1';
const VENTES_CACHE_KEY = 'cache:ventes_all:v1';

// --- TTL (secondes)
const HOT_TTL = 120; // ScriptCache (chaud, super-rapide)
const WARM_TTL = 600; // DocumentCache (chaud 10 min)
const PROP_TTL = 0; // Properties (pas de TTL; persistant)

// --- Entêtes de colonnes attendues
const STOCK_HEADERS = ['Date entree', 'SKU', 'Titre', 'Photos', 'Categorie', 'Marque', 'Taille', 'Etat', 'Prix achat (link)', 'Statut', 'Plateforme', 'Ref Achat', 'Favoris', 'Offres', 'Notes'];
const VENTES_HEADERS = ['Date', 'Plateforme', 'Titre', 'Prix', 'Frais/Comm', 'Frais port', 'Acheteur', 'SKU', 'Marge brute', 'Marge nette'];

const BACKOFF_DEFAULT = { retries: 5, baseMs: 200, factor: 2 };

/* ======================= Utils ======================= */
/**
 * Mesure l'exécution d'une fonction (console.log millisecondes).
 * @param {string} label
 * @param {function():*} fn
 * @return {*}
 */
function timed(label, fn) {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    console.log('[perf]', label, 'ms=', Date.now() - t0);
  }
}

/**
 * Exécute une fonction avec backoff exponentiel.
 * @param {function():*} fn
 * @param {{retries:number, baseMs:number, factor:number}=} options
 * @return {*}
 */
function withBackoff_(fn, options) {
  const cfg = Object.assign({}, BACKOFF_DEFAULT, options || {});
  let attempt = 0;
  while (true) { // eslint-disable-line no-constant-condition
    try {
      return fn();
    } catch (err) {
      attempt += 1;
      if (attempt > cfg.retries) {
        console.error('withBackoff_: abandon après', attempt, 'tentatives');
        throw err;
      }
      const delay = Math.min(cfg.baseMs * Math.pow(cfg.factor, attempt - 1), 30000);
      console.warn('withBackoff_: tentative', attempt, 'échec -> sleep', delay, 'ms');
      Utilities.sleep(delay + Math.floor(Math.random() * 50));
    }
  }
}

function hotCache() {
  try {
    return CacheService.getScriptCache();
  } catch (_err) {
    return null;
  }
}

function warmCache() {
  try {
    return CacheService.getDocumentCache();
  } catch (_err) {
    return null;
  }
}

function cacheGetStr_(key) {
  const hot = hotCache();
  if (hot) {
    const hit = hot.get(key);
    if (hit != null) {
      return hit;
    }
  }
  const warm = warmCache();
  if (warm) {
    const hit = warm.get(key);
    if (hit != null) {
      if (hot) {
        hot.put(key, hit, HOT_TTL);
      }
      return hit;
    }
  }
  return null;
}

function cachePutStr_(key, value) {
  if (typeof value !== 'string') {
    return;
  }
  const hot = hotCache();
  if (hot) {
    hot.put(key, value, HOT_TTL);
  }
  const warm = warmCache();
  if (warm) {
    warm.put(key, value, WARM_TTL);
  }
}

function cacheDel_(key) {
  const hot = hotCache();
  if (hot) {
    try {
      hot.remove(key);
    } catch (_err) {
      // ignore
    }
  }
  const warm = warmCache();
  if (warm) {
    try {
      warm.remove(key);
    } catch (_err) {
      // ignore
    }
  }
}

function jsonGet_(key) {
  const raw = cacheGetStr_(key);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (_err) {
      cacheDel_(key);
    }
  }
  return null;
}

function jsonPut_(key, obj) {
  try {
    cachePutStr_(key, JSON.stringify(obj));
  } catch (_err) {
    // JSON stringify échoué -> ignorer
  }
}

function makePicker_(headers, wanted) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const indexes = wanted.map(target => {
    const normalized = norm(target);
    return headers.findIndex(h => norm(h) === normalized);
  });
  return row => wanted.map((_, i) => (indexes[i] >= 0 ? row[indexes[i]] : ''));
}

/* ======================= UI / HTML ======================= */
function openCRM() {
  const html = buildUiHtml_()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setWidth(1200)
    .setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🚀 CRM - Interface Principale');
}

function buildUiHtml_() {
  const raw = getBootstrapJson_();
  const safe = typeof raw === 'string' && raw.length ? raw.replace(/\u2026/g, '...') : 'null';
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.BOOTSTRAP_JSON = safe;
  return tpl.evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setWidth(1200)
    .setHeight(700);
}

/* ======================= Bootstrap ======================= */
function getBootstrapJson_() {
  const cached = cacheGetStr_(BOOTSTRAP_CACHE_KEY);
  if (cached) {
    return cached;
  }

  const props = PropertiesService.getDocumentProperties();
  const stored = props.getProperty(BOOTSTRAP_KEY);
  if (stored) {
    cachePutStr_(BOOTSTRAP_CACHE_KEY, stored);
    return stored;
  }

  const json = JSON.stringify(buildBootstrapPayload_());
  setBootstrapJson_(json);
  cachePutStr_(BOOTSTRAP_CACHE_KEY, json);
  return json;
}

function setBootstrapJson_(json) {
  PropertiesService.getDocumentProperties().setProperty(BOOTSTRAP_KEY, json);
  cachePutStr_(BOOTSTRAP_CACHE_KEY, json);
  try {
    const obj = JSON.parse(json);
    const kpis = Array.isArray(obj?.kpis) ? obj.kpis : [];
    jsonPut_(DASHBOARD_CACHE_KEY, { kpis: kpis });
  } catch (err) {
    console.warn('seed dashboard cache failed', err);
  }
}

function buildBootstrapPayload_() {
  const PAGE_SIZE = 20;
  const kpis = timed('bootstrap:dashboard', () => ui_getDashboard().kpis);
  const stockR = timed('bootstrap:stock', () => ui_getStockAll());
  const ventR = timed('bootstrap:ventes', () => ui_getVentesAll());
  const cfg = timed('bootstrap:config', () => ui_getConfig());
  const logs = timed('bootstrap:logs', () => ui_getLogsTail(50));

  return {
    ts: Date.now(),
    kpis: kpis,
    stock: {
      total: stockR.total,
      page1: (stockR.rows || []).slice(0, PAGE_SIZE),
      headers: stockR.headers,
      pageSize: PAGE_SIZE
    },
    ventes: {
      total: ventR.total,
      page1: (ventR.rows || []).slice(0, PAGE_SIZE),
      headers: ventR.headers,
      pageSize: PAGE_SIZE
    },
    config: cfg,
    logs: logs
  };
}

/* ======================= Endpoints (avec cache) ======================= */
function ui_getDashboard() {
  return timed('ui_getDashboard', () => {
    const hit = jsonGet_(DASHBOARD_CACHE_KEY);
    if (hit) {
      return hit;
    }

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Dashboard');
    if (!sh) {
      const resEmpty = { kpis: [] };
      jsonPut_(DASHBOARD_CACHE_KEY, resEmpty);
      return resEmpty;
    }

    const values = sh.getDataRange().getValues();
    if (!values || values.length <= 1) {
      const resEmpty = { kpis: [] };
      jsonPut_(DASHBOARD_CACHE_KEY, resEmpty);
      return resEmpty;
    }

    const kpis = [];
    for (let i = 1; i < values.length; i++) {
      const key = values[i][0];
      if (key != null && key !== '') {
        kpis.push([key, values[i][1]]);
      }
    }
    const res = { kpis: kpis };
    jsonPut_(DASHBOARD_CACHE_KEY, res);
    return res;
  });
}

function ui_getStockAll() {
  return timed('ui_getStockAll', () => {
    const hit = jsonGet_(STOCK_CACHE_KEY);
    if (hit) {
      return Object.assign({ headers: STOCK_HEADERS }, hit);
    }

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Stock');
    if (!sh) {
      const empty = { total: 0, rows: [], headers: STOCK_HEADERS };
      jsonPut_(STOCK_CACHE_KEY, { total: 0, rows: [] });
      return empty;
    }

    const values = sh.getDataRange().getValues();
    if (!values || values.length <= 1) {
      const empty = { total: 0, rows: [], headers: STOCK_HEADERS };
      jsonPut_(STOCK_CACHE_KEY, { total: 0, rows: [] });
      return empty;
    }

    const headers = values[0].map(h => String(h || '').trim());
    const pick = makePicker_(headers, STOCK_HEADERS);
    const rows = values.slice(1).map(pick);
    const res = { total: rows.length, rows: rows };
    jsonPut_(STOCK_CACHE_KEY, res);
    return Object.assign({ headers: STOCK_HEADERS }, res);
  });
}

function ui_getVentesAll() {
  return timed('ui_getVentesAll', () => {
    const hit = jsonGet_(VENTES_CACHE_KEY);
    if (hit) {
      return Object.assign({ headers: VENTES_HEADERS }, hit);
    }

    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Ventes');
    if (!sh) {
      const empty = { total: 0, rows: [], headers: VENTES_HEADERS };
      jsonPut_(VENTES_CACHE_KEY, { total: 0, rows: [] });
      return empty;
    }

    const values = sh.getDataRange().getValues();
    if (!values || values.length <= 1) {
      const empty = { total: 0, rows: [], headers: VENTES_HEADERS };
      jsonPut_(VENTES_CACHE_KEY, { total: 0, rows: [] });
      return empty;
    }

    const headers = values[0].map(h => String(h || '').trim());
    const pick = makePicker_(headers, VENTES_HEADERS);
    const rows = values.slice(1).map(pick);
    const res = { total: rows.length, rows: rows };
    jsonPut_(VENTES_CACHE_KEY, res);
    return Object.assign({ headers: VENTES_HEADERS }, res);
  });
}

function ui_getConfig() {
  return timed('ui_getConfig', () => {
    if (typeof getConfiguration === 'function') {
      try {
        return getConfiguration();
      } catch (err) {
        console.warn('getConfiguration failed', err);
      }
    }
    if (typeof getKnownConfig === 'function') {
      try {
        return getKnownConfig();
      } catch (err) {
        console.warn('getKnownConfig failed', err);
      }
    }
    return [];
  });
}

function ui_saveConfig(payload) {
  return timed('ui_saveConfig', () => {
    let result = null;
    if (typeof saveConfiguration === 'function') {
      result = saveConfiguration(payload);
    } else if (typeof saveConfigValues === 'function') {
      result = saveConfigValues(payload);
    }
    purgeBootstrapCaches_();
    return result;
  });
}

function ui_step3RefreshRefs() {
  return timed('ui_step3RefreshRefs', () => {
    if (typeof step3RefreshRefs === 'function') {
      const res = step3RefreshRefs();
      purgeStockCache();
      purgeDashboardCache();
      purgeBootstrapCaches_();
      return res;
    }
    return null;
  });
}

function ui_step8RecalcAll() {
  return timed('ui_step8RecalcAll', () => {
    if (typeof step8RecalcAll === 'function') {
      const res = step8RecalcAll();
      purgeVentesCache();
      purgeDashboardCache();
      purgeBootstrapCaches_();
      return res;
    }
    return null;
  });
}

function ui_ingestFast() {
  return timed('ui_ingestFast', () => {
    let res = null;
    if (typeof ingestAllLabelsFast === 'function') {
      res = ingestAllLabelsFast();
    } else if (typeof ingestAllLabels === 'function') {
      res = ingestAllLabels();
    }
    purgeStockCache();
    purgeVentesCache();
    purgeDashboardCache();
    purgeBootstrapCaches_();
    return res;
  });
}

function ui_getLogsTail(n) {
  return timed('ui_getLogsTail', () => {
    const take = Math.max(1, Number(n) || 50);
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName('Logs');
    if (!sh) {
      return [];
    }
    const last = sh.getLastRow();
    if (last < 2) {
      return [];
    }
    const count = Math.min(take, last - 1);
    const start = last - count + 1;
    return sh.getRange(start, 1, count, 5).getValues();
  });
}

/* ======================= Invalidation / Maintenance ======================= */
function purgeDashboardCache() {
  cacheDel_(DASHBOARD_CACHE_KEY);
}

function purgeStockCache() {
  cacheDel_(STOCK_CACHE_KEY);
}

function purgeVentesCache() {
  cacheDel_(VENTES_CACHE_KEY);
}

function purgeBootstrapCaches_() {
  cacheDel_(BOOTSTRAP_CACHE_KEY);
  PropertiesService.getDocumentProperties().deleteProperty(BOOTSTRAP_KEY);
}

function purgeAllCaches() {
  purgeDashboardCache();
  purgeStockCache();
  purgeVentesCache();
  purgeBootstrapCaches_();
}

function cronRecomputeBootstrap() {
  return timed('cronRecomputeBootstrap', () => {
    const json = JSON.stringify(buildBootstrapPayload_());
    setBootstrapJson_(json);
    purgeAllCaches();
    cachePutStr_(BOOTSTRAP_CACHE_KEY, json);
    return { ok: true, ts: Date.now() };
  });
}

function setupTriggers() {
  ScriptApp.newTrigger('cronRecomputeBootstrap').timeBased().everyHours(1).create();
}

/* ======================= Helpers optionnels ======================= */
function toNum_(v) {
  if (v == null || v === '') {
    return 0;
  }
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function fmtEuro_(v) {
  const n = toNum_(v);
  if (!n) {
    return '';
  }
  return Utilities.formatString('%s €', n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/* ======================= DIAG SERVER: wrappers de log ======================= */
function _logHit(name, extra) {
  console.log('[HIT]', name, extra || '');
}

try {
  if (typeof ui_getStockAll === 'function') {
    const _ui_getStockAll = ui_getStockAll;
    ui_getStockAll = function () {
      _logHit('ui_getStockAll');
      return _ui_getStockAll.apply(this, arguments);
    };
  }
} catch (err) {
  console.warn('wrapper ui_getStockAll failed', err);
}

try {
  if (typeof ui_getVentesAll === 'function') {
    const _ui_getVentesAll = ui_getVentesAll;
    ui_getVentesAll = function () {
      _logHit('ui_getVentesAll');
      return _ui_getVentesAll.apply(this, arguments);
    };
  }
} catch (err) {
  console.warn('wrapper ui_getVentesAll failed', err);
}

try {
  if (typeof ui_getDashboard === 'function') {
    const _ui_getDashboard = ui_getDashboard;
    ui_getDashboard = function () {
      _logHit('ui_getDashboard');
      return _ui_getDashboard.apply(this, arguments);
    };
  }
} catch (err) {
  console.warn('wrapper ui_getDashboard failed', err);
}

try {
  if (typeof ui_getLogsTail === 'function') {
    const _ui_getLogsTail = ui_getLogsTail;
    ui_getLogsTail = function (n) {
      _logHit('ui_getLogsTail', 'n=' + n);
      return _ui_getLogsTail.apply(this, arguments);
    };
  }
} catch (err) {
  console.warn('wrapper ui_getLogsTail failed', err);
}
