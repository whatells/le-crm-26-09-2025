# Audit technique – CRM Apps Script

## Résumé exécutif
- **P1 – Corrections bloquantes**
  - `Ui_Config.gs` contient des doublons de fonctions (`openConfigUI`, `getKnownConfig`, `saveConfigValues`) et se termine par une accolade orpheline (ligne 141) qui produit une erreur de syntaxe lors du chargement du projet. Les handlers de configuration ne peuvent donc pas s’exécuter tant que la fermeture superflue n’est pas supprimée et que les doublons ne sont pas nettoyés.【F:Ui_Config.gs†L14-L141】
  - `Ui_Server.gs` référence des helpers inexistants (`getDashboardCached_`, `getStockAllRows_`, `getVentesAllRows_`, `softExpireDashboard_`, `purgeStockCache_`, `purgeVentesCache_`) : chaque appel UI (`ui_getDashboard`, `ui_getStockPage`, etc.) déclenche actuellement un `ReferenceError`. Il faut soit réimplémenter ces helpers, soit pointer vers les fonctions disponibles dans `PerfendPoints.gs`/`CRM_DataService.gs`.【F:Ui_Server.gs†L16-L64】
- **P2 – Risques modérés / performances**
  - L’ingestion Gmail (`Gmail_Ingest_Run.gs`) écrit cellule par cellule via `getRange().setValue`, ce qui ralentit fortement le traitement quand les boîtes contiennent beaucoup de messages. Un batching (`setValues`) par colonne réduirait le temps d’exécution et la pression sur les quotas.【F:Gmail_Ingest_Run.gs†L65-L128】
  - Multiples variantes concurrentes des endpoints (`Ui_Server.gs`, `PerfendPoints.gs`, `Ui Server.html`) complexifient le routage et augmentent le risque de divergence ou de cache non invalidé. Centraliser la version performante et désactiver les doublons réduira la maintenance.【F:PerfendPoints.gs†L56-L159】【F:Ui Server.html†L7-L33】
- **P3 – Améliorations opportunes**
  - Les vues HTML riches (`CRM_Scripts.html`, `CRM_Config.html`) injectent du HTML construit par concaténation sans échappement systématique. Ajouter un utilitaire `escapeHtml` (à l’image de `Ui App.js`) limiterait les risques XSS.【F:CRM_Scripts.html†L19-L72】
  - `BackupScriptApi.gs` et `Bordereaux_PDF.gs` manquent de backoff/réessais pour les appels réseau/Drive; prévoir une stratégie `withBackoff_()` homogène améliorerait la robustesse.【F:BackupScriptApi.gs†L18-L88】【F:Bordereaux_PDF.gs†L63-L119】

## Cartographie du projet

### Côté serveur (.gs)
- **Code.gs** – Menu Sheets (`onOpen`) et ouverture des modales (Index.html, CRM_Config).【F:Code.gs†L1-L41】
- **CRM_DataService.gs** – Création/formatage des feuilles, calculs Dashboard, requêtes Stock/Ventes/Achats.【F:CRM_DataService.gs†L1-L199】
- **Dashboard.gs** – Recomposition complète de l’onglet Dashboard (KPI + charts).【F:Dashboard.gs†L1-L109】
- **Gmail_Ingest_* (Run/Optimized/Parsers)** – Pipelines d’ingestion Gmail standard vs optimisée avec caches et idempotence.【F:Gmail_Ingest_Run.gs†L1-L160】【F:Gmail_Ingest_Run_Optimized.gs†L1-L120】【F:Gmail_Ingest_Parsers.gs†L1-L92】
- **Step1/2/3/8** – Scripts en cascade pour structurer les feuilles, normaliser SKU/titres, lier Achats↔Stock et calculer marges avancées.【F:Step1_Structure.gs†L1-L80】【F:Step2_SkulTitre.gs†L1-L80】【F:Step3_Liaison_Achats_Stock.gs†L1-L80】【F:Step8 Fees Margins.gs†L1-L90】
- **PerfendPoints.gs / Ui_Server.gs** – Endpoints exposés à l’UI avec caches (PerfendPoints) ou version paginée historique (Ui_Server).【F:PerfendPoints.gs†L1-L160】【F:Ui_Server.gs†L16-L79】
- **CRM_ConfigService.gs / Ui_Config.gs** – Gestion de la configuration (lecture/écriture, backup) et pop-up dédiée.【F:CRM_ConfigService.gs†L1-L120】【F:Ui_Config.gs†L14-L140】
- **BackupScriptApi.gs / Bordereaux_PDF.gs / Perf_Optim.gs / ScanUnicode.gs** – Outils annexes (backup API, génération PDF, triggers, audit Unicode).【F:BackupScriptApi.gs†L1-L101】【F:Bordereaux_PDF.gs†L1-L119】【F:Perf_Optim.gs†L1-L45】【F:ScanUnicode.gs†L1-L24】

### Côté client (HTML/JS/CSS)
- **Index.html + Ui App.js/html/css** – SPA moderne avec bootstrap JSON, badge réseau, onglets dynamiques.【F:Index.html†L1-L72】【F:Ui App.js.html†L1-L160】【F:Ui app.css.html†L1-L40】
- **CRM_Interface.html + CRM_Scripts/Styles** – Interface riche héritée (navigation, analytics, config étendue).【F:CRM_Interface.html†L1-L60】【F:CRM_Scripts.html†L1-L72】【F:CRM_Styles.html†L1-L40】
- **CRM_Config.html** – Modale détaillée de configuration (plateformes, notifications).【F:CRM_Config.html†L1-L40】
- **index.html + app.js/html** – Prototype minimal utilisé lors des premières étapes.【F:index.html†L1-L40】【F:app.js.html†L1-L30】

## Problèmes détectés (classés)

### Correctness
1. **P1 – Accolade orpheline + doublons dans Ui_Config** : la fermeture ligne 141 n’a pas d’ouverture correspondante et le fichier redéclare les mêmes fonctions deux fois, ce qui casse le parsing et peut masquer des modifications ultérieures.【F:Ui_Config.gs†L14-L141】 Solution : supprimer la seconde copie des fonctions et l’accolade isolée.
2. **P1 – Endpoints Ui_Server non fonctionnels** : `ui_getDashboard/ui_getStockPage/ui_getVentesPage` appellent des helpers absents (`getDashboardCached_`, `getStockAllRows_`, etc.), entraînant des `ReferenceError` dès la première invocation depuis l’UI historique.【F:Ui_Server.gs†L16-L64】 Solution : réutiliser les implémentations de `PerfendPoints.gs` (ou de `CRM_DataService.gs`) ou supprimer cette façade.
3. **P2 – Conflit de nommage `openCRM`** : `Code.gs` et `PerfendPoints.gs` déclarent chacun une fonction `openCRM`. L’ordre de chargement déterminera la version active, ce qui complique le débogage et peut provoquer l’ouverture d’une mauvaise vue.【F:Code.gs†L18-L41】【F:PerfendPoints.gs†L40-L62】 Recommandé : renommer l’une des variantes ou déléguer vers une unique implémentation.
4. **P3 – `CRM_ConfigService.setConfigValue`** : l’appel `JSON.parse` sur la clé `categories` suppose un JSON valide; la moindre faute de frappe lève une exception silencieusement capturée et renvoie la configuration par défaut.【F:CRM_ConfigService.gs†L73-L104】 Ajouter un `try/catch` dédié ou stocker la liste en colonnes séparées.

### Performance
1. **P2 – Écritures cellule par cellule lors de l’ingestion** : `upsertStock_`, `insertSale_`, `bumpCounter_` et `ingestPurchasesVinted` font plusieurs `setValue` par ligne, multiplicant les allers-retours SpreadsheetApp.【F:Gmail_Ingest_Run.gs†L65-L152】 Préférer un buffer `values` puis un `setValues` unique (batch) pour chaque ligne traitée.
2. **P2 – Dashboard rebuild destructif** : `buildDashboard()` appelle `sh.clear()` avant de reconstruire, ce qui efface formats personnalisés ajoutés manuellement par les utilisateurs.【F:Dashboard.gs†L5-L47】 Privilégier `clearContents` + `clearFormats` ciblés.
3. **P3 – Slides/PDF générés un par un** : `labelsGenerateVisible()` crée une présentation par ligne visible sans pooling ni nettoyage différé.【F:Bordereaux_PDF.gs†L34-L118】 Limiter le nombre de présentations en réutilisant un template.

### UI/UX & réseau
1. **P2 – HTML injecté sans échappement** : `CRM_Scripts.html` concatène des fragments HTML avec des valeurs issues des feuilles (`updateDashboard`, `updateRecentActivity`). Une donnée utilisateur contenant du HTML sera interprétée.【F:CRM_Scripts.html†L25-L64】 Ajouter un `escapeHtml` uniforme.
2. **P3 – Multiples SPA concurrentes** : `Index.html` (bootstrap JSON), `Ui App.html` (SPA sombre) et `CRM_Interface.html` coexistent. Sans gouvernance, l’utilisateur peut ouvrir une version obsolète via le menu Sheets (selon la fonction `openCRM` active). Documenter la version supportée et désactiver les autres.

### Stabilité / quotas Apps Script
1. **P2 – Absence de backoff** : `BackupScriptApi.fetchProjectContent_`/`fetchProjectManifest_` et `Gmail_Ingest_Run` n’intègrent pas de `withBackoff_` alors qu’ils manipulent des APIs sensibles aux limites.【F:BackupScriptApi.gs†L52-L88】【F:Gmail_Ingest_Run_Optimized.gs†L34-L78】 Mutualiser une fonction de retry exponentiel.
2. **P3 – Caches non purgés** : `PerfendPoints` met en cache le bootstrap/kpi/stock/ventes mais ne purge pas automatiquement lors des écritures directes dans les feuilles (en dehors des fonctions prévues).【F:PerfendPoints.gs†L96-L165】 Prévoir un hook `onEdit` ou rappeler `purge*()` après les scripts d’ingestion.

### Sécurité
1. **P3 – Scope Script API** : `BackupScriptApi` nécessite `https://www.googleapis.com/auth/script.projects` – scope large pour un CRM. Documenter l’usage et restreindre l’activation à la création d’un backup ponctuel.【F:BackupScriptApi.gs†L9-L16】
2. **P3 – Absence de validation côté serveur** : `saveConfiguration` écrit directement dans la feuille sans vérifier les types ni les limites (commission >100 %, etc.).【F:CRM_ConfigService.gs†L37-L69】 Ajouter des gardes.

### i18n / encodage
- Aucun caractère problématique détecté dans le code audité, mais `ScanUnicode.gs` est présent pour le monitoring. Les UI utilisent déjà `...` ASCII via sanitisation dans `Index.html`/`Ui App.js`.【F:Index.html†L49-L63】

### Qualité code
1. **P2 – Duplication `Ui_Config.gs`** : deux blocs quasi identiques rendent la maintenance pénible et favorisent les divergences.【F:Ui_Config.gs†L14-L137】 Fusionner en une implémentation unique.
2. **P3 – Mélange de conventions** : coexistence de `const/let/var`, multiples versions d’UI, commentaires en double. Établir des conventions (ES2015+ côté serveur, modules UI rationalisés).

## Recommandations concrètes
- **Correctifs minimaux (PR séparée)**
  1. Supprimer la seconde série de fonctions dans `Ui_Config.gs` et l’accolade orpheline; ajouter un test unitaire Apps Script minimal (`getKnownConfig` doit retourner les clés attendues).
  2. Remplacer les appels à helpers inexistants dans `Ui_Server.gs` par ceux de `PerfendPoints` (ou supprimer la façade pour éviter les collisions) et aligner `openCRM` sur une seule implémentation.
  3. Introduire des opérations batch (`setValues`) dans les fonctions d’ingestion critiques (Stock/Ventes/Achats) et mutualiser un helper `updateRow_`.

- **Patterns recommandés**
  - Mettre en place un utilitaire `withBackoff_` commun (déjà présent dans `Gmail_Ingest_Run_Optimized.gs`) pour `UrlFetchApp` et `GmailApp`.
  - Centraliser les endpoints dans `PerfendPoints` et convertir les autres fichiers (`Ui_Server.gs`, `Ui Server.html`) en wrappers de rétrocompatibilité.
  - Ajouter un `escapeHtml` partagé dans les vues `CRM_Scripts.html` et `CRM_Config.html` pour toute insertion dynamique.
  - Documenter l’usage des caches (`purgeDashboardCache`, etc.) et exposer des boutons UI correspondants.

- **Durcissement**
  - Ajouter des `try/catch` avec `logE_` autour des opérations Drive/Slides (Bordereaux) et Gmail.
  - Utiliser `console.time` / `logE_` pour mesurer les temps d’ingestion (déjà amorcé dans `Ui App.js` via `console.time('bootstrap')`).
  - Vérifier les scopes `appsscript.json` et retirer les autorisations inutiles (ex. Script API activé uniquement si backup nécessaire).

## Annexes

### Table des endpoints exposés

| Endpoint serveur | Provenance | Consommateurs UI |
| --- | --- | --- |
| `openCRM` | `Code.gs` / `PerfendPoints.gs` | Menu Sheets (modal principale) |
| `ui_getDashboard` | `PerfendPoints.gs`, `Ui_Server.gs` (défectueux) | `Ui App.js`, `CRM_Scripts.html` |
| `ui_getStockAll` / `ui_getStockPage` | `PerfendPoints.gs` / `Ui_Server.gs` | `Ui App.js`, `CRM_Scripts.html` |
| `ui_getVentesAll` / `ui_getVentesPage` | `PerfendPoints.gs` / `Ui_Server.gs` | `Ui App.js`, `CRM_Scripts.html` |
| `ui_getConfig` / `ui_saveConfig` | `PerfendPoints.gs`, `Ui_Config.gs`, `CRM_ConfigService.gs` | `Ui App.js`, `CRM_Config.html`, `ui_config.html` |
| `ui_step3RefreshRefs` | `PerfendPoints.gs`, `Ui_Server.gs` | Boutons Step3 (Ui App / Index) |
| `ui_step8RecalcAll` | `PerfendPoints.gs`, `Ui_Server.gs` | Boutons recalcul marges |
| `ui_ingestFast` | `PerfendPoints.gs`, `Ui_Server.gs` | Bouton ingestion rapide |
| `cronRecomputeBootstrap` / `setupTriggers` | `PerfendPoints.gs` | Maintenance (triggers) |

### Latence / mesures
- Pas de bench chiffré exécuté (environnement offline). Prévoir instrumentation via `console.time` côté serveur lors du prochain sprint.
