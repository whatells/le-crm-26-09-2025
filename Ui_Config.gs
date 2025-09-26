/**
 * Module: Ui_Config
 * Rôle: ouvrir la popup de configuration rapide et exposer les helpers d'upsert des clés.
 * Entrées publiques: openConfigUI(), getKnownConfig(), saveConfigValues(), include_().
 * Dépendances: HtmlService (ui_config), SpreadsheetApp (feuille Configuration), Config.gs (getConfig_).
 * Effets de bord: ouvre un modal Sheets, lit/écrit l'onglet Configuration ligne par ligne.
 * Pièges: duplications en fin de fichier (fonctions répétées), attention aux locales (trim/uppercase), éviter insertSheet multiple.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: supprimé les doublons de fonctions et harmonisé les écritures.
 */
const UI_CONFIG_SHEET_NAME = 'Configuration';
const UI_CONFIG_HEADERS = ['Clé', 'Valeur'];

/**
 * Ouvre la fenêtre de configuration (popup Sheets modal).
 * @return {void}
 */
function openConfigUI() {
  const html = HtmlService.createHtmlOutputFromFile('ui_config')
    .setWidth(520)
    .setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, 'Configuration du CRM');
}

/**
 * Inclut un fichier HTML (CSS/JS) et renvoie son contenu.
 * @param {string} filename
 * @return {string}
 */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Renvoie la liste des clés connues avec leurs valeurs actuelles.
 * @return {Array<{key:string,value:*}>}
 */
function getKnownConfig() {
  const knownKeys = [
    // Labels Gmail
    'GMAIL_LABEL_INGEST_STOCK',
    'GMAIL_LABEL_SALES_VINTED',
    'GMAIL_LABEL_SALES_VESTIAIRE',
    'GMAIL_LABEL_SALES_EBAY',
    'GMAIL_LABEL_SALES_LEBONCOIN',
    'GMAIL_LABEL_SALES_WHATNOT',
    'GMAIL_LABEL_FAVORITES_VINTED',
    'GMAIL_LABEL_OFFERS_VINTED',
    'GMAIL_LABEL_PURCHASES_VINTED',
    // Commissions par plateforme
    'COMM_VINTED_PCT', 'COMM_VINTED_MIN', 'COMM_VINTED_FLAT',
    'COMM_VESTIAIRE_PCT', 'COMM_VESTIAIRE_MIN', 'COMM_VESTIAIRE_FLAT',
    'COMM_EBAY_PCT', 'COMM_EBAY_MIN', 'COMM_EBAY_FLAT',
    'COMM_LEBONCOIN_PCT', 'COMM_LEBONCOIN_MIN', 'COMM_LEBONCOIN_FLAT',
    'COMM_WHATNOT_PCT', 'COMM_WHATNOT_MIN', 'COMM_WHATNOT_FLAT',
    // Flags globaux
    'APPLY_URSSAF', 'URSSAF_RATE',
    'APPLY_FIXED_COSTS', 'FIXED_COST_PER_SALE',
    'ROUND_MARGINS'
  ];

  const map = typeof getConfig_ === 'function' ? getConfig_() : {};
  return knownKeys.map(key => ({ key, value: Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '' }));
}

/**
 * Sauvegarde des paires clé/valeur dans l'onglet Configuration.
 * @param {Array<{key:string,value:*}>} rows
 * @return {{ok:boolean,count:number}}
 */
function saveConfigValues(rows) {
  const cleaned = Array.isArray(rows) ? rows.filter(r => r && String(r.key || '').trim()) : [];
  if (!cleaned.length) {
    return { ok: true, count: 0 };
  }

  const sheet = ensureConfigSheet_();
  const index = buildConfigIndex_(sheet);
  const writes = [];
  let nextRow = Math.max(2, sheet.getLastRow() + 1);

  cleaned.forEach(item => {
    const key = String(item.key).trim();
    const value = item.value;
    let row = index[key];
    if (!row) {
      row = nextRow;
      index[key] = row;
      nextRow += 1;
    }
    writes.push({ row, values: [key, value] });
  });

  if (writes.length) {
    writes.sort((a, b) => a.row - b.row);
    writes.forEach(({ row, values }) => {
      sheet.getRange(row, 1, 1, values.length).setValues([values]);
    });
  }

  return { ok: true, count: cleaned.length };
}

/**
 * S'assure que l'onglet Configuration existe avec les en-têtes.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureConfigSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(UI_CONFIG_SHEET_NAME) || ss.insertSheet(UI_CONFIG_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, UI_CONFIG_HEADERS.length)
      .setValues([UI_CONFIG_HEADERS])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Construit un index clé -> numéro de ligne.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Object<string,number>}
 */
function buildConfigIndex_(sheet) {
  const index = {};
  const last = sheet.getLastRow();
  if (last >= 2) {
    const keys = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i][0] || '').trim();
      if (key) {
        index[key] = i + 2;
      }
    }
  }
  return index;
}
