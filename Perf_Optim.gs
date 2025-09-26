/**
 * Module: Perf_Optim
 * Rôle: journalisation centralisée et maintenance (triggers, purge de caches).
 * Entrées publiques: logE_(), step10InstallHourlyTrigger(), step10RemoveTriggers(), step10ClearCaches().
 * Dépendances: SpreadsheetApp (Logs), ScriptApp (triggers), CacheService/PropertiesService (PROC_IDS, THREAD_CURSOR).
 * Effets de bord: écrit dans Logs, crée/supprime des triggers, vide caches et globals.
 * Pièges: suppression agressive des caches partagés, attention aux triggers multiples si l'ancien n'est pas retiré.
 * MAJ: 2025-09-26 – Codex Audit
 */
/**
 * Perf_Optim.gs — Logs, triggers et maintenance
 */

// --- Logger centralisé ---
function logE_(level, source, message, details) {
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = ss.getSheetByName("Logs") || ss.insertSheet("Logs");
    if (sh.getLastRow() === 0) {
      sh.getRange(1,1,1,5)
        .setValues([["Horodatage","Niveau","Source","Message","Détails"]])
        .setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    sh.appendRow([new Date(), level, source, message, details || ""]);
  } catch (e) {
    // On évite de casser si le fichier n'est pas prêt.
  }
}

// --- Triggers horaires ---
function step10InstallHourlyTrigger() {
  step10RemoveTriggers();
  ScriptApp.newTrigger("ingestAllLabelsFast").timeBased().everyHours(1).create();
  logE_("INFO","Step10","Trigger horaire installé","ingestAllLabelsFast");
}

function step10RemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "ingestAllLabelsFast") {
      ScriptApp.deleteTrigger(t);
    }
  });
  logE_("INFO","Step10","Triggers Étape10 supprimés","");
}

// --- Purge caches/états ---
function step10ClearCaches() {
  const cache = CacheService.getUserCache();
  cache.remove("PROC_IDS");
  cache.remove("THREAD_CURSOR");

  const props = PropertiesService.getUserProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function(key) {
    if (key === "PROC_IDS" || key === "THREAD_CURSOR" || key.indexOf("THREAD_CURSOR::") === 0) {
      props.deleteProperty(key);
    }
  });

  // Variables globales optionnelles si présentes dans d'autres fichiers
  try {
    if (typeof PROC_IDS_FAST_CACHE !== "undefined") {
      PROC_IDS_FAST_CACHE = null;
    }
    if (typeof PROC_IDS_CACHE_ !== "undefined") {
      PROC_IDS_CACHE_ = null;
    }
    if (typeof PROC_IDS_SHEET_SYNCED_ !== "undefined") {
      PROC_IDS_SHEET_SYNCED_ = false;
    }
  } catch (e) {}

  logE_("INFO","Step10","Caches & états purgés","");
}
