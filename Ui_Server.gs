/**
 * Module: Ui_Server (obsolète)
 * Rôle: ancien pont serveur pour l'UI. Conservé pour compatibilité documentaire.
 * Entrées publiques: -- (déléguées à PerfendPoints).
 * Dépendances: PerfendPoints.gs expose désormais toutes les fonctions.
 * Effets de bord: aucun.
 * Pièges: ne pas réintroduire de logique ici, laisser PerfendPoints centraliser.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: fichier neutralisé, expose uniquement des alias non mutables vers PerfendPoints.
 */

// Ce module ne fait plus que documenter les endpoints disponibles dans PerfendPoints.gs.
// Les fonctions historiques ui_* ont été centralisées et ne doivent plus être redéclarées ici.
// Pour référence, elles incluent: ui_getDashboard, ui_getStockAll, ui_getVentesAll,
// ui_getConfig, ui_saveConfig, ui_ingestFast, ui_step3RefreshRefs, ui_step8RecalcAll,
// purgeDashboardCache, purgeStockCache, purgeVentesCache.

/**
 * Objet de confort pour vérifier l'existence des endpoints consolidés.
 * Permet de détecter rapidement un chargement incomplet lors du debug.
 */
const UiServerEndpoints = Object.freeze({
  openCRM: typeof openCRM === 'function' ? openCRM : null,
  ui_getDashboard: typeof ui_getDashboard === 'function' ? ui_getDashboard : null,
  ui_getStockAll: typeof ui_getStockAll === 'function' ? ui_getStockAll : null,
  ui_getVentesAll: typeof ui_getVentesAll === 'function' ? ui_getVentesAll : null,
  ui_getConfig: typeof ui_getConfig === 'function' ? ui_getConfig : null,
  ui_saveConfig: typeof ui_saveConfig === 'function' ? ui_saveConfig : null,
  ui_ingestFast: typeof ui_ingestFast === 'function' ? ui_ingestFast : null,
  ui_step3RefreshRefs: typeof ui_step3RefreshRefs === 'function' ? ui_step3RefreshRefs : null,
  ui_step8RecalcAll: typeof ui_step8RecalcAll === 'function' ? ui_step8RecalcAll : null,
  purgeDashboardCache: typeof purgeDashboardCache === 'function' ? purgeDashboardCache : null,
  purgeStockCache: typeof purgeStockCache === 'function' ? purgeStockCache : null,
  purgeVentesCache: typeof purgeVentesCache === 'function' ? purgeVentesCache : null
});

(function verifyPerfEndpointsLoaded_() {
  const missing = Object.keys(UiServerEndpoints)
    .filter(key => UiServerEndpoints[key] === null);
  if (missing.length) {
    console.warn('Ui_Server.gs: endpoints manquants ->', missing.join(', '));
  }
})();
