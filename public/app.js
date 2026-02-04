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

  // Track last clicked checkbox index for shift+click
  let lastCheckedIndex = null;

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

      renderTable();
      updateStats();
      populateCategoryFilter();
      updateLabelButtons();

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
    tbody.innerHTML = '';

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

        // Status flags
        const isDuplicateSku = !!sku && duplicateSkus.has(sku);
        const isMissingSku = !sku;
        const isDuplicatePick = !!pickNumber && duplicatePickNumbers.has(pickNumber);
        const isMissingPick = !pickNumber;
        const isMissingLocation = !warehouseLocation;

        // Select (persist checked state)
        const checkCell = row.insertCell();
        checkCell.innerHTML =
          `<input type="checkbox" class="select-for-update" data-variant-id="${variantId}" onclick="handleCheckboxClick(event, this)">`;
        const cb = checkCell.querySelector('input');
        if (selectedIds.has(variantId)) cb.checked = true;

        // Status badges (stacked if multiple)
        const statusCell = row.insertCell();
        const badges = [];
        if (isMissingSku) badges.push('<span class="missing-indicator">NO SKU</span>');
        else if (isDuplicateSku) badges.push('<span class="duplicate-indicator">DUP SKU</span>');
        if (isDuplicatePick) badges.push('<span class="dup-pick-indicator">DUP PICK</span>');
        if (isMissingPick) badges.push('<span class="miss-pick-indicator">NO PICK</span>');
        if (isMissingLocation) badges.push('<span class="miss-loc-indicator">NO LOC</span>');

        if (badges.length > 1) {
          statusCell.innerHTML = `<div class="badge-stack">${badges.join('')}</div>`;
        } else if (badges.length === 1) {
          statusCell.innerHTML = badges[0];
        }

        // Titles
        row.insertCell().textContent = product.title;
        row.insertCell().textContent = variant.title || 'Default';

        // SKU (editable)
        const skuCell = row.insertCell();
        skuCell.className = (isDuplicateSku || isMissingSku) ? 'editable sku-error' : 'editable';
        skuCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'sku')" data-variant-id="${variantId}" data-field="sku" class="editable-span">${sku}</span>`;
        if (staged.sku !== undefined) skuCell.classList.add('cell-modified');

        // Pick Number (editable)
        const pickCell = row.insertCell();
        pickCell.className = isDuplicatePick ? 'editable sku-error' : 'editable';
        pickCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'pick_number')">${pickNumber}</span>`;
        if (staged.pick_number !== undefined) pickCell.classList.add('cell-modified');

        // Warehouse Location (editable)
        const locCell = row.insertCell();
        locCell.className = 'editable';
        locCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'warehouse_location')">${warehouseLocation}</span>`;
        if (staged.warehouse_location !== undefined) locCell.classList.add('cell-modified');

        // Price (editable)
        const priceCell = row.insertCell();
        priceCell.className = 'editable';
        priceCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'price')">${price !== '' ? '$' + price : ''}</span>`;
        if (staged.price !== undefined) priceCell.classList.add('cell-modified');

        // Inventory (read-only)
        row.insertCell().textContent = variant.inventory_quantity || '0';

        // Weight (editable)
        const weightCell = row.insertCell();
        weightCell.className = 'editable';
        weightCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'weight')">${weight !== '' ? weight : ''}</span>`;
        if (staged.weight !== undefined) weightCell.classList.add('cell-modified');

        // HS Code (editable)
        const hsCell = row.insertCell();
        hsCell.className = 'editable';
        hsCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'harmonized_system_code')">${hs}</span>`;
        if (staged.harmonized_system_code !== undefined) hsCell.classList.add('cell-modified');

        // Country (editable)
        const countryCell = row.insertCell();
        countryCell.className = 'editable';
        countryCell.innerHTML =
          `<span onclick="makeEditable(this, '${variantId}', 'country_code_of_origin')">${country}</span>`;
        if (staged.country_code_of_origin !== undefined) countryCell.classList.add('cell-modified');

        // Row metadata for search/filter
        row.dataset.variantId = variantId;
        row.dataset.productTitle = product.title.toLowerCase();
        row.dataset.variantTitle = (variant.title || '').toLowerCase();
        row.dataset.sku = (sku || '').toLowerCase();
        row.dataset.pickNumber = (pickNumber || '').toLowerCase();
        row.dataset.warehouseLocation = (warehouseLocation || '').toLowerCase();
        row.dataset.productType = (product.product_type || '').toLowerCase();
        row.dataset.isDuplicateSku = isDuplicateSku ? '1' : '0';
        row.dataset.isMissingSku = isMissingSku ? '1' : '0';
        row.dataset.isDuplicatePick = isDuplicatePick ? '1' : '0';
        row.dataset.isMissingPick = isMissingPick ? '1' : '0';
        row.dataset.isMissingLocation = isMissingLocation ? '1' : '0';
      });
    });

    filterTable();
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
                               row.dataset.warehouseLocation;
        showRow = searchableText.includes(searchValue);
      }

      // Exclusion filter
      if (showRow && excludeKeywords.length > 0) {
        const searchableText = row.dataset.productTitle + ' ' +
                               row.dataset.variantTitle + ' ' +
                               row.dataset.sku + ' ' +
                               row.dataset.pickNumber + ' ' +
                               row.dataset.warehouseLocation;
        const matchesExclude = excludeKeywords.some(keyword => searchableText.includes(keyword));
        if (matchesExclude) showRow = false;
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

    loading.classList.add('active');
    loadingText.textContent = 'Syncing warehouse locations to ShipStation...';

    try {
      const response = await fetch('/api/products/sync-shipstation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'dirty' })
      });
      const result = await response.json();

      if (!response.ok) throw new Error(result.error);

      let msg = `ShipStation sync: ${result.created} created, ${result.updated} updated`;
      if (result.failed > 0) msg += `, ${result.failed} failed`;

      showStatus(msg, result.failed > 0 ? 'warning' : 'success');
    } catch (error) {
      showStatus('ShipStation sync failed: ' + error.message, 'error');
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
      const response = await fetchJSON('/products/api/products/generate-pick-numbers', {
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

  function generateDetailedLabelsHTML(items) {
    // 8 labels per 4x6 page
    const labelsPerPage = 8;
    const pages = [];

    for (let i = 0; i < items.length; i += labelsPerPage) {
      const pageItems = items.slice(i, i + labelsPerPage);
      const labels = pageItems.map(item => `
        <div class="label">
          <div class="pick">${item.pick}</div>
          <div class="sku">${item.sku}</div>
          <div class="name">${item.name}</div>
        </div>
      `).join('');
      pages.push(`<div class="page">${labels}</div>`);
    }

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Shelf Labels - Detailed</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; }
  .page { width: 4in; height: 6in; page-break-after: always; display: flex; flex-wrap: wrap; }
  .label { width: 2in; height: 0.75in; border-bottom: 1px dashed #ccc; border-right: 1px dashed #ccc; padding: 4px 6px; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
  .label:nth-child(2n) { border-right: none; }
  .pick { font-size: 24pt; font-weight: 700; font-family: 'Courier New', monospace; line-height: 1; }
  .sku { font-size: 9pt; color: #333; margin-top: 2px; }
  .name { font-size: 8pt; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 1.8in; }
  .no-print { padding: 20px; background: #f0f0f0; margin-bottom: 20px; }
  @media print { .no-print { display: none; } }
</style>
</head><body>
<div class="no-print">
  <strong>Instructions:</strong> Print with: Paper size 4×6, Margins: None, Scale: 100%<br>
  <button onclick="window.print()" style="margin-top:10px;padding:10px 20px;font-size:16px;">Print Labels</button>
</div>
${pages.join('')}
</body></html>`;
  }

  function generateLargeQRLabelsHTML(items) {
    // 3 labels per 4x6 page
    const labelsPerPage = 3;
    const pages = [];

    for (let i = 0; i < items.length; i += labelsPerPage) {
      const pageItems = items.slice(i, i + labelsPerPage);
      const labels = pageItems.map(item => {
        const qrUrl = item.productId && item.variantId
          ? `https://admin.shopify.com/store/hemlock-oak/products/${item.productId}/variants/${item.variantId}`
          : '';
        const qrSrc = qrUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(qrUrl)}`
          : '';
        return `
          <div class="label">
            ${qrSrc ? `<img class="qr" src="${qrSrc}" alt="QR">` : '<div class="qr-placeholder">No QR</div>'}
            <div class="info">
              <div class="pick">${item.pick}</div>
              <div class="sku">${item.sku}</div>
              <div class="name">${item.name}</div>
            </div>
          </div>
        `;
      }).join('');
      pages.push(`<div class="page">${labels}</div>`);
    }

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Shelf Labels - Large QR</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; }
  .page { width: 4in; height: 6in; page-break-after: always; display: flex; flex-direction: column; }
  .label { height: 2in; border-bottom: 1px dashed #ccc; padding: 10px; display: flex; align-items: center; gap: 15px; }
  .qr { width: 0.9in; height: 0.9in; }
  .qr-placeholder { width: 0.9in; height: 0.9in; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 10pt; color: #999; }
  .info { flex: 1; }
  .pick { font-size: 54pt; font-weight: 700; font-family: 'Courier New', monospace; line-height: 1; }
  .sku { font-size: 11pt; font-weight: 600; color: #333; margin-top: 4px; }
  .name { font-size: 9pt; color: #666; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 2.5in; }
  .no-print { padding: 20px; background: #f0f0f0; margin-bottom: 20px; }
  @media print { .no-print { display: none; } }
</style>
</head><body>
<div class="no-print">
  <strong>Instructions:</strong> Print with: Paper size 4×6, Margins: None, Scale: 100%<br>
  <button onclick="window.print()" style="margin-top:10px;padding:10px 20px;font-size:16px;">Print Labels</button>
</div>
${pages.join('')}
</body></html>`;
  }

  function generateQRLabelsHTML(items) {
    // 6 labels per 4x6 page (QR + Pick only)
    const labelsPerPage = 6;
    const pages = [];

    for (let i = 0; i < items.length; i += labelsPerPage) {
      const pageItems = items.slice(i, i + labelsPerPage);
      const labels = pageItems.map(item => {
        const qrUrl = item.productId && item.variantId
          ? `https://admin.shopify.com/store/hemlock-oak/products/${item.productId}/variants/${item.variantId}`
          : '';
        const qrSrc = qrUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(qrUrl)}`
          : '';
        return `
          <div class="label">
            ${qrSrc ? `<img class="qr" src="${qrSrc}" alt="QR">` : '<div class="qr-placeholder">No QR</div>'}
            <div class="pick">${item.pick}</div>
          </div>
        `;
      }).join('');
      pages.push(`<div class="page">${labels}</div>`);
    }

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Shelf Labels - QR</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; }
  .page { width: 4in; height: 6in; page-break-after: always; display: flex; flex-wrap: wrap; }
  .label { width: 2in; height: 1in; border-bottom: 1px dashed #ccc; border-right: 1px dashed #ccc; padding: 5px; display: flex; align-items: center; gap: 8px; }
  .label:nth-child(2n) { border-right: none; }
  .qr { width: 0.85in; height: 0.85in; }
  .qr-placeholder { width: 0.85in; height: 0.85in; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #999; }
  .pick { font-size: 36pt; font-weight: 700; font-family: 'Courier New', monospace; }
  .no-print { padding: 20px; background: #f0f0f0; margin-bottom: 20px; }
  @media print { .no-print { display: none; } }
</style>
</head><body>
<div class="no-print">
  <strong>Instructions:</strong> Print with: Paper size 4×6, Margins: None, Scale: 100%<br>
  <button onclick="window.print()" style="margin-top:10px;padding:10px 20px;font-size:16px;">Print Labels</button>
</div>
${pages.join('')}
</body></html>`;
  }

  function generateQRInventoryLabelsHTML(items) {
    // 6 labels per 4x6 page - QR links to SKU search
    const labelsPerPage = 6;
    const pages = [];

    for (let i = 0; i < items.length; i += labelsPerPage) {
      const pageItems = items.slice(i, i + labelsPerPage);
      const labels = pageItems.map(item => {
        // QR links to inventory search by SKU
        const qrUrl = item.sku
          ? `https://admin.shopify.com/store/hemlock-oak/products?query=${encodeURIComponent(item.sku)}`
          : '';
        const qrSrc = qrUrl
          ? `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(qrUrl)}`
          : '';
        return `
          <div class="label">
            ${qrSrc ? `<img class="qr" src="${qrSrc}" alt="QR">` : '<div class="qr-placeholder">No QR</div>'}
            <div class="info">
              <div class="pick">${item.pick}</div>
              <div class="sku">${item.sku}</div>
            </div>
          </div>
        `;
      }).join('');
      pages.push(`<div class="page">${labels}</div>`);
    }

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Shelf Labels - QR Inventory</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; }
  .page { width: 4in; height: 6in; page-break-after: always; display: flex; flex-wrap: wrap; }
  .label { width: 2in; height: 1in; border-bottom: 1px dashed #ccc; border-right: 1px dashed #ccc; padding: 5px; display: flex; align-items: center; gap: 8px; }
  .label:nth-child(2n) { border-right: none; }
  .qr { width: 0.85in; height: 0.85in; }
  .qr-placeholder { width: 0.85in; height: 0.85in; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #999; }
  .info { display: flex; flex-direction: column; justify-content: center; }
  .pick { font-size: 32pt; font-weight: 700; font-family: 'Courier New', monospace; line-height: 1; }
  .sku { font-size: 8pt; color: #333; margin-top: 2px; }
  .no-print { padding: 20px; background: #f0f0f0; margin-bottom: 20px; }
  @media print { .no-print { display: none; } }
</style>
</head><body>
<div class="no-print">
  <strong>Instructions:</strong> Print with: Paper size 4×6, Margins: None, Scale: 100%<br>
  <button onclick="window.print()" style="margin-top:10px;padding:10px 20px;font-size:16px;">Print Labels</button>
</div>
${pages.join('')}
</body></html>`;
  }

})();
