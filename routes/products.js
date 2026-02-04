// Product management routes - WITH DATABASE INTEGRATION
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ShopifyAPI } = require('../shopify-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

// Database utilities
const productDb = require('../utils/product-db');

// ShipStation API
const { ShipStationAPI } = require('../shipstation-api');
let shipstation = null;
try {
  shipstation = new ShipStationAPI();
} catch (e) {
  console.warn('[Products] ShipStation API not configured:', e.message);
}

// Initialize Shopify API
const shopify = new ShopifyAPI();

// Load HTML template
const productManagerHTML = fs.readFileSync(path.join(__dirname, '../views/product-manager.html'), 'utf8');

// ============================================================================
// PAGE ROUTES
// ============================================================================

// Main product manager page
router.get('/', requireAuth, (req, res) => {
  res.send(productManagerHTML);
});

// ============================================================================
// API: GET PRODUCTS
// ============================================================================

/**
 * GET /api/products
 * Returns products and variants from the database
 * Query params:
 *   - source=shopify : bypass DB and fetch directly from Shopify (debug mode)
 *   - status=active|archived|draft : filter by product status
 */
router.get('/api/products', requireAuthApi, async (req, res) => {
  try {
    const source = req.query.source || 'db';
    const status = req.query.status || 'active';

    let products;
    let duplicateSkus = [];
    let duplicatePickNumbers = [];
    let stats = {};

    if (source === 'shopify') {
      // Direct Shopify fetch (legacy/debug mode)
      console.log('[Products API] Fetching directly from Shopify...');
      products = await shopify.getAllProductsWithInventory(status);

      // Compute duplicate SKUs
      const skuCounts = new Map();
      products.forEach(p => p.variants.forEach(v => {
        const sku = String(v.sku || '').trim();
        if (!sku) return;
        skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
      }));
      skuCounts.forEach((count, sku) => {
        if (count > 1) duplicateSkus.push(sku);
      });

      stats = {
        source: 'shopify',
        productCount: products.length,
        variantCount: products.reduce((s, p) => s + p.variants.length, 0),
        duplicateSkuCount: duplicateSkus.length
      };
    } else {
      // Database fetch (default)
      console.log('[Products API] Fetching from database...');

      // Check if database is initialized
      try {
        const dbStats = await productDb.getStats();

        if (dbStats.variantCount === 0) {
          // Database is empty - prompt user to sync
          return res.json({
            products: [],
            duplicates: [],
            duplicatePickNumbers: [],
            stats: {
              source: 'db',
              productCount: 0,
              variantCount: 0,
              message: 'Database is empty. Click "Sync Now" to import products from Shopify.'
            },
            needsSync: true
          });
        }

        products = await productDb.getAllProductsWithVariants({ status });

        // Get duplicate info from database
        const dupSkusResult = await productDb.getDuplicateSkus();
        duplicateSkus = dupSkusResult.map(d => d.sku);

        const dupPicksResult = await productDb.getDuplicatePickNumbers();
        duplicatePickNumbers = dupPicksResult.map(d => d.pick_number);

        stats = {
          source: 'db',
          ...dbStats
        };
      } catch (dbError) {
        // Database not initialized - run migrations
        console.log('[Products API] Database not initialized, running migrations...');
        await productDb.runMigrations();

        return res.json({
          products: [],
          duplicates: [],
          duplicatePickNumbers: [],
          stats: {
            source: 'db',
            productCount: 0,
            variantCount: 0,
            message: 'Database initialized. Click "Sync Now" to import products from Shopify.'
          },
          needsSync: true
        });
      }
    }

    res.json({
      products,
      duplicates: duplicateSkus,
      duplicatePickNumbers,
      stats
    });
  } catch (err) {
    console.error('[Products API] Error:', err);
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

// ============================================================================
// API: UPDATE PRODUCTS
// ============================================================================

/**
 * POST /api/products/update
 * Updates variants in DB and syncs to Shopify (and optionally ShipStation)
 * Body: { updates: [{ id, sku, price, weight, harmonized_system_code, country_code_of_origin, pick_number, warehouse_location }] }
 */
router.post('/api/products/update', requireAuthApi, async (req, res) => {
  const { updates } = req.body || {};
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'Invalid update data' });
  }

  const results = {
    validated: 0,
    updated: 0,
    failed: 0,
    errors: [],
    warnings: [],
    details: []
  };

  try {
    // ========================================================================
    // STEP 1: VALIDATION
    // ========================================================================

    // Check for pick number uniqueness
    const pickNumberConflicts = await productDb.validatePickNumberUniqueness(updates);
    if (pickNumberConflicts.length > 0) {
      // Return validation error - do not proceed with updates
      return res.status(400).json({
        error: 'Pick number validation failed',
        conflicts: pickNumberConflicts,
        message: pickNumberConflicts.map(c => c.message).join('; ')
      });
    }

    // Check for required fields (warning only - don't block)
    for (const update of updates) {
      if (update.pick_number !== undefined && !update.pick_number?.trim()) {
        results.warnings.push({
          variantId: update.id,
          field: 'pick_number',
          message: 'Pick number is empty'
        });
      }
      if (update.warehouse_location !== undefined && !update.warehouse_location?.trim()) {
        results.warnings.push({
          variantId: update.id,
          field: 'warehouse_location',
          message: 'Warehouse location is empty'
        });
      }
    }

    results.validated = updates.length;

    // ========================================================================
    // STEP 2: UPDATE SHOPIFY
    // ========================================================================

    console.log(`[Products API] Updating ${updates.length} variants in Shopify...`);
    const shopifyResults = await shopify.updateVariantsWithMetafields(updates);

    // ========================================================================
    // STEP 3: UPDATE DATABASE
    // ========================================================================

    console.log(`[Products API] Updating database...`);
    const variantsNeedingShipStationSync = [];

    for (const update of updates) {
      try {
        const dbUpdate = {};

        if (update.sku !== undefined) dbUpdate.sku = update.sku;
        if (update.price !== undefined) dbUpdate.price = update.price ? parseFloat(update.price) : null;
        if (update.weight !== undefined) dbUpdate.weight_grams = update.weight ? parseFloat(update.weight) : null;
        if (update.harmonized_system_code !== undefined) dbUpdate.harmonized_system_code = update.harmonized_system_code;
        if (update.country_code_of_origin !== undefined) dbUpdate.country_code_of_origin = update.country_code_of_origin;
        if (update.pick_number !== undefined) dbUpdate.pick_number = update.pick_number;
        if (update.warehouse_location !== undefined) {
          dbUpdate.warehouse_location = update.warehouse_location;
          variantsNeedingShipStationSync.push(update.id);
        }

        // Get metafield IDs from Shopify response if available
        const shopifyDetail = shopifyResults.details?.find(d => d.variantId === update.id);
        if (shopifyDetail?.metafields?.pick_number?.metafield_id) {
          dbUpdate.pick_metafield_id = shopifyDetail.metafields.pick_number.metafield_id;
        }
        if (shopifyDetail?.metafields?.warehouse_location?.metafield_id) {
          dbUpdate.location_metafield_id = shopifyDetail.metafields.warehouse_location.metafield_id;
        }

        if (Object.keys(dbUpdate).length > 0) {
          await productDb.updateVariant(update.id, dbUpdate);
        }
      } catch (dbError) {
        console.error(`[Products API] DB update failed for variant ${update.id}:`, dbError.message);
      }
    }

    // Mark variants as needing ShipStation sync
    if (variantsNeedingShipStationSync.length > 0) {
      await productDb.markShipStationDirty(variantsNeedingShipStationSync);
    }

    // ========================================================================
    // STEP 4: COMPILE RESULTS
    // ========================================================================

    results.updated = shopifyResults.updated;
    results.failed = shopifyResults.failed;
    results.errors = shopifyResults.errors;
    results.details = shopifyResults.details;

    // Include ShipStation sync count if applicable
    if (variantsNeedingShipStationSync.length > 0) {
      results.shipstationPending = variantsNeedingShipStationSync.length;
    }

    res.json(results);
  } catch (err) {
    console.error('[Products API] Update error:', err);
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg, results });
  }
});

// ============================================================================
// API: SYNC OPERATIONS
// ============================================================================

/**
 * POST /api/products/sync
 * Triggers a sync from Shopify to the database
 * Body: { mode: 'full' | 'incremental' }
 */
router.post('/api/products/sync', requireAuthApi, async (req, res) => {
  const mode = req.body.mode || 'full';

  console.log(`[Products API] Starting ${mode} sync from Shopify...`);

  // Create sync log entry
  const syncLog = await productDb.createSyncLog(mode, 'inbound');
  const startTime = Date.now();

  try {
    // Ensure database tables exist
    await productDb.runMigrations();

    // Fetch products from Shopify with metafields
    console.log('[Products API] Fetching products from Shopify with metafields...');
    const products = await shopify.getAllProductsWithMetafields('active');

    // Debug: Count how many variants have pick_number or warehouse_location
    let withPick = 0, withLoc = 0;
    products.forEach(p => p.variants.forEach(v => {
      if (v.pick_number) withPick++;
      if (v.warehouse_location) withLoc++;
    }));
    console.log(`[Products API] DEBUG: ${withPick} variants with pick_number, ${withLoc} with warehouse_location`);

    console.log(`[Products API] Fetched ${products.length} products, syncing to database...`);

    // Bulk upsert to database
    const upsertStats = await productDb.bulkUpsertProducts(products);

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Complete sync log
    const counts = {
      products_synced: upsertStats.products,
      variants_synced: upsertStats.variants,
      errors: upsertStats.errors.length,
      duration_seconds: elapsed
    };

    await productDb.completeSyncLog(
      syncLog.id,
      upsertStats.errors.length === 0,
      counts,
      upsertStats.errors.length > 0 ? JSON.stringify(upsertStats.errors) : null
    );

    console.log(`[Products API] Sync complete: ${upsertStats.products} products, ${upsertStats.variants} variants in ${elapsed}s`);

    res.json({
      success: true,
      mode,
      products_synced: upsertStats.products,
      variants_synced: upsertStats.variants,
      errors: upsertStats.errors,
      duration_seconds: elapsed
    });
  } catch (err) {
    console.error('[Products API] Sync error:', err);

    // Log the failure
    await productDb.completeSyncLog(syncLog.id, false, {}, err.message);

    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    res.status(status).json({ error: msg });
  }
});

/**
 * GET /api/products/sync-status
 * Returns the current sync status
 */
router.get('/api/products/sync-status', requireAuthApi, async (req, res) => {
  try {
    const status = await productDb.getSyncStatus();
    res.json(status);
  } catch (err) {
    console.error('[Products API] Sync status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: VALIDATION ENDPOINTS
// ============================================================================

/**
 * GET /api/products/duplicates
 * Returns duplicate SKUs and pick numbers
 */
router.get('/api/products/duplicates', requireAuthApi, async (req, res) => {
  try {
    const [duplicateSkus, duplicatePickNumbers] = await Promise.all([
      productDb.getDuplicateSkus(),
      productDb.getDuplicatePickNumbers()
    ]);

    res.json({
      duplicateSkus,
      duplicatePickNumbers
    });
  } catch (err) {
    console.error('[Products API] Duplicates error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/missing
 * Returns variants with missing required fields
 */
router.get('/api/products/missing', requireAuthApi, async (req, res) => {
  try {
    const missing = await productDb.getVariantsMissingFields();
    res.json({ variants: missing });
  } catch (err) {
    console.error('[Products API] Missing fields error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/products/validate-pick-numbers
 * Validates pick numbers for uniqueness before save
 * Body: { updates: [{ id, pick_number }] }
 */
router.post('/api/products/validate-pick-numbers', requireAuthApi, async (req, res) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const conflicts = await productDb.validatePickNumberUniqueness(updates);

    res.json({
      valid: conflicts.length === 0,
      conflicts
    });
  } catch (err) {
    console.error('[Products API] Validation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: DATABASE MANAGEMENT
// ============================================================================

/**
 * POST /api/products/db/migrate
 * Runs database migrations
 */
router.post('/api/products/db/migrate', requireAuthApi, async (req, res) => {
  try {
    await productDb.runMigrations();
    res.json({ success: true, message: 'Migrations completed' });
  } catch (err) {
    console.error('[Products API] Migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/stats
 * Returns comprehensive database statistics
 */
router.get('/api/products/stats', requireAuthApi, async (req, res) => {
  try {
    const stats = await productDb.getStats();
    res.json(stats);
  } catch (err) {
    console.error('[Products API] Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// API: SHIPSTATION SYNC
// ============================================================================

/**
 * POST /api/products/sync-shipstation
 * Syncs warehouse locations to ShipStation
 * Body: { mode: 'dirty' | 'full', variantIds?: [] }
 */
router.post('/api/products/sync-shipstation', requireAuthApi, async (req, res) => {
  if (!shipstation) {
    return res.status(503).json({ error: 'ShipStation API not configured' });
  }

  const { mode = 'dirty', variantIds = [] } = req.body;

  console.log(`[Products API] Starting ShipStation sync (mode: ${mode})...`);

  try {
    let variants;

    if (variantIds.length > 0) {
      // Sync specific variants
      const pool = productDb.getPool();
      const result = await pool.query(`
        SELECT v.*, p.title as product_title
        FROM variants v
        JOIN products p ON v.shopify_product_id = p.shopify_product_id
        WHERE v.shopify_variant_id = ANY($1)
          AND v.sku IS NOT NULL AND v.sku != ''
      `, [variantIds]);
      variants = result.rows;
    } else if (mode === 'dirty') {
      // Sync only dirty variants
      variants = await productDb.getVariantsNeedingShipStationSync();
    } else {
      // Full sync - all variants with SKUs
      const pool = productDb.getPool();
      const result = await pool.query(`
        SELECT v.*, p.title as product_title
        FROM variants v
        JOIN products p ON v.shopify_product_id = p.shopify_product_id
        WHERE v.is_archived = FALSE
          AND v.sku IS NOT NULL AND v.sku != ''
      `);
      variants = result.rows;
    }

    if (variants.length === 0) {
      return res.json({
        success: true,
        message: 'No variants to sync',
        synced: 0
      });
    }

    console.log(`[Products API] Syncing ${variants.length} variants to ShipStation...`);

    // Batch sync to ShipStation
    const syncResults = await shipstation.batchSyncWarehouseLocations(variants);

    // Mark synced variants as clean
    const successfulSkus = syncResults.details
      .filter(d => d.action === 'created' || d.action === 'updated')
      .map(d => d.sku);

    if (successfulSkus.length > 0) {
      // Get variant IDs from SKUs
      const pool = productDb.getPool();
      const variantIdsResult = await pool.query(
        'SELECT shopify_variant_id FROM variants WHERE sku = ANY($1)',
        [successfulSkus]
      );
      const syncedVariantIds = variantIdsResult.rows.map(r => r.shopify_variant_id);
      await productDb.markShipStationSynced(syncedVariantIds);
    }

    res.json({
      success: true,
      mode,
      total: variants.length,
      created: syncResults.created,
      updated: syncResults.updated,
      failed: syncResults.failed,
      errors: syncResults.errors
    });
  } catch (err) {
    console.error('[Products API] ShipStation sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/shipstation-pending
 * Returns variants that need to be synced to ShipStation
 */
router.get('/api/products/shipstation-pending', requireAuthApi, async (req, res) => {
  try {
    const variants = await productDb.getVariantsNeedingShipStationSync();
    res.json({
      count: variants.length,
      variants: variants.map(v => ({
        shopify_variant_id: v.shopify_variant_id,
        sku: v.sku,
        product_title: v.product_title,
        warehouse_location: v.warehouse_location
      }))
    });
  } catch (err) {
    console.error('[Products API] ShipStation pending error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DEBUG ENDPOINTS
// ============================================================================

/**
 * GET /api/products/debug/metafields/:variantId
 * Debug endpoint to check metafield fetching for a specific variant
 */
router.get('/api/products/debug/metafields/:variantId', requireAuthApi, async (req, res) => {
  try {
    const variantId = req.params.variantId;
    console.log('[Debug] Fetching metafields for variant:', variantId);

    // Try GraphQL method
    const graphqlResult = await shopify.getVariantMetafields(variantId);
    console.log('[Debug] GraphQL result:', graphqlResult);

    // Also try REST API directly
    const restResult = await shopify.client.get(`/variants/${variantId}/metafields.json`);
    console.log('[Debug] REST result:', restResult.data);

    res.json({
      variantId,
      graphqlResult,
      restMetafields: restResult.data?.metafields || [],
      config: shopify.metafieldConfig
    });
  } catch (error) {
    console.error('[Debug] Error:', error.message);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

/**
 * GET /api/products/debug/graphql-test
 * Test the GraphQL metafield query directly
 * Add ?sku=XXXXX to test a specific SKU
 */
router.get('/api/products/debug/graphql-test', requireAuthApi, async (req, res) => {
  try {
    const { namespace: pickNs, key: pickKey } = shopify.metafieldConfig.pick_number;
    const { namespace: locNs, key: locKey } = shopify.metafieldConfig.warehouse_location;
    const testSku = req.query.sku || '2026Q4-WEEKLY-HARD-AUT';

    console.log('[Debug] Metafield config:', { pickNs, pickKey, locNs, locKey });
    console.log('[Debug] Testing SKU:', testSku);

    // Test 1: Query with keys filter (what sync uses)
    const queryWithFilter = `
      query {
        productVariants(first: 5, query: "sku:${testSku}") {
          edges {
            node {
              id
              legacyResourceId
              sku
              metafields(first: 10, keys: ["${pickNs}.${pickKey}", "${locNs}.${locKey}"]) {
                edges {
                  node { namespace key value }
                }
              }
            }
          }
        }
      }
    `;

    // Test 2: Query ALL metafields (no filter)
    const queryAllMetafields = `
      query {
        productVariants(first: 5, query: "sku:${testSku}") {
          edges {
            node {
              id
              legacyResourceId
              sku
              metafields(first: 20) {
                edges {
                  node { namespace key value }
                }
              }
            }
          }
        }
      }
    `;

    // Test 3: Direct metafield lookup (alternative syntax)
    const queryDirectLookup = `
      query {
        productVariants(first: 5, query: "sku:${testSku}") {
          edges {
            node {
              id
              legacyResourceId
              sku
              pickNumber: metafield(namespace: "${pickNs}", key: "${pickKey}") { value }
              warehouseLocation: metafield(namespace: "${locNs}", key: "${locKey}") { value }
            }
          }
        }
      }
    `;

    const [withFilter, allMetafields, directLookup] = await Promise.all([
      shopify.graphqlClient.post('/graphql.json', { query: queryWithFilter }),
      shopify.graphqlClient.post('/graphql.json', { query: queryAllMetafields }),
      shopify.graphqlClient.post('/graphql.json', { query: queryDirectLookup })
    ]);

    res.json({
      config: { pickNs, pickKey, locNs, locKey },
      testSku,
      withKeysFilter: withFilter.data,
      allMetafields: allMetafields.data,
      directLookup: directLookup.data
    });
  } catch (error) {
    console.error('[Debug] GraphQL error:', error.response?.data || error.message);
    res.status(500).json({
      error: error.message,
      graphqlErrors: error.response?.data?.errors
    });
  }
});

// ============================================================================
// SHOPIFY WEBHOOKS
// ============================================================================

/**
 * Verify Shopify webhook signature (optional but recommended)
 * For now, we'll process all requests but you can add HMAC verification later
 */
function verifyShopifyWebhook(req, res, next) {
  // TODO: Add HMAC verification using SHOPIFY_API_SECRET
  // For now, just proceed
  next();
}

/**
 * POST /api/webhooks/shopify/products/create
 * Called when a product is created in Shopify
 */
router.post('/api/webhooks/shopify/products/create', verifyShopifyWebhook, async (req, res) => {
  console.log('[Webhook] Product created:', req.body?.id, req.body?.title);

  try {
    const product = req.body;
    if (!product || !product.id) {
      return res.status(200).send('OK'); // Always return 200 to Shopify
    }

    // Fetch full product with metafields
    const fullProduct = await shopify.getProduct(product.id);
    if (fullProduct) {
      // Get metafields for variants
      const metafieldsMap = await shopify.fetchAllVariantMetafields();

      // Attach metafields to variants
      for (const variant of fullProduct.variants || []) {
        const mf = metafieldsMap.get(String(variant.id));
        if (mf) {
          variant.pick_number = mf.pick_number;
          variant.warehouse_location = mf.warehouse_location;
          variant.pick_metafield_id = mf.pick_metafield_id;
          variant.location_metafield_id = mf.location_metafield_id;
        }
      }

      // Attach inventory fields
      await shopify.attachInventoryFields([fullProduct]);

      // Upsert to database
      await productDb.bulkUpsertProducts([fullProduct]);
      console.log('[Webhook] Product created and synced:', product.id);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error processing product create:', error.message);
    res.status(200).send('OK'); // Still return 200 to prevent retries
  }
});

/**
 * POST /api/webhooks/shopify/products/update
 * Called when a product is updated in Shopify
 */
router.post('/api/webhooks/shopify/products/update', verifyShopifyWebhook, async (req, res) => {
  console.log('[Webhook] Product updated:', req.body?.id, req.body?.title);

  try {
    const product = req.body;
    if (!product || !product.id) {
      return res.status(200).send('OK');
    }

    // Fetch full product with metafields
    const fullProduct = await shopify.getProduct(product.id);
    if (fullProduct) {
      // Get metafields for this product's variants only
      for (const variant of fullProduct.variants || []) {
        const mf = await shopify.getVariantMetafields(variant.id);
        if (mf) {
          variant.pick_number = mf.pick_number;
          variant.warehouse_location = mf.warehouse_location;
          variant.pick_metafield_id = mf.pick_metafield_id;
          variant.location_metafield_id = mf.location_metafield_id;
        }
      }

      // Attach inventory fields
      await shopify.attachInventoryFields([fullProduct]);

      // Upsert to database
      await productDb.bulkUpsertProducts([fullProduct]);
      console.log('[Webhook] Product updated and synced:', product.id);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error processing product update:', error.message);
    res.status(200).send('OK');
  }
});

/**
 * POST /api/webhooks/shopify/products/delete
 * Called when a product is deleted in Shopify
 */
router.post('/api/webhooks/shopify/products/delete', verifyShopifyWebhook, async (req, res) => {
  console.log('[Webhook] Product deleted:', req.body?.id);

  try {
    const product = req.body;
    if (!product || !product.id) {
      return res.status(200).send('OK');
    }

    // Mark product and its variants as archived in the database
    const pool = productDb.getPool();

    // Mark variants as archived
    await pool.query(
      'UPDATE variants SET is_archived = TRUE WHERE shopify_product_id = $1',
      [product.id]
    );

    // Update product status
    await pool.query(
      'UPDATE products SET status = $1 WHERE shopify_product_id = $2',
      ['archived', product.id]
    );

    console.log('[Webhook] Product marked as archived:', product.id);
    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error processing product delete:', error.message);
    res.status(200).send('OK');
  }
});

module.exports = router;
