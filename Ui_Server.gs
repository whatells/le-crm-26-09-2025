/**
 * Module: Ui_Server
 * Rôle: exposer les endpoints serveur pour l'UI paginée (stock/ventes/dashboard/logs/config).
 * Entrées publiques: ui_getDashboard(), ui_buildDashboard(), ui_getStockPage(), ui_step3RefreshRefs(), ui_getVentesPage(), ui_step8RecalcAll(), ui_getLogsTail(), ui_ingestFast(), ui_getConfig(), ui_saveConfig().
 * Dépendances: timed(), getDashboardCached_(), getStockAllRows_(), getVentesAllRows_(), step3RefreshRefs(), step8RecalcAll(), saveConfigValues().
 * Effets de bord: lit caches internes, invalide caches via purge*, lance recalculs, renvoie tableaux paginés.
 * Pièges: fonctions dépendantes non définies dans ce fichier (doivent exister ailleurs), duplication avec PerfendPoints/Ui Server.html.
 * MAJ: 2025-09-26 – Codex Audit
 */
/**
 * Ponts serveur pour l'UI popup (HtmlService)
 * — Appelle tes fonctions existantes sans rien réécrire.
 */

// DASHBOARD
function ui_getDashboard(){
  return timed('ui_getDashboard', () => {
    const data = getDashboardCached_();
    return { kpis: data.kpis || [], blocks: {} };
  });
}
function ui_buildDashboard(){ buildDashboard(); softExpireDashboard_(); return true; }

// STOCK
function ui_getStockPage(page, size){
  return timed('ui_getStockPage', () => {
    const rows = getStockAllRows_();
    const total = rows.length;
    const pageSize = Math.max(1, size || STOCK_PAGE_SIZE);
    const current = Math.max(1, page || 1);
    const start = Math.min(total, (current - 1) * pageSize);
    const slice = rows.slice(start, start + pageSize);
    return { total: total, rows: slice };
  });
}
function ui_step3RefreshRefs(){
  return timed('ui_step3RefreshRefs', () => {
    step3RefreshRefs();
    purgeStockCache_();
    softExpireDashboard_();
    return true;
  });
}

// VENTES
function ui_getVentesPage(page, size){
  return timed('ui_getVentesPage', () => {
    const rows = getVentesAllRows_();
    const total = rows.length;
    const pageSize = Math.max(1, size || VENTES_PAGE_SIZE);
    const current = Math.max(1, page || 1);
    const start = Math.min(total, (current - 1) * pageSize);
    const slice = rows.slice(start, start + pageSize);
    return { total: total, rows: slice };
  });
}
function ui_step8RecalcAll(){
  return timed('ui_step8RecalcAll', () => {
    step8RecalcAll();
    purgeVentesCache_();
    softExpireDashboard_();
    return true;
  });
}

// EMAILS & LOGS
function ui_getLogsTail(n){
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('Logs');
  if (!sh || sh.getLastRow()<2) return [];
  const last = sh.getLastRow();
  const take = Math.min(n||50, last-1);
  return sh.getRange(last-take+1,1,take,5).getValues();
}
function ui_ingestFast(){ ingestAllLabelsFast(); return true; }

// CONFIG
function ui_getConfig(){ return (typeof getKnownConfig==='function') ? getKnownConfig() : []; }
function ui_saveConfig(rows){ return saveConfigValues(rows); }