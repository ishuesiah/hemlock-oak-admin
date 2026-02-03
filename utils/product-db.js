// utils/product-db.js
// Postgres database utility for product/variant storage (Neon)
'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Metafield configuration - can be overridden via environment variables
const METAFIELD_CONFIG = {
  pick_number: {
    namespace: process.env.PICK_NUMBER_METAFIELD_NAMESPACE || 'custom',
    key: process.env.PICK_NUMBER_METAFIELD_KEY || 'pick_number',
    type: process.env.PICK_NUMBER_METAFIELD_TYPE || 'single_line_text_field'
  },
  warehouse_location: {
    namespace: process.env.WAREHOUSE_LOCATION_METAFIELD_NAMESPACE || 'inventory',
    key: process.env.WAREHOUSE_LOCATION_METAFIELD_KEY || 'warehouse_location',
    type: process.env.WAREHOUSE_LOCATION_METAFIELD_TYPE || 'single_line_text_field'
  }
};

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.PRODUCT_DATABASE_NEON || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Missing PRODUCT_DATABASE_NEON or DATABASE_URL environment variable');
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    pool.on('error', (err) => {
      console.error('[Product DB] Unexpected error on idle client', err);
    });

    console.log('[Product DB] Pool created');
  }
  return pool;
}

// ============================================================================
// MIGRATION RUNNER
// ============================================================================

async function runMigrations() {
  const client = await getPool().connect();
  try {
    console.log('[Product DB] Running migrations...');

    const migrationPath = path.join(__dirname, '../migrations/001_create_products_tables.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    await client.query(migrationSQL);

    console.log('[Product DB] Migrations completed successfully');
    return { success: true };
  } catch (error) {
    console.error('[Product DB] Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// PRODUCT OPERATIONS
// ============================================================================

/**
 * Upsert a product (insert or update)
 */
async function upsertProduct(product) {
  const pool = getPool();
  const query = `
    INSERT INTO products (
      shopify_product_id, handle, title, status, vendor, product_type, tags,
      created_at_shopify, updated_at_shopify, last_synced_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (shopify_product_id) DO UPDATE SET
      handle = EXCLUDED.handle,
      title = EXCLUDED.title,
      status = EXCLUDED.status,
      vendor = EXCLUDED.vendor,
      product_type = EXCLUDED.product_type,
      tags = EXCLUDED.tags,
      created_at_shopify = EXCLUDED.created_at_shopify,
      updated_at_shopify = EXCLUDED.updated_at_shopify,
      last_synced_at = NOW()
    RETURNING *
  `;

  const values = [
    product.id,
    product.handle,
    product.title,
    product.status || 'active',
    product.vendor,
    product.product_type,
    product.tags,
    product.created_at,
    product.updated_at
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

/**
 * Upsert a variant (insert or update)
 */
async function upsertVariant(variant, productId) {
  const pool = getPool();
  const query = `
    INSERT INTO variants (
      shopify_variant_id, shopify_product_id, sku, variant_title, price,
      compare_at_price, weight_grams, barcode, inventory_item_id, inventory_quantity,
      harmonized_system_code, country_code_of_origin, pick_number, warehouse_location,
      pick_metafield_id, location_metafield_id, is_archived, last_synced_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
    ON CONFLICT (shopify_variant_id) DO UPDATE SET
      shopify_product_id = EXCLUDED.shopify_product_id,
      sku = EXCLUDED.sku,
      variant_title = EXCLUDED.variant_title,
      price = EXCLUDED.price,
      compare_at_price = EXCLUDED.compare_at_price,
      weight_grams = EXCLUDED.weight_grams,
      barcode = EXCLUDED.barcode,
      inventory_item_id = EXCLUDED.inventory_item_id,
      inventory_quantity = EXCLUDED.inventory_quantity,
      harmonized_system_code = EXCLUDED.harmonized_system_code,
      country_code_of_origin = EXCLUDED.country_code_of_origin,
      pick_number = COALESCE(EXCLUDED.pick_number, variants.pick_number),
      warehouse_location = COALESCE(EXCLUDED.warehouse_location, variants.warehouse_location),
      pick_metafield_id = COALESCE(EXCLUDED.pick_metafield_id, variants.pick_metafield_id),
      location_metafield_id = COALESCE(EXCLUDED.location_metafield_id, variants.location_metafield_id),
      is_archived = EXCLUDED.is_archived,
      last_synced_at = NOW()
    RETURNING *
  `;

  const values = [
    variant.id,
    productId,
    variant.sku || null,
    variant.title || 'Default',
    variant.price ? parseFloat(variant.price) : null,
    variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
    variant.weight || variant.grams || null,
    variant.barcode || null,
    variant.inventory_item_id || null,
    variant.inventory_quantity || 0,
    variant.harmonized_system_code || null,
    variant.country_code_of_origin || null,
    variant.pick_number || null,
    variant.warehouse_location || null,
    variant.pick_metafield_id || null,
    variant.location_metafield_id || null,
    false // not archived
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

/**
 * Bulk upsert products and variants from Shopify data
 */
async function bulkUpsertProducts(products) {
  const client = await getPool().connect();
  const stats = { products: 0, variants: 0, errors: [] };

  try {
    await client.query('BEGIN');

    for (const product of products) {
      try {
        // Upsert product
        const productQuery = `
          INSERT INTO products (
            shopify_product_id, handle, title, status, vendor, product_type, tags,
            created_at_shopify, updated_at_shopify, last_synced_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          ON CONFLICT (shopify_product_id) DO UPDATE SET
            handle = EXCLUDED.handle,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            vendor = EXCLUDED.vendor,
            product_type = EXCLUDED.product_type,
            tags = EXCLUDED.tags,
            created_at_shopify = EXCLUDED.created_at_shopify,
            updated_at_shopify = EXCLUDED.updated_at_shopify,
            last_synced_at = NOW()
        `;

        await client.query(productQuery, [
          product.id,
          product.handle,
          product.title,
          product.status || 'active',
          product.vendor,
          product.product_type,
          product.tags,
          product.created_at,
          product.updated_at
        ]);
        stats.products++;

        // Upsert each variant
        for (const variant of (product.variants || [])) {
          const variantQuery = `
            INSERT INTO variants (
              shopify_variant_id, shopify_product_id, sku, variant_title, price,
              compare_at_price, weight_grams, barcode, inventory_item_id, inventory_quantity,
              harmonized_system_code, country_code_of_origin, pick_number, warehouse_location,
              pick_metafield_id, location_metafield_id, is_archived, last_synced_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
            ON CONFLICT (shopify_variant_id) DO UPDATE SET
              shopify_product_id = EXCLUDED.shopify_product_id,
              sku = EXCLUDED.sku,
              variant_title = EXCLUDED.variant_title,
              price = EXCLUDED.price,
              compare_at_price = EXCLUDED.compare_at_price,
              weight_grams = EXCLUDED.weight_grams,
              barcode = EXCLUDED.barcode,
              inventory_item_id = EXCLUDED.inventory_item_id,
              inventory_quantity = EXCLUDED.inventory_quantity,
              harmonized_system_code = EXCLUDED.harmonized_system_code,
              country_code_of_origin = EXCLUDED.country_code_of_origin,
              pick_number = COALESCE(EXCLUDED.pick_number, variants.pick_number),
              warehouse_location = COALESCE(EXCLUDED.warehouse_location, variants.warehouse_location),
              pick_metafield_id = COALESCE(EXCLUDED.pick_metafield_id, variants.pick_metafield_id),
              location_metafield_id = COALESCE(EXCLUDED.location_metafield_id, variants.location_metafield_id),
              is_archived = EXCLUDED.is_archived,
              last_synced_at = NOW()
          `;

          await client.query(variantQuery, [
            variant.id,
            product.id,
            variant.sku || null,
            variant.title || 'Default',
            variant.price ? parseFloat(variant.price) : null,
            variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
            variant.weight || variant.grams || null,
            variant.barcode || null,
            variant.inventory_item_id || null,
            variant.inventory_quantity || 0,
            variant.harmonized_system_code || null,
            variant.country_code_of_origin || null,
            variant.pick_number || null,
            variant.warehouse_location || null,
            variant.pick_metafield_id || null,
            variant.location_metafield_id || null,
            false
          ]);
          stats.variants++;
        }
      } catch (err) {
        stats.errors.push({ productId: product.id, error: err.message });
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return stats;
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Get all products with their variants from the database
 */
async function getAllProductsWithVariants(options = {}) {
  const pool = getPool();
  const { includeArchived = false, status = 'active' } = options;

  // Get products
  let productQuery = `
    SELECT * FROM products
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    params.push(status);
    productQuery += ` AND status = $${params.length}`;
  }

  productQuery += ' ORDER BY title';

  const productsResult = await pool.query(productQuery, params);
  const products = productsResult.rows;

  if (products.length === 0) {
    return [];
  }

  // Get variants for all products
  const productIds = products.map(p => p.shopify_product_id);

  let variantQuery = `
    SELECT * FROM variants
    WHERE shopify_product_id = ANY($1)
  `;

  if (!includeArchived) {
    variantQuery += ' AND is_archived = FALSE';
  }

  variantQuery += ' ORDER BY shopify_product_id, variant_title';

  const variantsResult = await pool.query(variantQuery, [productIds]);

  // Group variants by product
  const variantsByProduct = {};
  for (const variant of variantsResult.rows) {
    const pid = variant.shopify_product_id;
    if (!variantsByProduct[pid]) {
      variantsByProduct[pid] = [];
    }
    variantsByProduct[pid].push(variant);
  }

  // Combine products with their variants (format for frontend compatibility)
  return products.map(p => ({
    id: p.shopify_product_id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    created_at: p.created_at_shopify,
    updated_at: p.updated_at_shopify,
    variants: (variantsByProduct[p.shopify_product_id] || []).map(v => ({
      id: v.shopify_variant_id,
      title: v.variant_title,
      sku: v.sku,
      price: v.price ? String(v.price) : '',
      weight: v.weight_grams,
      barcode: v.barcode,
      inventory_item_id: v.inventory_item_id,
      inventory_quantity: v.inventory_quantity,
      harmonized_system_code: v.harmonized_system_code,
      country_code_of_origin: v.country_code_of_origin,
      pick_number: v.pick_number,
      warehouse_location: v.warehouse_location,
      pick_metafield_id: v.pick_metafield_id,
      location_metafield_id: v.location_metafield_id,
      last_synced_at: v.last_synced_at,
      last_shipstation_synced_at: v.last_shipstation_synced_at,
      dirty_flags: v.dirty_flags
    }))
  }));
}

/**
 * Get variant by Shopify variant ID
 */
async function getVariantById(shopifyVariantId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM variants WHERE shopify_variant_id = $1',
    [shopifyVariantId]
  );
  return result.rows[0] || null;
}

/**
 * Update a variant in the database
 */
async function updateVariant(shopifyVariantId, updates) {
  const pool = getPool();

  const fields = [];
  const values = [];
  let paramIndex = 1;

  const allowedFields = [
    'sku', 'variant_title', 'price', 'weight_grams', 'barcode',
    'harmonized_system_code', 'country_code_of_origin',
    'pick_number', 'warehouse_location',
    'pick_metafield_id', 'location_metafield_id',
    'last_shipstation_synced_at', 'dirty_flags', 'is_archived'
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (fields.length === 0) {
    return null;
  }

  values.push(shopifyVariantId);

  const query = `
    UPDATE variants
    SET ${fields.join(', ')}
    WHERE shopify_variant_id = $${paramIndex}
    RETURNING *
  `;

  const result = await pool.query(query, values);
  return result.rows[0] || null;
}

/**
 * Batch update variants
 */
async function batchUpdateVariants(updates) {
  const client = await getPool().connect();
  const results = { updated: 0, failed: 0, errors: [] };

  try {
    await client.query('BEGIN');

    for (const update of updates) {
      try {
        const { id, ...fields } = update;

        const dbFields = {};
        if (fields.sku !== undefined) dbFields.sku = fields.sku;
        if (fields.price !== undefined) dbFields.price = fields.price ? parseFloat(fields.price) : null;
        if (fields.weight !== undefined) dbFields.weight_grams = fields.weight ? parseFloat(fields.weight) : null;
        if (fields.harmonized_system_code !== undefined) dbFields.harmonized_system_code = fields.harmonized_system_code;
        if (fields.country_code_of_origin !== undefined) dbFields.country_code_of_origin = fields.country_code_of_origin;
        if (fields.pick_number !== undefined) dbFields.pick_number = fields.pick_number;
        if (fields.warehouse_location !== undefined) dbFields.warehouse_location = fields.warehouse_location;
        if (fields.pick_metafield_id !== undefined) dbFields.pick_metafield_id = fields.pick_metafield_id;
        if (fields.location_metafield_id !== undefined) dbFields.location_metafield_id = fields.location_metafield_id;

        if (Object.keys(dbFields).length === 0) continue;

        const setClauses = [];
        const values = [];
        let i = 1;

        for (const [key, val] of Object.entries(dbFields)) {
          setClauses.push(`${key} = $${i}`);
          values.push(val);
          i++;
        }

        values.push(id);

        await client.query(
          `UPDATE variants SET ${setClauses.join(', ')} WHERE shopify_variant_id = $${i}`,
          values
        );

        results.updated++;
      } catch (err) {
        results.failed++;
        results.errors.push({ variantId: update.id, error: err.message });
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return results;
}

// ============================================================================
// DUPLICATE & VALIDATION OPERATIONS
// ============================================================================

/**
 * Get duplicate SKUs
 */
async function getDuplicateSkus() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT sku, COUNT(*) as count, array_agg(shopify_variant_id) as variant_ids
    FROM variants
    WHERE sku IS NOT NULL AND sku != '' AND is_archived = FALSE
    GROUP BY sku
    HAVING COUNT(*) > 1
  `);
  return result.rows;
}

/**
 * Get duplicate pick numbers
 */
async function getDuplicatePickNumbers() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT pick_number, COUNT(*) as count, array_agg(shopify_variant_id) as variant_ids, array_agg(sku) as skus
    FROM variants
    WHERE pick_number IS NOT NULL AND pick_number != '' AND is_archived = FALSE
    GROUP BY pick_number
    HAVING COUNT(*) > 1
  `);
  return result.rows;
}

/**
 * Get variants missing required fields
 */
async function getVariantsMissingFields() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      v.shopify_variant_id,
      v.shopify_product_id,
      p.title as product_title,
      v.variant_title,
      v.sku,
      v.pick_number,
      v.warehouse_location,
      CASE WHEN v.sku IS NULL OR v.sku = '' THEN TRUE ELSE FALSE END as missing_sku,
      CASE WHEN v.pick_number IS NULL OR v.pick_number = '' THEN TRUE ELSE FALSE END as missing_pick,
      CASE WHEN v.warehouse_location IS NULL OR v.warehouse_location = '' THEN TRUE ELSE FALSE END as missing_location
    FROM variants v
    JOIN products p ON v.shopify_product_id = p.shopify_product_id
    WHERE v.is_archived = FALSE
      AND p.status = 'active'
      AND (
        v.sku IS NULL OR v.sku = '' OR
        v.pick_number IS NULL OR v.pick_number = '' OR
        v.warehouse_location IS NULL OR v.warehouse_location = ''
      )
  `);
  return result.rows;
}

/**
 * Validate pick number uniqueness for a set of updates
 * Returns list of conflicts: { variantId, pickNumber, conflictsWith: [variantIds] }
 */
async function validatePickNumberUniqueness(updates) {
  const pool = getPool();
  const conflicts = [];

  // Get all pick numbers being set in this batch
  const newPickNumbers = {};
  for (const update of updates) {
    if (update.pick_number && update.pick_number.trim()) {
      const pn = update.pick_number.trim();
      if (!newPickNumbers[pn]) newPickNumbers[pn] = [];
      newPickNumbers[pn].push(update.id);
    }
  }

  // Check for duplicates within the batch itself
  for (const [pn, variantIds] of Object.entries(newPickNumbers)) {
    if (variantIds.length > 1) {
      conflicts.push({
        pickNumber: pn,
        type: 'batch_duplicate',
        variantIds,
        message: `Pick number "${pn}" is assigned to multiple variants in this update`
      });
    }
  }

  // Check against existing database records
  const pickNumbersToCheck = Object.keys(newPickNumbers);
  if (pickNumbersToCheck.length > 0) {
    const result = await pool.query(`
      SELECT pick_number, shopify_variant_id
      FROM variants
      WHERE pick_number = ANY($1)
        AND is_archived = FALSE
        AND shopify_variant_id != ALL($2)
    `, [pickNumbersToCheck, updates.map(u => u.id)]);

    for (const row of result.rows) {
      conflicts.push({
        pickNumber: row.pick_number,
        type: 'existing_duplicate',
        existingVariantId: row.shopify_variant_id,
        newVariantIds: newPickNumbers[row.pick_number],
        message: `Pick number "${row.pick_number}" already exists on variant ${row.shopify_variant_id}`
      });
    }
  }

  return conflicts;
}

// ============================================================================
// SYNC LOG OPERATIONS
// ============================================================================

/**
 * Create a sync log entry
 */
async function createSyncLog(syncType, direction = 'inbound') {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO product_sync_log (sync_type, sync_direction)
    VALUES ($1, $2)
    RETURNING *
  `, [syncType, direction]);
  return result.rows[0];
}

/**
 * Complete a sync log entry
 */
async function completeSyncLog(id, success, counts = {}, errorSummary = null) {
  const pool = getPool();
  const result = await pool.query(`
    UPDATE product_sync_log
    SET finished_at = NOW(), success = $1, counts = $2, error_summary = $3
    WHERE id = $4
    RETURNING *
  `, [success, JSON.stringify(counts), errorSummary, id]);
  return result.rows[0];
}

/**
 * Get last successful sync timestamp
 */
async function getLastSyncTimestamp(syncType = 'full') {
  const pool = getPool();
  const result = await pool.query(`
    SELECT finished_at FROM product_sync_log
    WHERE sync_type = $1 AND success = TRUE
    ORDER BY finished_at DESC
    LIMIT 1
  `, [syncType]);
  return result.rows[0]?.finished_at || null;
}

/**
 * Get sync status summary
 */
async function getSyncStatus() {
  const pool = getPool();

  const lastFullSync = await pool.query(`
    SELECT * FROM product_sync_log
    WHERE sync_type = 'full' AND success = TRUE
    ORDER BY finished_at DESC
    LIMIT 1
  `);

  const lastIncrementalSync = await pool.query(`
    SELECT * FROM product_sync_log
    WHERE sync_type = 'incremental' AND success = TRUE
    ORDER BY finished_at DESC
    LIMIT 1
  `);

  const productCount = await pool.query('SELECT COUNT(*) as count FROM products WHERE status = $1', ['active']);
  const variantCount = await pool.query('SELECT COUNT(*) as count FROM variants WHERE is_archived = FALSE');

  return {
    lastFullSync: lastFullSync.rows[0] || null,
    lastIncrementalSync: lastIncrementalSync.rows[0] || null,
    productCount: parseInt(productCount.rows[0]?.count || 0),
    variantCount: parseInt(variantCount.rows[0]?.count || 0)
  };
}

// ============================================================================
// SHIPSTATION SYNC TRACKING
// ============================================================================

/**
 * Get variants that need ShipStation sync
 */
async function getVariantsNeedingShipStationSync() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT v.*, p.title as product_title
    FROM variants v
    JOIN products p ON v.shopify_product_id = p.shopify_product_id
    WHERE v.is_archived = FALSE
      AND (
        v.dirty_flags->>'shipstation' = 'true'
        OR v.last_shipstation_synced_at IS NULL
      )
      AND v.sku IS NOT NULL AND v.sku != ''
  `);
  return result.rows;
}

/**
 * Mark variants as synced to ShipStation
 */
async function markShipStationSynced(variantIds) {
  const pool = getPool();
  await pool.query(`
    UPDATE variants
    SET last_shipstation_synced_at = NOW(),
        dirty_flags = dirty_flags || '{"shipstation": false}'::jsonb
    WHERE shopify_variant_id = ANY($1)
  `, [variantIds]);
}

/**
 * Mark variants as dirty for ShipStation
 */
async function markShipStationDirty(variantIds) {
  const pool = getPool();
  await pool.query(`
    UPDATE variants
    SET dirty_flags = dirty_flags || '{"shipstation": true}'::jsonb
    WHERE shopify_variant_id = ANY($1)
  `, [variantIds]);
}

// ============================================================================
// DATABASE STATS
// ============================================================================

/**
 * Get comprehensive stats for the product database
 */
async function getStats() {
  const pool = getPool();

  const [
    productCount,
    variantCount,
    duplicateSkus,
    duplicatePickNumbers,
    missingSkuCount,
    missingPickCount,
    missingLocationCount
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) as count FROM products WHERE status = $1', ['active']),
    pool.query('SELECT COUNT(*) as count FROM variants WHERE is_archived = FALSE'),
    getDuplicateSkus(),
    getDuplicatePickNumbers(),
    pool.query(`SELECT COUNT(*) as count FROM variants WHERE is_archived = FALSE AND (sku IS NULL OR sku = '')`),
    pool.query(`SELECT COUNT(*) as count FROM variants v
                JOIN products p ON v.shopify_product_id = p.shopify_product_id
                WHERE v.is_archived = FALSE AND p.status = 'active'
                AND (v.pick_number IS NULL OR v.pick_number = '')`),
    pool.query(`SELECT COUNT(*) as count FROM variants v
                JOIN products p ON v.shopify_product_id = p.shopify_product_id
                WHERE v.is_archived = FALSE AND p.status = 'active'
                AND (v.warehouse_location IS NULL OR v.warehouse_location = '')`)
  ]);

  return {
    productCount: parseInt(productCount.rows[0]?.count || 0),
    variantCount: parseInt(variantCount.rows[0]?.count || 0),
    duplicateSkuCount: duplicateSkus.length,
    duplicatePickNumberCount: duplicatePickNumbers.length,
    missingSkuCount: parseInt(missingSkuCount.rows[0]?.count || 0),
    missingPickCount: parseInt(missingPickCount.rows[0]?.count || 0),
    missingLocationCount: parseInt(missingLocationCount.rows[0]?.count || 0),
    duplicateSkus: duplicateSkus.map(d => d.sku),
    duplicatePickNumbers: duplicatePickNumbers.map(d => d.pick_number)
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Configuration
  METAFIELD_CONFIG,

  // Connection
  getPool,
  runMigrations,

  // Product operations
  upsertProduct,
  upsertVariant,
  bulkUpsertProducts,

  // Query operations
  getAllProductsWithVariants,
  getVariantById,
  updateVariant,
  batchUpdateVariants,

  // Validation
  getDuplicateSkus,
  getDuplicatePickNumbers,
  getVariantsMissingFields,
  validatePickNumberUniqueness,

  // Sync log
  createSyncLog,
  completeSyncLog,
  getLastSyncTimestamp,
  getSyncStatus,

  // ShipStation sync
  getVariantsNeedingShipStationSync,
  markShipStationSynced,
  markShipStationDirty,

  // Stats
  getStats
};
