/**
 * Module: Code
 * Rôle: point d'entrée Sheets (menu CRM) et helpers HtmlService.
 * Entrées publiques: onOpen(), openCRM(), openConfig(), include(), initializeStructure().
 * Dépendances: SpreadsheetApp UI (menus, modales), HtmlService (Index, CRM_Config), createSheetsStructure() depuis CRM_DataService.
 * Effets de bord: crée un menu personnalisé, ouvre des dialogues modaux, initialises les onglets si demandé.
 * Pièges: respecter XFrameOptions ALLOWALL pour HtmlService, alerte utilisateur sur erreurs, attention aux appels multiples d'initializeStructure().
 * MAJ: 2025-09-26 – Codex Audit
 */
/**
 * CRM Complet - Point d'entrée principal
 * Inspiré de VintedCRM.com pour l'ergonomie et les couleurs
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🚀 CRM")
    .addItem("📊 Ouvrir le CRM", "openCRM")
    .addSeparator()
    .addItem("⚙️ Configuration", "openConfig")
    .addSeparator()
    .addItem("🔧 Initialiser la structure", "initializeStructure")
    .addToUi();
}

/**
 * Ouvre la fenêtre de configuration
 */
function openConfig() {
  const html = HtmlService.createTemplateFromFile('CRM_Config');
  const htmlOutput = html.evaluate()
    .setWidth(800)
    .setHeight(600)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, '⚙️ Configuration CRM');
}

/**
 * Fonction pour inclure des fichiers CSS/JS
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Initialise la structure des feuilles si nécessaire
 */
function initializeStructure() {
  try {
    createSheetsStructure();
    SpreadsheetApp.getUi().alert('✅ Structure initialisée avec succès !');
  } catch (error) {
    SpreadsheetApp.getUi().alert('❌ Erreur lors de l\'initialisation : ' + error.toString());
  }
}