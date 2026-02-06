// public/app.js - WITH PICK NUMBER AND WAREHOUSE LOCATION SUPPORT
(() => {
  'use strict';

  // ===== State ==============================================================
  let products = [];
  let modifiedData = new Map();
  let duplicateSkus = new Set();
  let duplicatePickNumbers = new Set();
  let selectedIds = new Set(); // rows chosen for Save
  let baseline = new Map();    // ORIGINAL values at last refresh (for accurate diffing)
  let HS_MAP = new Map();      // HS -> { desc, country }
  let dataSource = 'db';       // 'db' or 'shopify'
  let needsSync = false;

  // Track current label generation type
  let currentLabelType = null;

  // ===== Column Configuration ===============================================
  // Default column definitions
  const DEFAULT_COLUMNS = [
    { id: 'select', label: 'Select', visible: true, fixed: true, width: 50 },
    { id: 'status', label: 'Status', visible: true, width: 80 },
    { id: 'tags', label: 'Tags', visible: true, width: 150 },
    { id: 'productTitle', label: 'Product Title', visible: true, width: 200 },
    { id: 'variant', label: 'Variant', visible: true, width: 120 },
    { id: 'shipstationName', label: 'ShipStation Name', visible: false, width: 250 },
    { id: 'sku', label: 'SKU', visible: true, width: 150 },
    { id: 'pickNumber', label: 'Pick #', visible: true, width: 100 },
    { id: 'location', label: 'Location', visible: true, width: 100 },
    { id: 'price', label: 'Price', visible: true, width: 80 },
    { id: 'inventory', label: 'Inventory', visible: true, width: 80 },
    { id: 'weight', label: 'Weight (g)', visible: true, width: 80 },
    { id: 'hsCode', label: 'HS Code', visible: true, width: 100 },
    { id: 'country', label: 'Country', visible: true, width: 70 }
  ];

  // Tags state
  let allTags = [];
  let variantTags = {}; // { variantId: [{ id, name, color }, ...] }

  let columnConfig = loadColumnConfig();

  function loadColumnConfig() {
    try {
      const saved = localStorage.getItem('productManagerColumns');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults to handle new columns
        const merged = DEFAULT_COLUMNS.map(def => {
          const savedCol = parsed.find(c => c.id === def.id);
          return savedCol ? { ...def, visible: savedCol.visible, width: savedCol.width || def.width } : def;
        });
        // Reorder based on saved order
        const ordered = [];
        parsed.forEach(savedCol => {
          const col = merged.find(c => c.id === savedCol.id);
          if (col) ordered.push(col);
        });
        // Add any new columns not in saved config
        merged.forEach(col => {
          if (!ordered.find(c => c.id === col.id)) ordered.push(col);
        });
        return ordered;
      }
    } catch (e) { console.error('Error loading column config:', e); }
    return JSON.parse(JSON.stringify(DEFAULT_COLUMNS));
  }

  function saveColumnConfig() {
    localStorage.setItem('productManagerColumns', JSON.stringify(columnConfig));
  }

  // Expose functions used by inline HTML (buttons/onclicks)
  window.refreshProducts = refreshProducts;
  window.saveChanges = saveChanges;
  window.makeEditable = makeEditable;
  window.toggleSelect = toggleSelect;
  window.filterTable = filterTable;
  window.showErrors = showErrors;
  window.closeErrors = closeErrors;
  window.generateSkusForDuplicates = generateSkusForDuplicates;
  window.generateSkusForMissing = generateSkusForMissing;
  window.exportShipStationCSV = exportShipStationCSV;
  window.promptLoadHsMap = promptLoadHsMap;
  window.syncFromShopify = syncFromShopify;
  window.syncToShipStation = syncToShipStation;
  window.importShipStationNames = importShipStationNames;
  window.HS_MAP = HS_MAP;
  // New label and filter functions
  window.selectAllVisible = selectAllVisible;
  window.clearSelection = clearSelection;
  window.generateDetailedLabels = generateDetailedLabels;
  window.generateLargeQRLabels = generateLargeQRLabels;
  window.generateQRLabels = generateQRLabels;
  window.generateQRInventoryLabels = generateQRInventoryLabels;
  window.closeLabelPreview = closeLabelPreview;
  window.downloadLabels = downloadLabels;
  window.generatePickNumbers = generatePickNumbers;
  window.handleCheckboxClick = handleCheckboxClick;
  // Column settings functions
  window.openColumnSettings = openColumnSettings;
  window.closeColumnSettings = closeColumnSettings;
  window.toggleColumn = toggleColumn;
  window.resetColumns = resetColumns;
  // Tag functions
  window.openTagManager = openTagManager;
  window.closeTagManager = closeTagManager;
  window.createTag = createTag;
  window.deleteTag = deleteTag;
  window.applyTagToSelected = applyTagToSelected;
  window.removeTagFromSelected = removeTagFromSelected;
  window.filterByTag = filterByTag;

  // Track last clicked checkbox index for shift+click
  let lastCheckedIndex = null;

  // Sorting state
  let sortColumn = null;
  let sortDirection = 'asc'; // 'asc' or 'desc'

  // Pick number suggestion tracking
  let pickSuggestionCounter = null;
  let usedPickNumbers = new Set();

  // Expose sorting and suggestion functions
  window.sortByColumn = sortByColumn;
  window.acceptPickSuggestion = acceptPickSuggestion;

  // ===== Boot ===============================================================
  document.addEventListener('DOMContentLoaded', () => {
    // Setup filter checkboxes (mutually exclusive)
    const filterCheckboxes = [
      'showDuplicatesOnly',
      'showMissingOnly',
      'showDupPicksOnly',
      'showMissingPicksOnly',
      'showMissingLocsOnly',
      'showModifiedOnly'
    ];

    const syncTabs = (changed) => {
      filterCheckboxes.forEach(id => {
        const cb = document.getElementById(id);
        if (cb && cb !== changed && changed.checked) {
          cb.checked = false;
        }
      });
      filterTable();
    };

    filterCheckboxes.forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.addEventListener('change', () => syncTabs(cb));
    });

    // Try loading any cached HS map
    (function bootstrapHsMapFromStorage() {
      try {
        const raw = localStorage.getItem('HS_MAP_CSV_RAW');
        if (raw) loadHsMapFromCSV(raw);
      } catch {}
    })();

    refreshProducts();
  });

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`HTTP ${res.status} - non-JSON response: ${text.slice(0,120)}`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ===== Data refresh & render =============================================
  async function refreshProducts() {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const statusBar = document.getElementById('statusBar');
    const statusMessage = document.getElementById('statusMessage');
    const syncBanner = document.getElementById('syncBanner');

    loading.classList.add('active');
    loadingText.textContent = 'Loading products from database...';
    statusBar.className = 'status-bar';

    try {
      const response = await fetch('/api/products');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      products = data.products || [];
      duplicateSkus = new Set(data.duplicates || []);
      duplicatePickNumbers = new Set(data.duplicatePickNumbers || []);
      dataSource = data.stats?.source || 'db';
      needsSync = data.needsSync || false;
      modifiedData.clear();

      // Update source indicator
      const sourceIndicator = document.getElementById('sourceIndicator');
      if (sourceIndicator) {
        sourceIndicator.textContent = dataSource.toUpperCase();
        sourceIndicator.className = `source-indicator ${dataSource}`;
      }

      // Show/hide sync banner
      if (syncBanner) {
        if (needsSync || products.length === 0) {
          syncBanner.classList.add('active');
          if (data.stats?.message) {
            document.getElementById('syncBannerText').textContent = data.stats.message;
          }
        } else {
          syncBanner.classList.remove('active');
        }
      }

      // Build ORIGINAL baseline snapshot for accurate diffs later
      baseline.clear();
      products.forEach(p => p.variants.forEach(v => {
        baseline.set(String(v.id), {
          sku: (v.sku ?? ''),
          price: (v.price === undefined || v.price === null) ? '' : String(v.price),
          weight: (v.weight === undefined || v.weight === null) ? '' : String(v.weight),
          harmonized_system_code: (v.harmonized_system_code ?? ''),
          country_code_of_origin: (v.country_code_of_origin ?? ''),
          pick_number: (v.pick_number ?? ''),
          warehouse_location: (v.warehouse_location ?? '')
        });
      }));

      // Load tags
      await loadTags();

      renderTable();
      updateStats();
      populateCategoryFilter();
      updateLabelButtons();
      initPickSuggestions();

      statusBar.className = 'status-bar active success';
      statusMessage.textContent = `Loaded ${products.length} products (${products.reduce((s, p) => s + p.variants.length, 0)} variants) from ${dataSource}`;
      setTimeout(() => { statusBar.className = 'status-bar'; }, 3000);
    } catch (error) {
      statusBar.className = 'status-bar active error';
      statusMessage.textContent = 'Failed to load products: ' + error.message;
    } finally {
      loading.classList.remove('active');
    }
  }

  function renderTable() {
    const tbody = document.getElementById('productTableBody');
    const thead = document.querySelector('#productTable thead tr');
    tbody.innerHTML = '';

    // Render table header based on column config
    renderTableHeader(thead);

    products.forEach(product => {
      product.variants.forEach(variant => {
        const row = tbody.insertRow();
        const variantId = String(variant.id);

        // Staged (unsaved) edits for this variant
        const staged = modifiedData.get(variantId) || {};
        const getVal = (field, fallback = '') =>
          (staged[field] !== undefined ? staged[field] : (variant[field] ?? fallback));

        const rawSku = getVal('sku', '') || '';
        const sku = String(rawSku).trim();
        const price = getVal('price', '') === '' ? '' : String(getVal('price'));
        const weight = getVal('weight', '') === '' ? '' : String(getVal('weight'));
        const hs = getVal('harmonized_system_code', '') || '';
        const country = getVal('country_code_of_origin', '') || '';
        const pickNumber = getVal('pick_number', '') || '';
        const warehouseLocation = getVal('warehouse_location', '') || '';
        const shipstationName = variant.shipstation_name || '';

        // Status flags
        const isDuplicateSku = !!sku && duplicateSkus.has(sku);
        const isMissingSku = !sku;
        const isDuplicatePick = !!pickNumber && duplicatePickNumbers.has(pickNumber);
        const isMissingPick = !pickNumber;
        const isMissingLocation = !warehouseLocation;

        // Render cells based on column config
        columnConfig.forEach(col => {
          if (!col.visible) return;

          const cell = row.insertCell();
          cell.dataset.colId = col.id;

          switch (col.id) {
            case 'select':
              cell.innerHTML = `<input type="checkbox" class="select-for-update" data-variant-id="${variantId}" onclick="handleCheckboxClick(event, this)">`;
              const cb = cell.querySelector('input');
              if (selectedIds.has(variantId)) cb.checked = true;
              break;

            case 'status':
              const badges = [];
              if (isMissingSku) badges.push('<span class="missing-indicator">NO SKU</span>');
              else if (isDuplicateSku) badges.push('<span class="duplicate-indicator">DUP SKU</span>');
              if (isDuplicatePick) badges.push('<span class="dup-pick-indicator">DUP PICK</span>');
              if (isMissingPick) badges.push('<span class="miss-pick-indicator">NO PICK</span>');
              if (isMissingLocation) badges.push('<span class="miss-loc-indicator">NO LOC</span>');
              if (badges.length > 1) {
                cell.innerHTML = `<div class="badge-stack">${badges.join('')}</div>`;
              } else if (badges.length === 1) {
                cell.innerHTML = badges[0];
              }
              break;

            case 'productTitle':
              cell.textContent = product.title;
              break;

            case 'variant':
              cell.textContent = variant.title || 'Default';
              break;

            case 'shipstationName':
              // Always construct display name from product + variant
              const variantPart = variant.title && variant.title !== 'Default' ? variant.title : '';
              const displayName = variantPart ? `${product.title} - ${variantPart}` : product.title;
              cell.textContent = displayName;
              cell.style.maxWidth = '250px';
              cell.style.overflow = 'hidden';
              cell.style.textOverflow = 'ellipsis';
              cell.style.whiteSpace = 'nowrap';
              cell.title = displayName;
              break;

            case 'sku':
              cell.className = (isDuplicateSku || isMissingSku) ? 'editable sku-error' : 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'sku')" data-variant-id="${variantId}" data-field="sku" class="editable-span">${sku}</span>`;
              if (staged.sku !== undefined) cell.classList.add('cell-modified');
              break;

            case 'pickNumber':
              cell.className = isDuplicatePick ? 'editable sku-error' : 'editable';
              if (isDuplicatePick || isMissingPick) {
                const suggestion = getNextAvailablePickNumber(variantId);
                cell.innerHTML = `
                  <span onclick="makeEditable(this, '${variantId}', 'pick_number')">${pickNumber}</span>
                  <button class="pick-suggest-btn" onclick="acceptPickSuggestion('${variantId}', '${suggestion}')" title="Use suggested pick #${suggestion}">→${suggestion}</button>
                `;
              } else {
                cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'pick_number')">${pickNumber}</span>`;
              }
              if (staged.pick_number !== undefined) cell.classList.add('cell-modified');
              break;

            case 'location':
              cell.className = 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'warehouse_location')">${warehouseLocation}</span>`;
              if (staged.warehouse_location !== undefined) cell.classList.add('cell-modified');
              break;

            case 'price':
              cell.className = 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'price')">${price !== '' ? '$' + price : ''}</span>`;
              if (staged.price !== undefined) cell.classList.add('cell-modified');
              break;

            case 'inventory':
              cell.textContent = variant.inventory_quantity || '0';
              break;

            case 'weight':
              cell.className = 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'weight')">${weight !== '' ? weight : ''}</span>`;
              if (staged.weight !== undefined) cell.classList.add('cell-modified');
              break;

            case 'hsCode':
              cell.className = 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'harmonized_system_code')">${hs}</span>`;
              if (staged.harmonized_system_code !== undefined) cell.classList.add('cell-modified');
              break;

            case 'country':
              cell.className = 'editable';
              cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', 'country_code_of_origin')">${country}</span>`;
              if (staged.country_code_of_origin !== undefined) cell.classList.add('cell-modified');
              break;

            case 'tags':
              const vTags = variantTags[variantId] || [];
              if (vTags.length > 0) {
                cell.innerHTML = vTags.map(t =>
                  `<span class="tag-badge" style="background:${t.color}" title="${t.name}">${t.name}</span>`
                ).join('');
              } else {
                cell.innerHTML = '<span class="no-tags">—</span>';
              }
              cell.style.cursor = 'pointer';
              cell.onclick = (e) => openTagEditor(variantId, e);
              break;
          }
        });

        // Row metadata for search/filter
        row.dataset.variantId = variantId;
        row.dataset.productTitle = product.title.toLowerCase();
        row.dataset.variantTitle = (variant.title || '').toLowerCase();
        row.dataset.sku = (sku || '').toLowerCase();
        row.dataset.pickNumber = (pickNumber || '').toLowerCase();
        row.dataset.warehouseLocation = (warehouseLocation || '').toLowerCase();
        row.dataset.productType = (product.product_type || '').toLowerCase();
        // Construct display name for ShipStation Name column (product + variant)
        const ssVariantPart = variant.title && variant.title !== 'Default' ? variant.title : '';
        const ssDisplayName = ssVariantPart ? `${product.title} - ${ssVariantPart}` : product.title;
        row.dataset.shipstationName = ssDisplayName.toLowerCase();
        row.dataset.isDuplicateSku = isDuplicateSku ? '1' : '0';
        row.dataset.isMissingSku = isMissingSku ? '1' : '0';
        row.dataset.isDuplicatePick = isDuplicatePick ? '1' : '0';
        row.dataset.isMissingPick = isMissingPick ? '1' : '0';
        row.dataset.isMissingLocation = isMissingLocation ? '1' : '0';
        // Tags for filtering
        const vTags = variantTags[variantId] || [];
        row.dataset.tagIds = vTags.map(t => t.id).join(',');
        row.dataset.tagNames = vTags.map(t => t.name.toLowerCase()).join(',');
      });
    });

    filterTable();
  }

  function renderTableHeader(thead) {
    thead.innerHTML = '';
    columnConfig.forEach(col => {
      if (!col.visible) return;
      const th = document.createElement('th');
      th.dataset.colId = col.id;
      th.draggable = !col.fixed;
      th.style.width = (col.width || 100) + 'px';
      th.style.minWidth = '40px';

      // Add sort indicator
      const sortable = !['select'].includes(col.id);
      if (sortable) {
        th.onclick = (e) => {
          if (!e.target.closest('.sort-icon') && !e.target.closest('.resize-handle')) {
            sortByColumn(col.id);
          }
        };
        const sortIcon = sortColumn === col.id ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
        th.innerHTML = `<span class="th-content">${col.label}<span class="sort-icon">${sortIcon}</span></span>`;
      } else {
        th.innerHTML = `<span class="th-content">${col.label}</span>`;
      }

      // Add resize handle
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'resize-handle';
      resizeHandle.addEventListener('mousedown', (e) => startResize(e, col.id, th));
      th.appendChild(resizeHandle);

      if (!col.fixed) {
        th.addEventListener('dragstart', handleDragStart);
        th.addEventListener('dragover', handleDragOver);
        th.addEventListener('drop', handleDrop);
        th.addEventListener('dragend', handleDragEnd);
      }
      thead.appendChild(th);
    });
  }

  // ===== Column Resizing =====================================================
  let resizingColumn = null;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  function startResize(e, colId, th) {
    e.preventDefault();
    e.stopPropagation();
    resizingColumn = colId;
    resizeStartX = e.pageX;
    resizeStartWidth = th.offsetWidth;

    const handle = e.target;
    handle.classList.add('active');

    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
  }

  function doResize(e) {
    if (!resizingColumn) return;

    const diff = e.pageX - resizeStartX;
    const newWidth = Math.max(40, resizeStartWidth + diff);

    // Update column config
    const col = columnConfig.find(c => c.id === resizingColumn);
    if (col) {
      col.width = newWidth;

      // Update the th width directly for smooth resizing
      const th = document.querySelector(`th[data-col-id="${resizingColumn}"]`);
      if (th) th.style.width = newWidth + 'px';

      // Update all cells in this column
      const colIndex = Array.from(document.querySelectorAll('#productTable thead th')).findIndex(
        h => h.dataset.colId === resizingColumn
      );
      if (colIndex >= 0) {
        document.querySelectorAll(`#productTableBody tr`).forEach(row => {
          const cell = row.cells[colIndex];
          if (cell) cell.style.width = newWidth + 'px';
        });
      }
    }
  }

  function stopResize() {
    if (resizingColumn) {
      document.querySelectorAll('.resize-handle.active').forEach(h => h.classList.remove('active'));
      saveColumnConfig();
    }
    resizingColumn = null;
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', stopResize);
  }

  function sortByColumn(colId) {
    if (sortColumn === colId) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = colId;
      sortDirection = 'asc';
    }

    // Sort the table rows
    const tbody = document.getElementById('productTableBody');
    const rows = Array.from(tbody.querySelectorAll('tr'));

    rows.sort((a, b) => {
      let aVal, bVal;

      // Get values based on column
      switch (colId) {
        case 'productTitle':
          aVal = a.dataset.productTitle || '';
          bVal = b.dataset.productTitle || '';
          break;
        case 'variant':
          aVal = a.dataset.variantTitle || '';
          bVal = b.dataset.variantTitle || '';
          break;
        case 'sku':
          aVal = a.dataset.sku || '';
          bVal = b.dataset.sku || '';
          break;
        case 'pickNumber':
          aVal = parseInt(a.dataset.pickNumber) || 999999;
          bVal = parseInt(b.dataset.pickNumber) || 999999;
          break;
        case 'location':
          aVal = a.dataset.warehouseLocation || '';
          bVal = b.dataset.warehouseLocation || '';
          break;
        case 'shipstationName':
          aVal = a.dataset.shipstationName || '';
          bVal = b.dataset.shipstationName || '';
          break;
        case 'status':
          // Sort by number of issues
          const aIssues = (a.dataset.isDuplicateSku === '1' ? 1 : 0) +
                          (a.dataset.isMissingSku === '1' ? 1 : 0) +
                          (a.dataset.isDuplicatePick === '1' ? 1 : 0) +
                          (a.dataset.isMissingPick === '1' ? 1 : 0) +
                          (a.dataset.isMissingLocation === '1' ? 1 : 0);
          const bIssues = (b.dataset.isDuplicateSku === '1' ? 1 : 0) +
                          (b.dataset.isMissingSku === '1' ? 1 : 0) +
                          (b.dataset.isDuplicatePick === '1' ? 1 : 0) +
                          (b.dataset.isMissingPick === '1' ? 1 : 0) +
                          (b.dataset.isMissingLocation === '1' ? 1 : 0);
          aVal = aIssues;
          bVal = bIssues;
          break;
        default:
          aVal = '';
          bVal = '';
      }

      // Compare
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return sortDirection === 'asc'
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });

    // Re-append rows in sorted order
    rows.forEach(row => tbody.appendChild(row));

    // Update header to show sort indicator
    renderTableHeader(document.querySelector('#productTable thead tr'));
  }

  // ===== Column Drag & Drop ==================================================
  let draggedColumn = null;

  function handleDragStart(e) {
    draggedColumn = e.target.dataset.colId;
    e.target.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const th = e.target.closest('th');
    if (th && th.dataset.colId !== draggedColumn) {
      th.style.borderLeft = '3px solid #667eea';
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    const th = e.target.closest('th');
    if (!th || !draggedColumn) return;

    const targetId = th.dataset.colId;
    if (targetId === draggedColumn) return;

    // Find indexes
    const fromIdx = columnConfig.findIndex(c => c.id === draggedColumn);
    const toIdx = columnConfig.findIndex(c => c.id === targetId);

    if (fromIdx === -1 || toIdx === -1) return;

    // Don't allow moving before fixed columns
    const targetCol = columnConfig[toIdx];
    if (targetCol.fixed) return;

    // Move column
    const [moved] = columnConfig.splice(fromIdx, 1);
    columnConfig.splice(toIdx, 0, moved);

    saveColumnConfig();
    renderTable();
    updateColumnSettingsPanel();
  }

  function handleDragEnd(e) {
    e.target.style.opacity = '1';
    document.querySelectorAll('#productTable th').forEach(th => {
      th.style.borderLeft = '';
    });
    draggedColumn = null;
  }

  // ===== Column Settings Panel ===============================================
  function openColumnSettings() {
    const panel = document.getElementById('columnSettingsPanel');
    updateColumnSettingsPanel();
    panel.classList.add('active');
  }

  function closeColumnSettings() {
    document.getElementById('columnSettingsPanel').classList.remove('active');
  }

  function updateColumnSettingsPanel() {
    const list = document.getElementById('columnList');
    list.innerHTML = '';

    columnConfig.forEach((col, idx) => {
      const item = document.createElement('div');
      item.className = 'column-item';
      item.dataset.colId = col.id;
      item.draggable = !col.fixed;

      item.innerHTML = `
        <span class="drag-handle">${col.fixed ? '' : '&#9776;'}</span>
        <label>
          <input type="checkbox" ${col.visible ? 'checked' : ''} ${col.fixed ? 'disabled' : ''}
            onchange="toggleColumn('${col.id}', this.checked)">
          ${col.label}
        </label>
      `;

      if (!col.fixed) {
        item.addEventListener('dragstart', handleSettingsDragStart);
        item.addEventListener('dragover', handleSettingsDragOver);
        item.addEventListener('drop', handleSettingsDrop);
        item.addEventListener('dragend', handleSettingsDragEnd);
      }

      list.appendChild(item);
    });
  }

  function handleSettingsDragStart(e) {
    draggedColumn = e.target.closest('.column-item').dataset.colId;
    e.target.style.opacity = '0.5';
  }

  function handleSettingsDragOver(e) {
    e.preventDefault();
    const item = e.target.closest('.column-item');
    if (item && item.dataset.colId !== draggedColumn) {
      item.style.borderTop = '2px solid #667eea';
    }
  }

  function handleSettingsDrop(e) {
    e.preventDefault();
    const item = e.target.closest('.column-item');
    if (!item || !draggedColumn) return;

    const targetId = item.dataset.colId;
    if (targetId === draggedColumn) return;

    const fromIdx = columnConfig.findIndex(c => c.id === draggedColumn);
    const toIdx = columnConfig.findIndex(c => c.id === targetId);

    if (fromIdx === -1 || toIdx === -1) return;
    if (columnConfig[toIdx].fixed) return;

    const [moved] = columnConfig.splice(fromIdx, 1);
    columnConfig.splice(toIdx, 0, moved);

    saveColumnConfig();
    renderTable();
    updateColumnSettingsPanel();
  }

  function handleSettingsDragEnd(e) {
    e.target.style.opacity = '1';
    document.querySelectorAll('.column-item').forEach(item => {
      item.style.borderTop = '';
    });
    draggedColumn = null;
  }

  function toggleColumn(colId, visible) {
    const col = columnConfig.find(c => c.id === colId);
    if (col && !col.fixed) {
      col.visible = visible;
      saveColumnConfig();
      renderTable();
    }
  }

  function resetColumns() {
    columnConfig = [...DEFAULT_COLUMNS];
    saveColumnConfig();
    renderTable();
    updateColumnSettingsPanel();
  }

  // ===== Table interactions =================================================
  function toggleSelect(el) {
    const id = String(el.dataset.variantId);
    if (el.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateLabelButtons();
  }

  function handleCheckboxClick(event, el) {
    const allCheckboxes = Array.from(document.querySelectorAll('#productTableBody input[type="checkbox"]'));
    const currentIndex = allCheckboxes.indexOf(el);

    // Shift+click for range selection
    if (event.shiftKey && lastCheckedIndex !== null && lastCheckedIndex !== currentIndex) {
      const start = Math.min(lastCheckedIndex, currentIndex);
      const end = Math.max(lastCheckedIndex, currentIndex);
      const shouldCheck = el.checked;

      for (let i = start; i <= end; i++) {
        const cb = allCheckboxes[i];
        // Only select visible rows
        const row = cb.closest('tr');
        if (row && row.style.display !== 'none') {
          cb.checked = shouldCheck;
          const id = String(cb.dataset.variantId);
          if (shouldCheck) selectedIds.add(id);
          else selectedIds.delete(id);
        }
      }
    } else {
      // Normal click
      const id = String(el.dataset.variantId);
      if (el.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    }

    lastCheckedIndex = currentIndex;
    updateLabelButtons();
  }

  function makeEditable(span, variantId, field) {
    let raw = span.textContent.trim();
    if (field === 'price') raw = raw.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');

    const input = document.createElement('input');
    input.type = (field === 'price' || field === 'weight') ? 'number' : 'text';
    if (field === 'price') input.step = '0.01';
    if (field === 'weight') input.step = '1';

    if (field === 'price' || field === 'weight') {
      const n = raw === '' ? '' : Number(raw);
      input.value = Number.isFinite(n) ? String(n) : '';
    } else {
      input.value = raw;
    }

    input.onblur = () => saveEdit(input, span, String(variantId), field);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };

    const cell = span.parentElement;
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();
  }

  function patchLocalVariant(variantId, field, value) {
    const vid = String(variantId);
    for (const p of products) {
      for (const v of p.variants) {
        if (String(v.id) === vid) {
          if (field === 'price') v.price = (value === '' ? '' : Number(value));
          else if (field === 'weight') v.weight = (value === '' ? '' : Number(value));
          else v[field] = value;
          return;
        }
      }
    }
  }

  function saveEdit(input, originalSpan, variantId, field) {
    let newValue = input.value;

    if (field === 'price' || field === 'weight') {
      newValue = newValue === '' ? '' : String(Number(newValue));
      if (newValue !== '' && !Number.isFinite(Number(newValue))) {
        const cell = input.parentElement;
        const prev = originalSpan.textContent;
        cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', '${field}')">${prev}</span>`;
        return;
      }
    } else if (field === 'sku') {
      newValue = newValue.trim();
    }

    const key = String(variantId);
    if (!modifiedData.has(key)) modifiedData.set(key, {});
    modifiedData.get(key)[field] = newValue;

    patchLocalVariant(key, field, newValue);

    const cell = input.parentElement;
    let display = newValue;
    if (field === 'price' && newValue !== '') display = '$' + newValue;
    cell.innerHTML = `<span onclick="makeEditable(this, '${variantId}', '${field}')">${display}</span>`;
    cell.classList.add('cell-modified');

    // Recompute duplicates if SKU or pick number changed
    if (field === 'sku' || field === 'pick_number') {
      recomputeDuplicates();
      renderTable();
    }

    updateStats();
  }

  function recomputeDuplicates() {
    // SKU duplicates
    const skuCounts = {};
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const norm = String(s || '').trim();
      if (norm) skuCounts[norm] = (skuCounts[norm] || 0) + 1;
    }));
    duplicateSkus.clear();
    Object.entries(skuCounts).forEach(([s, c]) => { if (c > 1) duplicateSkus.add(s); });

    // Pick number duplicates
    const pickCounts = {};
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const pn = (modifiedData.has(vid) && modifiedData.get(vid).pick_number !== undefined)
        ? (modifiedData.get(vid).pick_number || '')
        : (v.pick_number || '');
      const norm = String(pn || '').trim();
      if (norm) pickCounts[norm] = (pickCounts[norm] || 0) + 1;
    }));
    duplicatePickNumbers.clear();
    Object.entries(pickCounts).forEach(([pn, c]) => { if (c > 1) duplicatePickNumbers.add(pn); });
  }

  function updateStats() {
    const uniqueSkusSet = new Set();
    const skuCounts = {};
    const pickCounts = {};
    let missingSku = 0;
    let missingPick = 0;
    let missingLocation = 0;

    products.forEach(product => {
      product.variants.forEach(variant => {
        const vid = String(variant.id);

        // SKU
        let sku = variant.sku;
        if (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined) {
          sku = modifiedData.get(vid).sku;
        }
        const normSku = String(sku || '').trim();
        if (!normSku) {
          missingSku++;
        } else {
          uniqueSkusSet.add(normSku);
          skuCounts[normSku] = (skuCounts[normSku] || 0) + 1;
        }

        // Pick number
        let pickNum = variant.pick_number;
        if (modifiedData.has(vid) && modifiedData.get(vid).pick_number !== undefined) {
          pickNum = modifiedData.get(vid).pick_number;
        }
        const normPick = String(pickNum || '').trim();
        if (!normPick) {
          missingPick++;
        } else {
          pickCounts[normPick] = (pickCounts[normPick] || 0) + 1;
        }

        // Warehouse location
        let loc = variant.warehouse_location;
        if (modifiedData.has(vid) && modifiedData.get(vid).warehouse_location !== undefined) {
          loc = modifiedData.get(vid).warehouse_location;
        }
        if (!String(loc || '').trim()) {
          missingLocation++;
        }
      });
    });

    const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
    const duplicateSkuCount = Object.values(skuCounts).filter(count => count > 1).length;
    const duplicatePickCount = Object.values(pickCounts).filter(count => count > 1).length;

    document.getElementById('totalProducts').textContent = totalVariants;
    document.getElementById('uniqueSkus').textContent = uniqueSkusSet.size;
    document.getElementById('duplicateSkus').textContent = duplicateSkuCount;
    document.getElementById('missingSkus').textContent = missingSku;
    document.getElementById('duplicatePicks').textContent = duplicatePickCount;
    document.getElementById('missingPicks').textContent = missingPick;
    document.getElementById('missingLocations').textContent = missingLocation;
    document.getElementById('modifiedCount').textContent = modifiedData.size;
  }

  function filterTable() {
    const searchValue = document.getElementById('searchInput').value.toLowerCase();
    const categoryValue = document.getElementById('categoryFilter')?.value.toLowerCase() || '';
    const excludeValue = document.getElementById('excludeInput')?.value.toLowerCase() || '';
    const excludeKeywords = excludeValue.split(',').map(k => k.trim()).filter(k => k.length > 0);

    const showDuplicates = document.getElementById('showDuplicatesOnly').checked;
    const showMissing = document.getElementById('showMissingOnly').checked;
    const showDupPicks = document.getElementById('showDupPicksOnly').checked;
    const showMissingPicks = document.getElementById('showMissingPicksOnly').checked;
    const showMissingLocs = document.getElementById('showMissingLocsOnly').checked;
    const showModified = document.getElementById('showModifiedOnly').checked;

    const rows = document.querySelectorAll('#productTableBody tr');

    rows.forEach(row => {
      const variantId = row.dataset.variantId;
      const isDuplicateSku = row.dataset.isDuplicateSku === '1';
      const isMissingSku = row.dataset.isMissingSku === '1';
      const isDuplicatePick = row.dataset.isDuplicatePick === '1';
      const isMissingPick = row.dataset.isMissingPick === '1';
      const isMissingLocation = row.dataset.isMissingLocation === '1';
      const isModified = modifiedData.has(variantId);

      let showRow = true;

      // Category filter
      if (showRow && categoryValue) {
        showRow = row.dataset.productType === categoryValue;
      }

      // Search filter
      if (showRow && searchValue) {
        const searchableText = row.dataset.productTitle + ' ' +
                               row.dataset.variantTitle + ' ' +
                               row.dataset.sku + ' ' +
                               row.dataset.pickNumber + ' ' +
                               row.dataset.warehouseLocation + ' ' +
                               (row.dataset.shipstationName || '');
        showRow = searchableText.includes(searchValue);
      }

      // Exclusion filter
      if (showRow && excludeKeywords.length > 0) {
        const searchableText = row.dataset.productTitle + ' ' +
                               row.dataset.variantTitle + ' ' +
                               row.dataset.sku + ' ' +
                               row.dataset.pickNumber + ' ' +
                               row.dataset.warehouseLocation + ' ' +
                               (row.dataset.shipstationName || '');
        const matchesExclude = excludeKeywords.some(keyword => searchableText.includes(keyword));
        if (matchesExclude) showRow = false;
      }

      // Tag filter
      if (showRow && activeTagFilter) {
        if (activeTagFilter === '__none__') {
          // Show only variants with no tags
          showRow = !row.dataset.tagIds || row.dataset.tagIds === '';
        } else {
          // Show only variants with the selected tag
          const tagIds = (row.dataset.tagIds || '').split(',');
          showRow = tagIds.includes(String(activeTagFilter));
        }
      }

      // Filter logic (mutually exclusive)
      if (showRow && showDuplicates) showRow = isDuplicateSku;
      if (showRow && showMissing) showRow = isMissingSku;
      if (showRow && showDupPicks) showRow = isDuplicatePick;
      if (showRow && showMissingPicks) showRow = isMissingPick;
      if (showRow && showMissingLocs) showRow = isMissingLocation;
      if (showRow && showModified) showRow = isModified;

      row.style.display = showRow ? '' : 'none';
    });
  }

  function getVisibleVariantIds() {
    const rows = Array.from(document.querySelectorAll('#productTableBody tr'));
    const ids = [];
    rows.forEach(row => {
      const display = window.getComputedStyle(row).display;
      if (display !== 'none') ids.push(String(row.dataset.variantId));
    });
    return ids;
  }

  // ===== Save logic (accurate diffs) ========================================
  function buildDiffPayload(variantId) {
    const id = String(variantId);
    const staged = modifiedData.get(id);
    if (!staged || Object.keys(staged).length === 0) return null;

    const orig = baseline.get(id) || {};
    const diff = {};
    for (const [k, val] of Object.entries(staged)) {
      const normNew = (k === 'price' || k === 'weight') ? String(val ?? '') : String(val ?? '').trim();
      const normOrig = (k === 'price' || k === 'weight') ? String(orig[k] ?? '') : String((orig[k] ?? '')).trim();
      if (normNew !== normOrig) diff[k] = val;
    }
    if (Object.keys(diff).length === 0) return null;
    return { id, ...diff };
  }

  async function saveChanges() {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    const saveBtn = document.getElementById('saveBtn');
    const selected = Array.from(selectedIds);
    const showModified = document.getElementById('showModifiedOnly').checked;

    let idsToConsider;
    if (selected.length > 0) {
      idsToConsider = selected;
    } else if (showModified) {
      idsToConsider = getVisibleVariantIds();
    } else {
      idsToConsider = Array.from(modifiedData.keys());
    }

    const updates = [];
    idsToConsider.forEach(id => {
      const payload = buildDiffPayload(id);
      if (payload) updates.push(payload);
    });

    if (updates.length === 0) {
      showStatus('Nothing to save for this view.', 'warning');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const response = await fetch('/api/products/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      const result = await response.json();

      if (!response.ok) {
        // Check for validation errors
        if (result.conflicts) {
          const conflictMsg = result.conflicts.map(c => c.message).join('\n');
          showStatus(`Save failed: ${conflictMsg}`, 'error');
          return;
        }
        throw new Error(result.error || result.message);
      }

      let msg = `Updated ${result.updated} variants`;
      if (result.failed > 0) msg += `, ${result.failed} failed`;
      if (result.warnings?.length > 0) msg += ` (${result.warnings.length} warnings)`;
      if (result.shipstationPending > 0) msg += ` | ${result.shipstationPending} pending ShipStation sync`;

      showStatus(msg, result.failed > 0 ? 'warning' : 'success');

      updates.forEach(u => {
        modifiedData.delete(String(u.id));
        selectedIds.delete(String(u.id));
      });

      setTimeout(() => refreshProducts(), 800);
    } catch (error) {
      showStatus('Failed to save: ' + error.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  }

  // ===== Sync operations ====================================================
  async function syncFromShopify() {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');

    loading.classList.add('active');
    loadingText.textContent = 'Syncing products from Shopify (this may take a minute)...';

    try {
      const response = await fetch('/api/products/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' })
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error);

      showStatus(
        `Synced ${result.products_synced} products, ${result.variants_synced} variants in ${result.duration_seconds}s`,
        'success'
      );

      // Refresh the table
      await refreshProducts();
    } catch (error) {
      showStatus('Sync failed: ' + error.message, 'error');
    } finally {
      loading.classList.remove('active');
    }
  }

  async function syncToShipStation() {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');

    // If variants are selected, only sync those; otherwise sync all
    const selected = Array.from(selectedIds);
    const syncingSelected = selected.length > 0;

    loading.classList.add('active');
    loadingText.textContent = syncingSelected
      ? `Syncing ${selected.length} selected items to ShipStation...`
      : 'Syncing all to ShipStation (locations + pick numbers)...';

    try {
      const body = syncingSelected
        ? { variantIds: selected }
        : { mode: 'full' };

      const response = await fetch('/api/products/sync-shipstation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error);

      let msg = `ShipStation sync: ${result.updated} updated`;
      if (result.skipped > 0) msg += `, ${result.skipped} skipped (not in catalog)`;
      if (result.failed > 0) msg += `, ${result.failed} failed`;

      showStatus(msg, result.failed > 0 ? 'warning' : 'success');
    } catch (error) {
      showStatus('ShipStation sync failed: ' + error.message, 'error');
    } finally {
      loading.classList.remove('active');
    }
  }

  async function importShipStationNames() {
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');

    loading.classList.add('active');
    loadingText.textContent = 'Importing product names from ShipStation...';

    try {
      const response = await fetch('/api/products/import-shipstation-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error);

      showStatus(`Imported ShipStation names: ${result.updated} updated (${result.total} total products)`, 'success');

      // Refresh products to show new names
      await refreshProducts();
    } catch (error) {
      showStatus('Import failed: ' + error.message, 'error');
    } finally {
      loading.classList.remove('active');
    }
  }

  // ===== Status & errors =====================================================
  function showStatus(message, type) {
    const statusBar = document.getElementById('statusBar');
    const statusMessage = document.getElementById('statusMessage');
    statusBar.className = `status-bar active ${type}`;
    statusMessage.textContent = message;
    setTimeout(() => { statusBar.className = 'status-bar'; }, 5000);
  }

  function showErrors() {
    document.getElementById('errorPanel').classList.add('open');
  }
  function closeErrors() {
    document.getElementById('errorPanel').classList.remove('open');
  }

  // ===== Generators ==========================================================
  function generateSkusForDuplicates() {
    if (!window.SKUGenerator || !window.SKU_RULES) {
      showStatus('SKU generator not loaded', 'error');
      return;
    }
    const stagedSku = (v) => {
      const vid = String(v.id);
      return (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
    };

    const groups = new Map();
    products.forEach(p => p.variants.forEach(v => {
      const s = String(stagedSku(v) || '').trim().toUpperCase();
      if (!s) return;
      groups.set(s, (groups.get(s) || []).concat({ p, v }));
    }));

    const dupGroups = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);
    if (dupGroups.length === 0) {
      showStatus('No duplicates found to generate.', 'warning');
      return;
    }

    const used = new Set();
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const norm = String(s || '').trim();
      if (norm) used.add(norm.toUpperCase());
    }));

    const gen = new window.SKUGenerator(window.SKU_RULES, { maxLength: 20, imperfectCode: 'IM' });
    let changed = 0;

    for (const [skuKey, arr] of dupGroups) {
      arr.sort((a, b) => String(a.v.id).localeCompare(String(b.v.id)));
      used.add(skuKey.toUpperCase());

      for (let i = 1; i < arr.length; i++) {
        const { p, v } = arr[i];
        const options = [v.option1, v.option2, v.option3].filter(Boolean);

        const suggestion = gen.generate(
          p.title,
          v.title || '',
          cand => used.has(String(cand).toUpperCase()),
          options
        );
        if (!suggestion) continue;

        const vid = String(v.id);
        if (!modifiedData.has(vid)) modifiedData.set(vid, {});
        modifiedData.get(vid).sku = suggestion;
        patchLocalVariant(vid, 'sku', suggestion);

        used.add(String(suggestion).toUpperCase());
        changed++;
      }
    }

    recomputeDuplicates();
    renderTable();
    updateStats();
    filterTable();
    showStatus(
      changed ? `Generated ${changed} SKUs to resolve duplicates` : 'No new SKUs were generated',
      changed ? 'success' : 'warning'
    );
  }

  function generateSkusForMissing() {
    if (!window.SKUGenerator || !window.SKU_RULES) {
      showStatus('SKU generator not loaded', 'error');
      return;
    }

    const used = new Set();
    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      let s = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      s = String(s || '').trim();
      if (s) used.add(s.toUpperCase());
    }));

    const gen = new window.SKUGenerator(window.SKU_RULES, { maxLength: 20, imperfectCode: 'IM' });
    let changed = 0;

    products.forEach(p => p.variants.forEach(v => {
      const vid = String(v.id);
      const staged = (modifiedData.has(vid) && modifiedData.get(vid).sku !== undefined)
        ? (modifiedData.get(vid).sku || '')
        : (v.sku || '');
      const current = String(staged || '').trim();

      if (current) return;

      const options = [v.option1, v.option2, v.option3].filter(Boolean);

      const suggestion = gen.generate(
        p.title,
        v.title || '',
        cand => used.has(String(cand).toUpperCase()),
        options
      );
      if (!suggestion) return;

      if (!modifiedData.has(vid)) modifiedData.set(vid, {});
      modifiedData.get(vid).sku = suggestion;
      patchLocalVariant(vid, 'sku', suggestion);

      used.add(String(suggestion).toUpperCase());
      changed++;
    }));

    recomputeDuplicates();
    renderTable();
    updateStats();
    filterTable();
    showStatus(
      changed ? `Generated ${changed} SKUs for missing variants` : 'No missing SKUs found to generate',
      changed ? 'success' : 'warning'
    );
  }

  // ===== ShipStation CSV export (with HS map) ===============================
  function exportShipStationCSV() {
    const headers = [
      'SKU','Name','WarehouseLocation','WeightOz','Category','Tag1','Tag2','Tag3','Tag4','Tag5',
      'CustomsDescription','CustomsValue','CustomsTariffNo','CustomsCountry','ThumbnailUrl','UPC',
      'FillSKU','Length','Width','Height','UseProductName','Active','ParentSKU','IsReturnable'
    ];

    const selected = Array.from(selectedIds);
    const visibleSet = new Set(getVisibleVariantIds());
    const shouldInclude = (vid) => selected.length > 0 ? selected.includes(vid) : visibleSet.has(vid);

    const toOz = (grams) => {
      const n = Number(grams);
      if (!Number.isFinite(n)) return '';
      return Math.round(n * 0.03527396195 * 100) / 100;
    };

    const rows = [];
    products.forEach(p => p.variants.forEach(v => {
      const id = String(v.id);
      if (!shouldInclude(id)) return;

      const staged = modifiedData.get(id) || {};
      const sku = (staged.sku !== undefined ? staged.sku : v.sku) || '';
      if (!sku.trim()) return;

      const price = staged.price !== undefined ? staged.price : v.price;
      const weight = staged.weight !== undefined ? staged.weight : v.weight;
      const hs = staged.harmonized_system_code !== undefined ? staged.harmonized_system_code : v.harmonized_system_code;
      let origin = staged.country_code_of_origin !== undefined ? staged.country_code_of_origin : v.country_code_of_origin;
      const warehouseLoc = staged.warehouse_location !== undefined ? staged.warehouse_location : v.warehouse_location;

      const name = (v.title && v.title !== 'Default') ? `${p.title} - ${v.title}` : p.title;

      const tagsArr = (p.tags || '').split(',').map(s => s.trim()).filter(Boolean);
      const [tag1, tag2, tag3, tag4, tag5] = [tagsArr[0]||'', tagsArr[1]||'', tagsArr[2]||'', tagsArr[3]||'', tagsArr[4]||''];

      let thumb = '';
      if (v.image_id && Array.isArray(p.images)) {
        const hit = p.images.find(img => String(img.id) === String(v.image_id));
        thumb = hit?.src || '';
      } else {
        thumb = p.image?.src || '';
      }

      const upc = v.barcode || '';

      let customsDesc = name;
      if (hs) {
        const key1 = String(hs).trim();
        const key2 = normalizeHs(hs);
        const dotted = addDotsToHs(key2);
        const hit = HS_MAP.get(key1) || HS_MAP.get(key2) || (dotted ? HS_MAP.get(dotted) : undefined);
        if (hit?.desc) customsDesc = hit.desc;
        if (!origin && hit?.country) origin = hit.country;
      }

      const rec = {
        SKU: sku,
        Name: name,
        WarehouseLocation: warehouseLoc || '',
        WeightOz: toOz(weight),
        Category: p.product_type || '',
        Tag1: tag1, Tag2: tag2, Tag3: tag3, Tag4: tag4, Tag5: tag5,
        CustomsDescription: customsDesc,
        CustomsValue: (price === '' || price === undefined || price === null) ? '' : String(price),
        CustomsTariffNo: hs || '',
        CustomsCountry: origin ? String(origin).toUpperCase() : '',
        ThumbnailUrl: thumb,
        UPC: upc,
        FillSKU: '',
        Length: '', Width: '', Height: '',
        UseProductName: '',
        Active: 'True',
        ParentSKU: '',
        IsReturnable: 'True'
      };

      rows.push(rec);
    }));

    const esc = (val) => {
      let s = (val === null || val === undefined) ? '' : String(val);
      if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => esc(r[h])).join(','))
    ].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0,10);
    a.download = `shipstation_products_${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const mode = selected.length > 0 ? 'selected rows' : 'visible rows';
    showStatus(`Exported ${rows.length} rows to ShipStation CSV (${mode})`, 'success');
  }

  // ===== HS map loader (CSV) ================================================
  function promptLoadHsMap() {
    const inp = document.getElementById('hsMapFile');
    if (!inp) return showStatus('HS map input not found', 'error');
    inp.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        loadHsMapFromCSV(text);
        localStorage.setItem('HS_MAP_CSV_RAW', text);
        showStatus(`HS map loaded: ${HS_MAP.size} codes`, 'success');
      } catch (err) {
        showStatus('Failed to load HS map: ' + err.message, 'error');
      } finally {
        e.target.value = '';
      }
    };
    inp.click();
  }

  function loadHsMapFromCSV(csvText) {
    HS_MAP.clear();
    const rows = parseCSV(csvText);
    if (!rows || rows.length === 0) return;

    const hdr = rows[0].map(h => String(h).trim().toLowerCase());
    const idxDesc = hdr.findIndex(h => h.includes('description'));
    const idxHS = hdr.findIndex(h => h.includes('hs') && h.includes('code'));
    const idxCtr = hdr.findIndex(h => h.includes('country') && h.includes('origin'));

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const hs = normalizeHs(r[idxHS] || '');
      if (!hs) continue;
      const desc = String(r[idxDesc] || '').trim();
      const country = String(r[idxCtr] || '').trim();
      HS_MAP.set(hs, { desc, country });
      const dotted = addDotsToHs(hs);
      if (dotted) HS_MAP.set(dotted, { desc, country });
    }
  }

  function normalizeHs(val) {
    return String(val || '').replace(/[^0-9]/g, '');
  }
  function addDotsToHs(digits) {
    const s = String(digits || '').replace(/[^0-9]/g, '');
    if (s.length === 10) return `${s.slice(0,4)}.${s.slice(4,6)}.${s.slice(6)}`;
    return '';
  }

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const rows = [];
    for (const line of lines) {
      if (line.trim() === '') { rows.push(['']); continue; }
      const cells = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQ = false; }
          else { cur += ch; }
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ',') { cells.push(cur); cur = ''; }
          else { cur += ch; }
        }
      }
      cells.push(cur);
      rows.push(cells);
    }
    while (rows.length && rows[rows.length-1].every(c => String(c).trim() === '')) rows.pop();
    return rows;
  }

  // ===== Category Filter =====================================================
  function populateCategoryFilter() {
    const categoryFilter = document.getElementById('categoryFilter');
    if (!categoryFilter) return;

    // Extract unique categories from products
    const categories = [...new Set(products.map(p => p.product_type).filter(c => c))].sort();

    // Clear existing options except "All Categories"
    categoryFilter.innerHTML = '<option value="">All Categories</option>';

    // Add category options
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat.toLowerCase();
      option.textContent = cat;
      categoryFilter.appendChild(option);
    });
  }

  // ===== Label Selection & Generation ========================================
  function updateLabelButtons() {
    const hasSelection = selectedIds.size > 0;
    document.querySelectorAll('[id^="labelBtn"]').forEach(btn => {
      btn.disabled = !hasSelection;
    });
    const genPickBtn = document.getElementById('genPickBtn');
    if (genPickBtn) genPickBtn.disabled = !hasSelection;
    document.getElementById('selectedCount').textContent = `${selectedIds.size} selected`;

    // Update tag selection count in tag manager
    const tagSelectionCount = document.getElementById('tagSelectionCount');
    if (tagSelectionCount) tagSelectionCount.textContent = selectedIds.size;
  }

  function selectAllVisible() {
    const rows = document.querySelectorAll('#productTableBody tr');
    rows.forEach(row => {
      if (row.style.display !== 'none') {
        const variantId = row.dataset.variantId;
        selectedIds.add(variantId);
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = true;
      }
    });
    updateLabelButtons();
  }

  function clearSelection() {
    selectedIds.clear();
    lastCheckedIndex = null;
    document.querySelectorAll('#productTableBody input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
    updateLabelButtons();
  }

  function getSelectedVariantsWithPick() {
    // Get all variants that are selected AND have a pick number
    const result = [];
    products.forEach(p => {
      p.variants.forEach(v => {
        const vid = String(v.id);
        if (!selectedIds.has(vid)) return;

        const staged = modifiedData.get(vid) || {};
        const pickNumber = staged.pick_number !== undefined ? staged.pick_number : v.pick_number;
        if (!pickNumber) return; // Skip variants without pick number

        result.push({
          pick: pickNumber,
          sku: staged.sku !== undefined ? staged.sku : v.sku || '',
          name: (v.title && v.title !== 'Default') ? `${p.title} - ${v.title}` : p.title,
          category: p.product_type || 'Uncategorized',
          productId: p.id,
          variantId: v.id,
          warehouseLocation: staged.warehouse_location !== undefined ? staged.warehouse_location : v.warehouse_location || ''
        });
      });
    });

    // Sort by pick number
    result.sort((a, b) => {
      const numA = parseInt(a.pick) || 0;
      const numB = parseInt(b.pick) || 0;
      return numA - numB;
    });

    return result;
  }

  function showLabelPreview(labelType) {
    currentLabelType = labelType;
    const selected = getSelectedVariantsWithPick();

    if (selected.length === 0) {
      showStatus('No selected variants have pick numbers. Labels require pick numbers.', 'warning');
      return;
    }

    const preview = document.getElementById('labelPreview');
    const sample = document.getElementById('labelSample');
    const info = document.getElementById('previewInfo');

    // Show first selected product as sample
    const first = selected[0];
    sample.innerHTML = `
      <div class="pick">${first.pick}</div>
      <div class="sku">${first.sku}</div>
      <div class="name">${first.name}</div>
    `;

    const typeNames = {
      'detailed': 'Detailed Labels (8 per page)',
      'largeqr': 'Large Labels + QR (3 per page)',
      'qr': 'QR Labels (6 per page)',
      'qrinv': 'QR Inventory Labels (6 per page)'
    };

    info.textContent = `Ready to generate ${typeNames[labelType]} for ${selected.length} variants with pick numbers.`;

    preview.classList.add('active');
  }

  function closeLabelPreview() {
    document.getElementById('labelPreview').classList.remove('active');
    currentLabelType = null;
  }

  // ===== Pick Number Suggestions =============================================
  // Smart suggestion system that groups by product type and SKU prefix

  // Maps to store pick numbers grouped by category
  let picksByProductType = {};  // { productType: [pickNumbers] }
  let picksBySkuPrefix = {};    // { skuPrefix: [pickNumbers] }
  let globalMaxPick = 0;

  function initPickSuggestions() {
    // Build set of all used pick numbers (including staged edits)
    usedPickNumbers.clear();
    picksByProductType = {};
    picksBySkuPrefix = {};
    globalMaxPick = 0;

    products.forEach(p => {
      const productType = (p.product_type || 'Unknown').toLowerCase();

      p.variants.forEach(v => {
        const vid = String(v.id);
        const staged = modifiedData.get(vid) || {};
        const pick = staged.pick_number !== undefined ? staged.pick_number : v.pick_number;
        const sku = staged.sku !== undefined ? staged.sku : v.sku || '';

        if (pick && String(pick).trim()) {
          const pickNum = parseInt(pick);
          if (!isNaN(pickNum)) {
            usedPickNumbers.add(String(pickNum));

            // Track max
            if (pickNum > globalMaxPick) globalMaxPick = pickNum;

            // Group by product type
            if (!picksByProductType[productType]) picksByProductType[productType] = [];
            picksByProductType[productType].push(pickNum);

            // Group by SKU prefix (first segment before dash)
            const skuPrefix = sku.split('-')[0].toUpperCase();
            if (skuPrefix) {
              if (!picksBySkuPrefix[skuPrefix]) picksBySkuPrefix[skuPrefix] = [];
              picksBySkuPrefix[skuPrefix].push(pickNum);
            }
          }
        }
      });
    });

    // Sort all pick number arrays
    for (const key of Object.keys(picksByProductType)) {
      picksByProductType[key].sort((a, b) => a - b);
    }
    for (const key of Object.keys(picksBySkuPrefix)) {
      picksBySkuPrefix[key].sort((a, b) => a - b);
    }

    pickSuggestionCounter = globalMaxPick + 1;
  }

  function getNextAvailablePickNumber(variantId) {
    // Initialize if needed
    if (pickSuggestionCounter === null) {
      initPickSuggestions();
    }

    // Find the variant's product and SKU
    let productType = 'unknown';
    let productTitle = '';
    let skuPrefix = '';
    let sku = '';

    for (const p of products) {
      for (const v of p.variants) {
        if (String(v.id) === String(variantId)) {
          productType = (p.product_type || 'Unknown').toLowerCase();
          productTitle = p.title || '';
          const staged = modifiedData.get(String(v.id)) || {};
          sku = staged.sku !== undefined ? staged.sku : v.sku || '';
          skuPrefix = sku.split('-')[0].toUpperCase();
          break;
        }
      }
    }

    // Detect year and imperfect status from SKU and title
    const skuUpper = sku.toUpperCase();
    const titleLower = productTitle.toLowerCase();

    const is2026 = skuUpper.includes('2026') || skuUpper.startsWith('26-') || skuUpper.startsWith('26Q');
    const is2025 = skuUpper.includes('2025') || skuUpper.startsWith('25-') || skuUpper.startsWith('25Q');
    const isImperfect = skuUpper.includes('-IM') || skuUpper.endsWith('IM') || titleLower.includes('imperfect');

    // Determine target range based on year and imperfect status
    let targetRange = null;

    if (is2026 || isImperfect) {
      // 2026 products and imperfects go in the 9000s
      targetRange = { min: 9000, max: 9999 };
    } else if (is2025) {
      // 2025 products typically in 1000-2000
      targetRange = { min: 1000, max: 1999 };
    }

    // Try to find a suggestion in the same neighborhood
    let suggestion = null;

    // Strategy 1: If we have a target range, search within it first
    if (targetRange) {
      suggestion = findInRange(targetRange.min, targetRange.max);
    }

    // Strategy 2: Look for picks with the same SKU prefix
    if (suggestion === null && skuPrefix && picksBySkuPrefix[skuPrefix] && picksBySkuPrefix[skuPrefix].length > 0) {
      suggestion = findSmartSuggestion(picksBySkuPrefix[skuPrefix]);
    }

    // Strategy 3: Fall back to product type
    if (suggestion === null && picksByProductType[productType] && picksByProductType[productType].length > 0) {
      suggestion = findSmartSuggestion(picksByProductType[productType]);
    }

    // Strategy 4: Global fallback
    if (suggestion === null) {
      while (usedPickNumbers.has(String(pickSuggestionCounter))) {
        pickSuggestionCounter++;
      }
      suggestion = pickSuggestionCounter;
    }

    // Reserve this number
    usedPickNumbers.add(String(suggestion));

    return suggestion;
  }

  function findInRange(min, max) {
    // Find first available number in the range
    for (let candidate = min; candidate <= max; candidate++) {
      if (!usedPickNumbers.has(String(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  function findSmartSuggestion(existingPicks) {
    if (!existingPicks || existingPicks.length === 0) return null;

    // Find the range (min, max) for this group
    const minPick = Math.min(...existingPicks);
    const maxPick = Math.max(...existingPicks);

    // Strategy A: Look for a gap within the existing range
    // Check for gaps of reasonable size (not too big)
    const sorted = [...existingPicks].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1] - sorted[i];
      if (gap > 1 && gap <= 10) {
        // There's a small gap - find an available number in it
        for (let candidate = sorted[i] + 1; candidate < sorted[i + 1]; candidate++) {
          if (!usedPickNumbers.has(String(candidate))) {
            return candidate;
          }
        }
      }
    }

    // Strategy B: Extend from the max of this group
    let candidate = maxPick + 1;
    let attempts = 0;
    while (usedPickNumbers.has(String(candidate)) && attempts < 100) {
      candidate++;
      attempts++;
    }

    if (!usedPickNumbers.has(String(candidate))) {
      return candidate;
    }

    // Strategy C: Try extending from before the min (for filling in earlier ranges)
    if (minPick > 1) {
      candidate = minPick - 1;
      attempts = 0;
      while (candidate > 0 && usedPickNumbers.has(String(candidate)) && attempts < 50) {
        candidate--;
        attempts++;
      }
      if (candidate > 0 && !usedPickNumbers.has(String(candidate))) {
        return candidate;
      }
    }

    return null;
  }

  function acceptPickSuggestion(variantId, suggestion) {
    // Update the modified data
    const vid = String(variantId);
    if (!modifiedData.has(vid)) modifiedData.set(vid, {});
    modifiedData.get(vid).pick_number = String(suggestion);

    // Update the local variant data
    for (const p of products) {
      for (const v of p.variants) {
        if (String(v.id) === vid) {
          v.pick_number = String(suggestion);
          break;
        }
      }
    }

    // Re-render to show the change
    renderTable();
    updateStats();
    showStatus(`Set pick #${suggestion} for variant. Remember to save changes.`, 'success');
  }

  // ===== Generate Pick Numbers ===============================================
  async function generatePickNumbers() {
    if (selectedIds.size === 0) {
      showStatus('No variants selected', 'warning');
      return;
    }

    // Get selected variants that DON'T have pick numbers
    const variantsNeedingPick = [];
    products.forEach(p => {
      p.variants.forEach(v => {
        const vid = String(v.id);
        if (!selectedIds.has(vid)) return;

        const staged = modifiedData.get(vid) || {};
        const pickNumber = staged.pick_number !== undefined ? staged.pick_number : v.pick_number;
        if (!pickNumber || pickNumber.trim() === '') {
          variantsNeedingPick.push({
            id: vid,
            sku: v.sku
          });
        }
      });
    });

    if (variantsNeedingPick.length === 0) {
      showStatus('All selected variants already have pick numbers', 'warning');
      return;
    }

    const confirmMsg = `Generate pick numbers for ${variantsNeedingPick.length} variants without pick numbers?`;
    if (!confirm(confirmMsg)) return;

    showStatus(`Generating pick numbers for ${variantsNeedingPick.length} variants...`, 'info');

    try {
      const response = await fetchJSON('/api/products/generate-pick-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variantIds: variantsNeedingPick.map(v => v.id) })
      });

      if (response.success) {
        // Update local state with the new pick numbers
        response.assignments.forEach(a => {
          const vid = String(a.variantId);
          // Update the products array
          for (const p of products) {
            for (const v of p.variants) {
              if (String(v.id) === vid) {
                v.pick_number = String(a.pickNumber);
                break;
              }
            }
          }
        });

        showStatus(`Generated ${response.assigned} pick numbers successfully!`, 'success');

        // Refresh the table to show new pick numbers
        renderTable();
      } else {
        showStatus(response.message || 'Failed to generate pick numbers', 'error');
      }
    } catch (err) {
      console.error('Generate pick numbers error:', err);
      showStatus(`Error: ${err.message}`, 'error');
    }
  }

  function generateDetailedLabels() {
    showLabelPreview('detailed');
  }

  function generateLargeQRLabels() {
    showLabelPreview('largeqr');
  }

  function generateQRLabels() {
    showLabelPreview('qr');
  }

  function generateQRInventoryLabels() {
    showLabelPreview('qrinv');
  }

  function downloadLabels() {
    const selected = getSelectedVariantsWithPick();
    if (selected.length === 0) {
      closeLabelPreview();
      return;
    }

    let html = '';
    switch (currentLabelType) {
      case 'detailed':
        html = generateDetailedLabelsHTML(selected);
        break;
      case 'largeqr':
        html = generateLargeQRLabelsHTML(selected);
        break;
      case 'qr':
        html = generateQRLabelsHTML(selected);
        break;
      case 'qrinv':
        html = generateQRInventoryLabelsHTML(selected);
        break;
      default:
        closeLabelPreview();
        return;
    }

    // Download as HTML file
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `shelf-labels-${currentLabelType}-${date}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showStatus(`Downloaded ${selected.length} labels (${currentLabelType})`, 'success');
    closeLabelPreview();
  }

  // ===== Label HTML Generators ===============================================
  // Matching exact format from shelf_label_generator.html

  // Base64 arrows image for detailed labels
  const ARROWS_IMG = 'data:image/gif;base64,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';

  function generateDetailedLabelsHTML(items) {
    // 8 labels per 4x6 page (0.75in each)
    let labelsHTML = `<!DOCTYPE html>
<html>
<head>
    <title>Shelf Labels</title>
    <style>
        @page {
            size: 4in 6in;
            margin: 0;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
        }
        .page {
            width: 4in;
            height: 6in;
            page-break-after: always;
            display: flex;
            flex-direction: column;
        }
        .page:last-child {
            page-break-after: auto;
        }
        .label {
            height: 0.75in;
            border-bottom: 1px dashed #ccc;
            display: flex;
            flex-direction: row;
            justify-content: flex-start;
            align-items: center;
            text-align: left;
            padding: 2px 10px;
            box-sizing: border-box;
            gap: 10px;
        }
        .label:first-child {
            border-top: 1px dashed #ccc;
        }
        .label:last-child {
            border-bottom: none;
        }
        .pick-num {
            font-size: 24pt;
            font-weight: bold;
            line-height: 1;
            font-family: Arial, sans-serif;
            white-space: nowrap;
            display: flex;
            align-items: center;
        }
        .arrows {
            height: 28px;
            width: 28px;
            margin-right: 8px;
        }
        .sku-text {
            font-size: 9pt;
        }
        .name-text {
            font-size: 8pt;
            color: #333;
            max-width: 2.5in;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            line-height: 1.2;
        }
        .label-details {
            display: flex;
            flex-direction: column;
            gap: 1px;
        }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="no-print" style="padding: 20px; background: #f0f0f0; margin-bottom: 20px;">
        <strong>Instructions:</strong> Print this page with these settings:<br>
        • Paper size: 4" x 6"<br>
        • Margins: None<br>
        • Scale: 100%<br>
        <button onclick="window.print()" style="margin-top: 10px; padding: 10px 20px; font-size: 16px;">
            Print Labels
        </button>
    </div>
`;

    // Group into pages of 8
    for (let i = 0; i < items.length; i += 8) {
      labelsHTML += '<div class="page">';

      for (let j = i; j < Math.min(i + 8, items.length); j++) {
        const p = items[j];
        labelsHTML += `
            <div class="label">
                <div class="pick-num"><img class="arrows" src="${ARROWS_IMG}" alt=""> ${p.pick}</div>
                <div class="label-details">
                    <div class="sku-text">${p.sku}</div>
                    <div class="name-text">${p.name}</div>
                </div>
            </div>
        `;
      }

      // Fill empty slots if needed
      const remaining = 8 - (items.length - i);
      if (remaining > 0 && remaining < 8) {
        for (let k = 0; k < remaining; k++) {
          labelsHTML += '<div class="label"></div>';
        }
      }

      labelsHTML += '</div>';
    }

    labelsHTML += '</body></html>';
    return labelsHTML;
  }

  function generateLargeQRLabelsHTML(items) {
    // 3 labels per 4x6 page - matches shelf_label_generator.html generateSimplePDF
    let labelsHTML = `<!DOCTYPE html>
<html>
<head>
    <title>Shelf Labels with QR Codes</title>
    <style>
        @page {
            size: 4in 6in;
            margin: 0;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
        }
        .page {
            width: 4in;
            height: 6in;
            page-break-after: always;
            display: flex;
            flex-direction: column;
        }
        .page:last-child {
            page-break-after: auto;
        }
        .label {
            height: 2in;
            border-bottom: 1px dashed #ccc;
            display: flex;
            flex-direction: row;
            justify-content: flex-start;
            align-items: center;
            text-align: left;
            padding: 10px 15px;
            box-sizing: border-box;
            gap: 15px;
        }
        .label:first-child {
            border-top: 1px dashed #ccc;
        }
        .label:last-child {
            border-bottom: none;
        }
        .qr-code {
            width: 0.75in;
            height: 0.75in;
            flex-shrink: 0;
        }
        .label-content {
            display: flex;
            flex-direction: column;
            justify-content: center;
            flex: 1;
            min-width: 0;
        }
        .pick-num {
            font-size: 54pt;
            font-weight: bold;
            line-height: 1;
            font-family: Arial, sans-serif;
        }
        .sku-text {
            font-size: 11pt;
            font-weight: 600;
            color: #333;
            margin-top: 4px;
        }
        .name-text {
            font-size: 9pt;
            color: #666;
            margin-top: 2px;
            line-height: 1.2;
        }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="no-print" style="padding: 20px; background: #f0f0f0; margin-bottom: 20px;">
        <strong>Instructions:</strong> Print this page with these settings:<br>
        • Paper size: 4" x 6"<br>
        • Margins: None<br>
        • Scale: 100%<br>
        <button onclick="window.print()" style="margin-top: 10px; padding: 10px 20px; font-size: 16px;">
            Print Labels
        </button>
    </div>
`;

    // Group into pages of 3
    for (let i = 0; i < items.length; i += 3) {
      labelsHTML += '<div class="page">';

      for (let j = i; j < Math.min(i + 3, items.length); j++) {
        const item = items[j];
        const shopifyUrl = item.productId && item.variantId
          ? `https://admin.shopify.com/store/hemlock-oak/products/${item.productId}/variants/${item.variantId}`
          : '';
        const qrCodeUrl = shopifyUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(shopifyUrl)}`
          : '';
        labelsHTML += `
                        <div class="label">
                            ${qrCodeUrl ? `<img class="qr-code" src="${qrCodeUrl}" alt="QR">` : '<div class="qr-code" style="background:#eee;display:flex;align-items:center;justify-content:center;font-size:8px;color:#999;">No QR</div>'}
                            <div class="label-content">
                                <div class="pick-num">${item.pick}</div>
                                <div class="sku-text">${item.sku}</div>
                                <div class="name-text">${item.name}</div>
                            </div>
                        </div>
                    `;
      }

      // Fill empty slots if needed
      const remaining = 3 - (items.length - i);
      if (remaining > 0 && remaining < 3) {
        for (let k = 0; k < remaining; k++) {
          labelsHTML += '<div class="label"></div>';
        }
      }

      labelsHTML += '</div>';
    }

    labelsHTML += '</body></html>';
    return labelsHTML;
  }

  function generateQRLabelsHTML(items) {
    // 6 labels per 4x6 page (QR + Pick only) - matches shelf_label_generator.html generateQRLabels
    let labelsHTML = `<!DOCTYPE html>
<html>
<head>
    <title>QR Code Labels</title>
    <style>
        @page {
            size: 4in 6in;
            margin: 0;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
        }
        .page {
            width: 4in;
            height: 6in;
            page-break-after: always;
            display: flex;
            flex-direction: column;
        }
        .page:last-child {
            page-break-after: auto;
        }
        .label {
            height: 1in;
            border-bottom: 1px dashed #ccc;
            display: flex;
            flex-direction: row;
            justify-content: flex-start;
            align-items: center;
            padding: 0 10px;
            box-sizing: border-box;
            gap: 10px;
        }
        .label:first-child {
            border-top: 1px dashed #ccc;
        }
        .label:last-child {
            border-bottom: none;
        }
        .qr-code {
            width: 0.85in;
            height: 0.85in;
            flex-shrink: 0;
        }
        .pick-num {
            font-size: 48pt;
            font-weight: bold;
            line-height: 1;
            font-family: Arial, sans-serif;
        }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="no-print" style="padding: 20px; background: #f0f0f0; margin-bottom: 20px;">
        <strong>Instructions:</strong> Print this page with these settings:<br>
        • Paper size: 4" x 6"<br>
        • Margins: None<br>
        • Scale: 100%<br>
        <button onclick="window.print()" style="margin-top: 10px; padding: 10px 20px; font-size: 16px;">
            Print Labels
        </button>
    </div>
`;

    // Group into pages of 6
    for (let i = 0; i < items.length; i += 6) {
      labelsHTML += '<div class="page">';

      for (let j = i; j < Math.min(i + 6, items.length); j++) {
        const item = items[j];
        const shopifyUrl = item.productId && item.variantId
          ? `https://admin.shopify.com/store/hemlock-oak/products/${item.productId}/variants/${item.variantId}`
          : '';
        const qrCodeUrl = shopifyUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(shopifyUrl)}`
          : '';
        labelsHTML += `
                        <div class="label">
                            ${qrCodeUrl ? `<img class="qr-code" src="${qrCodeUrl}" alt="QR">` : '<div class="qr-code" style="background:#eee;"></div>'}
                            <div class="pick-num">${item.pick}</div>
                        </div>
                    `;
      }

      // Fill empty slots if needed
      const remaining = 6 - (items.length - i);
      if (remaining > 0 && remaining < 6) {
        for (let k = 0; k < remaining; k++) {
          labelsHTML += '<div class="label"></div>';
        }
      }

      labelsHTML += '</div>';
    }

    labelsHTML += '</body></html>';
    return labelsHTML;
  }

  function generateQRInventoryLabelsHTML(items) {
    // 6 labels per 4x6 page - QR links to inventory search by SKU
    // Matches shelf_label_generator.html generateQRLabelsInventory
    let labelsHTML = `<!DOCTYPE html>
<html>
<head>
    <title>QR Code Labels (Inventory)</title>
    <style>
        @page {
            size: 4in 6in;
            margin: 0;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
        }
        .page {
            width: 4in;
            height: 6in;
            page-break-after: always;
            display: flex;
            flex-direction: column;
        }
        .page:last-child {
            page-break-after: auto;
        }
        .label {
            height: 1in;
            border-bottom: 1px dashed #ccc;
            display: flex;
            flex-direction: row;
            justify-content: flex-start;
            align-items: center;
            padding: 0 10px;
            box-sizing: border-box;
            gap: 10px;
        }
        .label:first-child {
            border-top: 1px dashed #ccc;
        }
        .label:last-child {
            border-bottom: none;
        }
        .qr-code {
            width: 0.85in;
            height: 0.85in;
            flex-shrink: 0;
        }
        .pick-num {
            font-size: 48pt;
            font-weight: bold;
            line-height: 1;
            font-family: Arial, sans-serif;
        }
        @media print {
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="no-print" style="padding: 20px; background: #f0f0f0; margin-bottom: 20px;">
        <strong>Instructions:</strong> Print this page with these settings:<br>
        • Paper size: 4" x 6"<br>
        • Margins: None<br>
        • Scale: 100%<br>
        <button onclick="window.print()" style="margin-top: 10px; padding: 10px 20px; font-size: 16px;">
            Print Labels
        </button>
    </div>
`;

    // Group into pages of 6
    for (let i = 0; i < items.length; i += 6) {
      labelsHTML += '<div class="page">';

      for (let j = i; j < Math.min(i + 6, items.length); j++) {
        const item = items[j];
        // Use inventory search by SKU
        const shopifyUrl = item.sku
          ? `https://admin.shopify.com/store/hemlock-oak/products/inventory?query=${encodeURIComponent(item.sku)}`
          : '';
        const qrCodeUrl = shopifyUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(shopifyUrl)}`
          : '';
        labelsHTML += `
                        <div class="label">
                            ${qrCodeUrl ? `<img class="qr-code" src="${qrCodeUrl}" alt="QR">` : '<div class="qr-code" style="background:#eee;"></div>'}
                            <div class="pick-num">${item.pick}</div>
                        </div>
                    `;
      }

      // Fill empty slots if needed
      const remaining = 6 - (items.length - i);
      if (remaining > 0 && remaining < 6) {
        for (let k = 0; k < remaining; k++) {
          labelsHTML += '<div class="label"></div>';
        }
      }

      labelsHTML += '</div>';
    }

    labelsHTML += '</body></html>';
    return labelsHTML;
  }

  // ===== Tag Management =======================================================

  // Tag filter state
  let activeTagFilter = null;

  // Expose additional tag functions
  window.openTagEditor = openTagEditor;
  window.closeTagEditor = closeTagEditor;
  window.toggleTagOnVariant = toggleTagOnVariant;

  async function loadTags() {
    try {
      // Load all tags
      const tagsRes = await fetchJSON('/api/tags');
      allTags = tagsRes.tags || [];

      // Load variant-tag associations
      const vtRes = await fetchJSON('/api/products/variant-tags');
      variantTags = vtRes.variantTags || {};

      // Update tag filter dropdown if it exists
      populateTagFilter();
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }

  function populateTagFilter() {
    const tagFilter = document.getElementById('tagFilter');
    if (tagFilter) {
      tagFilter.innerHTML = '<option value="">All Tags</option>';
      tagFilter.innerHTML += '<option value="__none__">No Tags</option>';

      allTags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag.id;
        option.textContent = tag.name;
        option.style.color = tag.color;
        tagFilter.appendChild(option);
      });
    }

    // Also update the tag action select in the tag manager
    const tagActionSelect = document.getElementById('tagActionSelect');
    if (tagActionSelect) {
      tagActionSelect.innerHTML = '<option value="">Select a tag...</option>';
      allTags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag.id;
        option.textContent = tag.name;
        tagActionSelect.appendChild(option);
      });
    }
  }

  function filterByTag(tagId) {
    activeTagFilter = tagId || null;
    filterTable();
  }

  function openTagManager() {
    const panel = document.getElementById('tagManagerPanel');
    if (!panel) return;
    renderTagManagerList();
    panel.classList.add('active');
  }

  function closeTagManager() {
    const panel = document.getElementById('tagManagerPanel');
    if (panel) panel.classList.remove('active');
  }

  function renderTagManagerList() {
    const list = document.getElementById('tagManagerList');
    if (!list) return;

    if (allTags.length === 0) {
      list.innerHTML = '<p style="color:#666;font-size:.9rem;">No tags created yet.</p>';
      return;
    }

    list.innerHTML = allTags.map(tag => `
      <div class="tag-manager-item">
        <span class="tag-badge" style="background:${tag.color}">${tag.name}</span>
        <button class="btn-tag-delete" onclick="deleteTag(${tag.id})" title="Delete tag">&times;</button>
      </div>
    `).join('');
  }

  async function createTag() {
    const nameInput = document.getElementById('newTagName');
    const colorInput = document.getElementById('newTagColor');
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      showStatus('Tag name cannot be empty', 'warning');
      return;
    }

    const color = colorInput?.value || '#6c757d';

    try {
      const result = await fetchJSON('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });

      allTags.push(result.tag);
      nameInput.value = '';
      renderTagManagerList();
      populateTagFilter();
      showStatus(`Tag "${name}" created`, 'success');
    } catch (err) {
      showStatus('Failed to create tag: ' + err.message, 'error');
    }
  }

  async function deleteTag(tagId) {
    const tag = allTags.find(t => t.id === tagId);
    if (!tag) return;

    if (!confirm(`Delete tag "${tag.name}"? This will remove it from all variants.`)) return;

    try {
      await fetchJSON(`/api/tags/${tagId}`, { method: 'DELETE' });

      allTags = allTags.filter(t => t.id !== tagId);
      // Remove from variantTags
      Object.keys(variantTags).forEach(vid => {
        variantTags[vid] = variantTags[vid].filter(t => t.id !== tagId);
      });

      renderTagManagerList();
      populateTagFilter();
      renderTable();
      showStatus(`Tag "${tag.name}" deleted`, 'success');
    } catch (err) {
      showStatus('Failed to delete tag: ' + err.message, 'error');
    }
  }

  async function applyTagToSelected(tagId) {
    if (selectedIds.size === 0) {
      showStatus('No variants selected', 'warning');
      return;
    }

    const tag = allTags.find(t => t.id === parseInt(tagId));
    if (!tag) return;

    try {
      await fetchJSON('/api/products/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantIds: Array.from(selectedIds),
          tagIds: [parseInt(tagId)]
        })
      });

      // Update local state
      selectedIds.forEach(vid => {
        if (!variantTags[vid]) variantTags[vid] = [];
        if (!variantTags[vid].find(t => t.id === tag.id)) {
          variantTags[vid].push({ id: tag.id, name: tag.name, color: tag.color });
        }
      });

      renderTable();
      showStatus(`Applied tag "${tag.name}" to ${selectedIds.size} variants`, 'success');
    } catch (err) {
      showStatus('Failed to apply tag: ' + err.message, 'error');
    }
  }

  async function removeTagFromSelected(tagId) {
    if (selectedIds.size === 0) {
      showStatus('No variants selected', 'warning');
      return;
    }

    const tag = allTags.find(t => t.id === parseInt(tagId));
    if (!tag) return;

    try {
      await fetchJSON('/api/products/tags', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantIds: Array.from(selectedIds),
          tagIds: [parseInt(tagId)]
        })
      });

      // Update local state
      selectedIds.forEach(vid => {
        if (variantTags[vid]) {
          variantTags[vid] = variantTags[vid].filter(t => t.id !== tag.id);
        }
      });

      renderTable();
      showStatus(`Removed tag "${tag.name}" from ${selectedIds.size} variants`, 'success');
    } catch (err) {
      showStatus('Failed to remove tag: ' + err.message, 'error');
    }
  }

  // Tag editor for individual variants
  function openTagEditor(variantId, e) {
    const existingEditor = document.getElementById('tagEditorPopup');
    if (existingEditor) existingEditor.remove();

    const vTags = variantTags[variantId] || [];
    const vTagIds = new Set(vTags.map(t => t.id));

    const popup = document.createElement('div');
    popup.id = 'tagEditorPopup';
    popup.className = 'tag-editor-popup';
    popup.innerHTML = `
      <div class="tag-editor-content">
        <div class="tag-editor-header">
          <span>Edit Tags</span>
          <button class="close-btn" onclick="closeTagEditor()">&times;</button>
        </div>
        <div class="tag-editor-body">
          ${allTags.length === 0 ? '<p style="color:#666;font-size:.85rem;">No tags available. Create tags in Tag Manager.</p>' : ''}
          ${allTags.map(tag => `
            <label class="tag-checkbox">
              <input type="checkbox" ${vTagIds.has(tag.id) ? 'checked' : ''}
                onchange="toggleTagOnVariant('${variantId}', ${tag.id}, this.checked)">
              <span class="tag-badge" style="background:${tag.color}">${tag.name}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // Position near the clicked cell
    const clickX = e?.clientX || 100;
    const clickY = e?.clientY || 100;
    setTimeout(() => {
      const rect = popup.getBoundingClientRect();
      popup.style.top = Math.min(window.innerHeight - rect.height - 20, clickY) + 'px';
      popup.style.left = Math.min(window.innerWidth - rect.width - 20, clickX) + 'px';
    }, 0);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', closeTagEditorOnOutsideClick);
    }, 100);
  }

  function closeTagEditorOnOutsideClick(e) {
    const popup = document.getElementById('tagEditorPopup');
    if (popup && !popup.contains(e.target)) {
      closeTagEditor();
    }
  }

  function closeTagEditor() {
    const popup = document.getElementById('tagEditorPopup');
    if (popup) popup.remove();
    document.removeEventListener('click', closeTagEditorOnOutsideClick);
  }

  async function toggleTagOnVariant(variantId, tagId, checked) {
    const tag = allTags.find(t => t.id === tagId);
    if (!tag) return;

    try {
      if (checked) {
        await fetchJSON('/api/products/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variantIds: [variantId],
            tagIds: [tagId]
          })
        });

        if (!variantTags[variantId]) variantTags[variantId] = [];
        if (!variantTags[variantId].find(t => t.id === tag.id)) {
          variantTags[variantId].push({ id: tag.id, name: tag.name, color: tag.color });
        }
      } else {
        await fetchJSON('/api/products/tags', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variantIds: [variantId],
            tagIds: [tagId]
          })
        });

        if (variantTags[variantId]) {
          variantTags[variantId] = variantTags[variantId].filter(t => t.id !== tag.id);
        }
      }

      // Update the row without full re-render
      const row = document.querySelector(`tr[data-variant-id="${variantId}"]`);
      if (row) {
        const vTags = variantTags[variantId] || [];
        row.dataset.tagIds = vTags.map(t => t.id).join(',');
        row.dataset.tagNames = vTags.map(t => t.name.toLowerCase()).join(',');

        // Update tags cell
        const tagsCell = row.querySelector('td[data-col-id="tags"]');
        if (tagsCell) {
          if (vTags.length > 0) {
            tagsCell.innerHTML = vTags.map(t =>
              `<span class="tag-badge" style="background:${t.color}" title="${t.name}">${t.name}</span>`
            ).join('');
          } else {
            tagsCell.innerHTML = '<span class="no-tags">—</span>';
          }
        }
      }
    } catch (err) {
      showStatus('Failed to update tag: ' + err.message, 'error');
    }
  }

})();
