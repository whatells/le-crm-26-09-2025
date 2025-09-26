/**
 * Module: BackupScriptApi
 * Rôle: automatiser la sauvegarde complète d'un projet Apps Script via l'API Script et Drive.
 * Entrées publiques: backupProjectUsingScriptApi(), scheduleDailyBackupScriptApi().
 * Dépendances: UrlFetchApp (Script API), ScriptApp (token), DriveApp (dossiers/ZIP), SpreadsheetApp UI (alertes).
 * Effets de bord: crée des dossiers horodatés, fichiers individuels, ZIP et summary.json; peut mettre à la corbeille d'anciens backups.
 * Pièges: nécessite activation de l'API Script + scope script.projects, quotas UrlFetch/Drive, valeur TARGET_SCRIPT_ID à renseigner.
 * MAJ: 2025-09-26 – Codex Audit
 */
/**
 * ===== BackupScriptApi.gs =====
 * Sauvegarde 100% du code d'un projet Apps Script via Script API (UrlFetchApp).
 * - Exporte .gs, .html, .json (manifest si récupéré)
 * - Dossier horodaté + ZIP + summary.json
 * - Rétention automatique
 *
 * PRÉREQUIS:
 * 1) Activer "Google Apps Script API" dans Google Cloud Console du projet lié.
 * 2) Avoir le scope "https://www.googleapis.com/auth/script.projects" dans appsscript.json.
 */

const BACKUP_ROOT_FOLDER_NAME = 'GAS_Backups';
const RETENTION_DAYS          = 30;     // 0 = jamais supprimer
const TARGET_SCRIPT_ID        = '';     // vide = ce projet; sinon ID d’un autre script à sauvegarder

function backupProjectUsingScriptApi() {
  const scriptId = TARGET_SCRIPT_ID || ScriptApp.getScriptId();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');

  // 1) Récupère le contenu du projet
  const content = fetchProjectContent_(scriptId); // {files:[{name,type,source},...]}
  if (!content || !Array.isArray(content.files) || !content.files.length) {
    throw new Error('Script API: aucun fichier renvoyé. Vérifie activation + scopes.');
  }

  // 2) Dossier de backup
  const root = getOrCreateFolder_(BACKUP_ROOT_FOLDER_NAME);
  const backupFolder = root.createFolder('Backup_' + stamp);

  // 3) Fichiers individuels
  const blobs = [];
  content.files.forEach(f => {
    const meta = filenameFor_(f.name, f.type);
    const blob = Utilities.newBlob(f.source || '', meta.mimeType, meta.fileName);
    backupFolder.createFile(blob);
    blobs.push(blob);
  });

  // 4) Tente d'ajouter le manifest (non bloquant)
  try {
    const manifest = fetchProjectManifest_(scriptId);
    if (manifest) {
      const mf = Utilities.newBlob(JSON.stringify(manifest, null, 2), MimeType.PLAIN_TEXT, 'appsscript.json');
      backupFolder.createFile(mf);
      blobs.push(mf);
    }
  } catch (e) {
    console.warn('Manifest non récupéré (ok):', e && e.message ? e.message : e);
  }

  // 5) ZIP global
  try {
    const zip = Utilities.zip(blobs, 'project_' + stamp + '.zip');
    backupFolder.createFile(zip);
  } catch (e) {
    console.warn('ZIP échoué (ok):', e);
  }

  // 6) Résumé
  const summary = {
    scriptId: scriptId,
    when: new Date().toISOString(),
    files: content.files.map(f => ({ name: f.name, type: f.type, size: (f.source || '').length }))
  };
  backupFolder.createFile('backup_summary.json', JSON.stringify(summary, null, 2), MimeType.PLAIN_TEXT);

  // 7) Rétention
  if (RETENTION_DAYS > 0) applyRetention_(root, RETENTION_DAYS);

  const msg = '✅ Backup terminé: ' + backupFolder.getUrl();
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch(_) {}
}

/** Déclencheur quotidien 03:00 */
function scheduleDailyBackupScriptApi() {
  ScriptApp.newTrigger('backupProjectUsingScriptApi')
    .timeBased().everyDays(1).atHour(3).create();
  Logger.log('Déclencheur quotidien créé (03:00).');
}

/* ======== Script API (UrlFetchApp) ======== */

function fetchProjectContent_(scriptId) {
  const url = 'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/content';
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error('GET content: ' + resp.getResponseCode() + ' ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

function fetchProjectManifest_(scriptId) {
  // La v1 ne renvoie pas directement le manifest via /projects; souvent il est déjà dans /content.
  // On renvoie null proprement si non dispo.
  const url = 'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId);
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) {
    console.warn('GET project meta: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return null;
  }
  // Métadonnées seulement; on ne s’en sert pas pour le manifest ici.
  return null;
}

/* ======== Helpers ======== */

function getOrCreateFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function filenameFor_(name, type) {
  switch (String(type)) {
    case 'SERVER_JS': return { fileName: name + '.gs',   mimeType: MimeType.PLAIN_TEXT };
    case 'HTML':      return { fileName: name + '.html', mimeType: MimeType.HTML };
    case 'JSON':      return { fileName: name + '.json', mimeType: MimeType.PLAIN_TEXT };
    default:          return { fileName: name + '.txt',  mimeType: MimeType.PLAIN_TEXT };
  }
}

function applyRetention_(rootFolder, days) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const it = rootFolder.getFolders();
  let purged = 0;
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    if (!/^Backup_\d{4}-\d{2}-\d{2}_\d{6}$/.test(n)) continue;
    if (f.getDateCreated() < cutoff) {
      trashFolderRecursive_(f);
      purged++;
    }
  }
  if (purged) Logger.log('Rétention: ' + purged + ' ancien(s) backup(s) supprimé(s).');
}

function trashFolderRecursive_(folder) {
  const files = folder.getFiles();
  while (files.hasNext()) files.next().setTrashed(true);
  const subs = folder.getFolders();
  while (subs.hasNext()) trashFolderRecursive_(subs.next());
  folder.setTrashed(true);
}
