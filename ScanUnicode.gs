/**
 * Module: ScanUnicode
 * Rôle: audit des caractères unicode problématiques dans le projet Apps Script.
 * Entrées publiques: scanProjectForUnicode().
 * Dépendances: ScriptApp (ID), service avancé Script (Script.Projects).
 * Effets de bord: journalise les lignes suspectes via Logger (pas de modifications).
 * Pièges: nécessite activer l'API Apps Script, quotas de Script API, regex limitée aux caractères courants.
 * MAJ: 2025-09-26 – Codex Audit
 */
// ===== ScanUnicode.gs — détecte … ’ ‘ “ ” dans tous les fichiers du projet =====
// Requiert d'activer le service avancé "Apps Script API" (Script)

function scanProjectForUnicode() {
  const SCRIPT_ID = ScriptApp.getScriptId();
  const res = Script.Projects.getContent(SCRIPT_ID);
  const bad = /[\u2026\u2018\u2019\u201C\u201D]/; // … ’ ‘ “ ”
  let count = 0;
  res.files.forEach(f => {
    const src = f.source || '';
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (bad.test(line)) {
        count++;
        Logger.log('%s:%s -> %s', f.name + '.' + extOfType_(f.type), (i+1), showMarks_(line));
      }
    });
  });
  Logger.log('Total lignes suspectes: %s', count);
}

function extOfType_(t){
  switch (String(t)) {
    case 'SERVER_JS': return 'gs';
    case 'HTML':      return 'html';
    case 'JSON':      return 'json';
    default:          return 'txt';
  }
}
function showMarks_(s){
  return s.replace(/\u2026/g,'[ELLIPSIS]')
          .replace(/\u2018/g,'[LSQ]')
          .replace(/\u2019/g,'[RSQ]')
          .replace(/\u201C/g,'[LDQ]')
          .replace(/\u201D/g,'[RDQ]');
}
