/**
 * Module: Dashboard
 * Rôle: générer la feuille Dashboard avec KPI, blocs de données et graphiques.
 * Entrées publiques: buildDashboard().
 * Dépendances: SpreadsheetApp (feuilles Dashboard, Ventes, Stock, Boosts, Coûts fonctionnement), computeKPIs_(), buildMonthlyRevenue_(), buildPlatformSplit_().
 * Effets de bord: efface et réécrit l'onglet Dashboard, crée des charts, lit massivement les données.
 * Pièges: appels coûteux si feuilles volumineuses (préférer caches), conversions Date/Number, veiller à ne pas supprimer filtres personnalisés.
 * MAJ: 2025-09-26 – Codex Audit
 * @change: nettoyage ciblé et charts conservés quand possible (plus de sheet.clear destructif).
 */

/** Étape 9 — Dashboard : KPI + Graphiques (idempotent) */

function buildDashboard() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
  if (sh.getFrozenRows() < 1) {
    sh.setFrozenRows(1);
  }

  const ventes = ss.getSheetByName('Ventes');
  const stock = ss.getSheetByName('Stock');
  const boosts = ss.getSheetByName('Boosts');
  const costs = ss.getSheetByName('Coûts fonctionnement');

  let rowsV = [];
  if (ventes && ventes.getLastRow() >= 2) {
    rowsV = ventes.getRange(2, 1, ventes.getLastRow() - 1, Math.max(10, ventes.getLastColumn())).getValues();
  }
  let rowsS = [];
  if (stock && stock.getLastRow() >= 2) {
    rowsS = stock.getRange(2, 1, stock.getLastRow() - 1, Math.max(15, stock.getLastColumn())).getValues();
  }
  let rowsB = [];
  if (boosts && boosts.getLastRow() >= 2) {
    rowsB = boosts.getRange(2, 1, boosts.getLastRow() - 1, Math.max(6, boosts.getLastColumn())).getValues();
  }
  let rowsC = [];
  if (costs && costs.getLastRow() >= 2) {
    rowsC = costs.getRange(2, 1, costs.getLastRow() - 1, Math.max(5, costs.getLastColumn())).getValues();
  }

  const kpi = computeKPIs_(rowsV, rowsS, rowsB, rowsC);

  const headers = ['KPI', 'Valeur'];
  const kv = [
    ['CA total', kpi.revenue],
    ['Marge brute', kpi.gross],
    ['Marge nette', kpi.net],
    ['Nb ventes', kpi.countSales],
    ['AOV (panier moyen)', kpi.aov],
    ['Repeat rate acheteurs', kpi.repeatRateStr],
    ['Valeur stock (prix cible)', kpi.stockValue],
    ['Coûts fixes cumulés', kpi.costsTotal],
    ['Coût Boosts', kpi.boostsTotal],
    ['ROI Boosts', kpi.roiBoostsStr],
    ['Favoris (total)', kpi.favs],
    ['Offres (total)', kpi.offers]
  ];

  const block1 = buildMonthlyRevenue_(rowsV);
  const block2 = buildPlatformSplit_(rowsV);
  const block3 = [['Type', 'Total'], ['Favoris', kpi.favs], ['Offres', kpi.offers]];

  const block1Width = block1[0]?.length || 0;
  const block2Width = block2[0]?.length || 0;
  const block3Width = block3[0]?.length || 0;
  const requiredRows = Math.max(kv.length + 2, block1.length + 6, block2.length + 6, block3.length + 6, 35);
  const requiredCols = Math.max(5 + block1Width + 2 + block2Width + 2 + block3Width, 12);
  ensureCapacity_(sh, requiredRows, requiredCols);

  const rowsToClear = Math.min(requiredRows - 1, Math.max(0, sh.getMaxRows() - 1));
  const colsToClear = Math.min(Math.max(requiredCols, 10), sh.getMaxColumns());
  if (rowsToClear > 0 && colsToClear > 0) {
    clearRange_(sh, 2, 1, rowsToClear, colsToClear);
  }

  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (kv.length) {
    sh.getRange(2, 1, kv.length, headers.length).setValues(kv);
  }
  sh.setColumnWidths(1, 2, 200);

  let col = 5;
  col = putBlock_(sh, 1, col, 'CA mensuel', block1);
  col = putBlock_(sh, 1, col + 2, 'CA par plateforme', block2);
  putBlock_(sh, 1, col + 2, 'Favoris / Offres', block3);

  const r1 = block1.length > 1 ? sh.getRange(2, 5, block1.length - 1, block1Width) : null;
  const r2StartCol = 7 + (block1Width ? block1Width - 2 : 0);
  const r2 = block2.length > 1 ? sh.getRange(2, r2StartCol, block2.length - 1, block2Width) : null;
  const r3StartCol = 9 + (block1Width ? block1Width - 2 : 0) + (block2Width ? block2Width - 2 : 0) + 2;
  const r3 = sh.getRange(2, r3StartCol, 2, block3Width);

  ensureChart_(sh, 'CA par mois', builder => {
    builder.asLineChart();
    if (r1) builder.addRange(r1);
    builder.setOption('title', 'CA par mois');
    builder.setPosition(1, 9, 0, 0);
  }, Boolean(r1));

  ensureChart_(sh, 'Répartition CA par plateforme', builder => {
    builder.asPieChart();
    if (r2) builder.addRange(r2);
    builder.setOption('title', 'Répartition CA par plateforme');
    builder.setPosition(16, 9, 0, 0);
  }, Boolean(r2));

  ensureChart_(sh, 'Favoris / Offres', builder => {
    builder.asColumnChart();
    builder.addRange(r3);
    builder.setOption('title', 'Favoris / Offres');
    builder.setPosition(31, 9, 0, 0);
  }, true);
}

// ===== Helpers KPI =====
function computeKPIs_(rowsV, rowsS, rowsB, rowsC) {
  const IDX_V_DATE = 0;
  const IDX_V_PLATFORM = 1;
  const IDX_V_PRICE = 3;
  const IDX_V_FEES = 4;
  const IDX_V_SHIP = 5;
  const IDX_V_BUYER = 6;
  const IDX_V_SKU = 7;
  const IDX_V_GROSS = 8;
  const IDX_V_NET = 9;

  const IDX_S_SKU = 1;
  const IDX_S_TITLE = 2;
  const IDX_S_COST = 8;
  const IDX_S_TARGET = 9;
  const IDX_S_STATUS = 10;
  const IDX_S_FAV = 13;
  const IDX_S_OFFER = 14;

  const IDX_B_COST = 4;
  const IDX_C_AMOUNT = 3;

  const validV = rowsV.filter(r => r[IDX_V_DATE]);
  const revenue = sum_(validV.map(r => num_(r[IDX_V_PRICE])));
  const gross = sum_(validV.map(r => num_(r[IDX_V_GROSS])));
  const net = sum_(validV.map(r => num_(r[IDX_V_NET])));
  const countSales = validV.length;
  const aov = countSales ? round2_(revenue / countSales) : 0;

  const buyers = validV.map(r => String(r[IDX_V_BUYER] || '').trim()).filter(Boolean);
  const buyerCount = new Set(buyers).size || 0;
  const repeats = (() => {
    const freq = {};
    buyers.forEach(b => { freq[b] = (freq[b] || 0) + 1; });
    return Object.values(freq).filter(n => n > 1).length;
  })();
  const repeatRate = buyerCount ? repeats / buyerCount : 0;

  const stockRows = rowsS.filter(r => r[IDX_S_TARGET]);
  const remaining = stockRows.filter(r => {
    const st = String(r[IDX_S_STATUS] || '').toLowerCase();
    return !(st === 'vendu' || st === 'sold');
  });
  const stockValue = sum_(remaining.map(r => num_(r[IDX_S_TARGET])));

  const favs = sum_(rowsS.map(r => num_(r[IDX_S_FAV])));
  const offers = sum_(rowsS.map(r => num_(r[IDX_S_OFFER])));

  const boostsTotal = sum_(rowsB.map(r => num_(r[IDX_B_COST])));
  const costsTotal = sum_(rowsC.map(r => num_(r[IDX_C_AMOUNT])));
  const roiBoosts = boostsTotal > 0 ? (net - boostsTotal) / boostsTotal : null;

  return {
    revenue: round2_(revenue),
    gross: round2_(gross),
    net: round2_(net),
    countSales,
    aov,
    repeatRateStr: (repeatRate * 100).toFixed(1) + ' %',
    stockValue: round2_(stockValue),
    costsTotal: round2_(costsTotal),
    boostsTotal: round2_(boostsTotal),
    roiBoostsStr: roiBoosts == null ? 'n/a' : (roiBoosts * 100).toFixed(1) + ' %',
    favs: round0_(favs),
    offers: round0_(offers)
  };
}

function buildMonthlyRevenue_(rowsV) {
  if (!rowsV.length) return [['Mois', 'CA']];
  const IDX_DATE = 0, IDX_PRICE = 3;
  const map = {};
  rowsV.forEach(r => {
    const d = r[IDX_DATE];
    if (!d) return;
    const baseDate = d instanceof Date ? d : new Date(d);
    const key = baseDate.getFullYear() + '-' + String(baseDate.getMonth() + 1).padStart(2, '0');
    map[key] = (map[key] || 0) + num_(r[IDX_PRICE]);
  });
  const keys = Object.keys(map).sort();
  return [['Mois', 'CA']].concat(keys.map(k => [k, round2_(map[k])]));
}

function buildPlatformSplit_(rowsV) {
  if (!rowsV.length) return [['Plateforme', 'CA']];
  const IDX_PLATFORM = 1, IDX_PRICE = 3;
  const map = {};
  rowsV.forEach(r => {
    const p = String(r[IDX_PLATFORM] || '').trim() || 'Autre';
    map[p] = (map[p] || 0) + num_(r[IDX_PRICE]);
  });
  const keys = Object.keys(map).sort();
  return [['Plateforme', 'CA']].concat(keys.map(k => [k, round2_(map[k])]));
}

function putBlock_(sh, row, col, title, block) {
  const width = block[0]?.length || 2;
  const height = block.length;
  clearRange_(sh, row, col, height + 1, width);
  sh.getRange(row, col, 1, 1).setValue(title).setFontWeight('bold');
  if (height) {
    sh.getRange(row + 1, col, height, width).setValues(block);
  }
  return col + width;
}

function ensureChart_(sheet, title, configureBuilder, hasData) {
  const chart = findChartByTitle_(sheet, title);
  if (!hasData) {
    if (chart) {
      sheet.removeChart(chart);
    }
    return;
  }
  if (chart) {
    const builder = chart.modify();
    builder.clearRanges();
    configureBuilder(builder, false);
    sheet.updateChart(builder.build());
  } else {
    const builder = sheet.newChart();
    configureBuilder(builder, true);
    sheet.insertChart(builder.build());
  }
}

function findChartByTitle_(sheet, title) {
  const charts = sheet.getCharts();
  for (let i = 0; i < charts.length; i++) {
    const c = charts[i];
    const chartTitle = c.getOptions().title || '';
    if (chartTitle === title) {
      return c;
    }
  }
  return null;
}

function clearRange_(sheet, row, col, numRows, numCols) {
  if (numRows <= 0 || numCols <= 0) {
    return;
  }
  sheet.getRange(row, col, numRows, numCols).clearContent();
}

function ensureCapacity_(sheet, minRows, minCols) {
  if (sheet.getMaxRows() < minRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), minRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < minCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), minCols - sheet.getMaxColumns());
  }
}

// small math helpers
function num_(v) { const n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : 0; }
function sum_(arr) { return arr.reduce((a, b) => a + num_(b), 0); }
function round2_(n) { return Math.round(n * 100) / 100; }
function round0_(n) { return Math.round(n || 0); }
