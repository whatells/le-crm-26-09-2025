/**
 * Module: Step2_SkulTitre
 * Rôle: maintenir cohérence SKU/Titre et relayer événements Étape 3 via onEdit.
 * Entrées publiques: onEdit(e), fixOneStockRow_(), fixOneVenteRow_().
 * Dépendances: SpreadsheetApp (Stock, Ventes, Achats), Step3 (step3PropagateRow_), Step8 (step8InvalidateCostCache_), log_().
 * Effets de bord: modifie cellules lors d'éditions, force uppercase, ajoute SKU au titre, déclenche propagation prix.
 * Pièges: onEdit doit rester rapide (<30s), expressions régulières sur SKU, dépendances conditionnelles (fonctions undefined ignorées).
 * MAJ: 2025-09-26 – Codex Audit
 */
// ==============================
// FICHIER 2 / 3 : Step2_SkuTitre.gs (COMPLET — VERSION ÉTAPE 3)
// ==============================

/**
 * Étape 2 — Règles SKU & Titre + hook Étape 3
 * - Stock : forcer SKU en MAJ, garantir présence du SKU dans le Titre
 * - Ventes : extraire le SKU depuis le Titre vers la colonne SKU
 * - OnEdit prend aussi en charge la colonne "Réf. Achat" de Stock (Étape 3)
 */

var SHEET_STOCK  = "Stock";
var SHEET_VENTES = "Ventes";
var COL_STOCK_SKU = 2;   // B
var COL_STOCK_TIT = 3;   // C
var COL_STOCK_REF = 13;  // M (Réf. Achat)
var COL_VENTES_TIT = 3;  // C
var COL_VENTES_SKU = 8;  // H

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var r = e.range.getRow();
    var c = e.range.getColumn();
    if (r < 2) return; // ignorer l’en-tête

    var name = sh.getName();
    var achatsName = (typeof SHEET_ACHATS === 'string') ? SHEET_ACHATS : 'Achats';
    if (name === achatsName) {
      var achatsPrixCol = (typeof COL_ACHATS_PRIX === 'number') ? COL_ACHATS_PRIX : 3;
      var achatsRefCol = (typeof COL_ACHATS_REF === 'number') ? COL_ACHATS_REF : 9;
      if (typeof step3InvalidateRefCache_ === 'function' && (c === achatsPrixCol || c === achatsRefCol)) {
        try { step3InvalidateRefCache_(); } catch (_) {}
      }
      return;
    }

    if (name === SHEET_STOCK) {
      if (c === COL_STOCK_SKU || c === COL_STOCK_TIT) {
        fixOneStockRow_(sh, r);
      }
      if (c === COL_STOCK_REF) {
        // Étape 3 : dès qu’on choisit une Réf Achat, on propage le prix
        step3PropagateRow_(sh, r);
      }
      var prixCol = (typeof COL_STOCK_PRIX_ACHAT === 'number') ? COL_STOCK_PRIX_ACHAT : 9;
      if (c === prixCol && typeof step8InvalidateCostCache_ === 'function') {
        try { step8InvalidateCostCache_(); } catch (_) {}
      }
      return;
    }

    if (name === SHEET_VENTES) {
      if (c === COL_VENTES_TIT || c === COL_VENTES_SKU) {
        fixOneVenteRow_(sh, r);
      }
      return;
    }
  } catch (err) {
    log_("ERROR", "onEdit", String(err));
  }
}

// ---------- STOCK : maintenance ligne par ligne ----------
function fixOneStockRow_(sh, row) {
  var data = sh.getRange(row, COL_STOCK_SKU, 1, 2).getValues()[0];
  var skuRaw = data[0];
  var titleRaw = data[1];
  var sku = String(skuRaw || "").trim().toUpperCase();
  var title = String(titleRaw || "").trim();
  var changed = false;

  if (sku && sku !== String(skuRaw || "")) {
    data[0] = sku;
    changed = true;
  }

  var okSku = /^[A-Z0-9]{1,4}$/.test(sku);
  if (okSku) {
    var re = new RegExp("\\b" + sku + "\\b");
    if (!re.test(title)) {
      data[1] = (title ? title + " " : "") + sku;
      changed = true;
    }
  }

  if (changed) {
    sh.getRange(row, COL_STOCK_SKU, 1, 2).setValues([data]);
  }
}

// ---------- VENTES : maintenance ligne par ligne ----------
function fixOneVenteRow_(sh, row) {
  var width = COL_VENTES_SKU - COL_VENTES_TIT + 1;
  var data = sh.getRange(row, COL_VENTES_TIT, 1, width).getValues()[0];
  var titleRaw = data[0];
  var skuRaw = data[width - 1];
  var title = String(titleRaw || "").trim();
  var sku = String(skuRaw || "").trim().toUpperCase();
  var newTitle = title;
  var newSku = sku;
  var titleChanged = false;
  var skuChanged = false;

  var m = title.match(/\b[A-Z0-9]{1,4}\b/);
  if (m && m[0]) {
    var extracted = m[0].toUpperCase();
    if (!sku || sku !== extracted) {
      newSku = extracted;
      skuChanged = true;
    }
  }

  if (newSku) {
    var re = new RegExp("\\b" + newSku + "\\b");
    if (!re.test(newTitle)) {
      newTitle = (newTitle ? newTitle + " " : "") + newSku;
      titleChanged = true;
    }
  }

  if (skuChanged) {
    sh.getRange(row, COL_VENTES_SKU).setValue(newSku);
  }
  if (titleChanged) {
    sh.getRange(row, COL_VENTES_TIT).setValue(newTitle);
  }
}