-- Migration: 001_create_products_tables.sql
-- Creates the products, variants, and sync_log tables for the product database

-- ============================================================================
-- PRODUCTS TABLE
-- ============================================================================
-- Stores Shopify product data for local caching and warehouse management
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    shopify_product_id BIGINT NOT NULL UNIQUE,
    handle TEXT,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',        -- active, draft, archived
    vendor TEXT,
    product_type TEXT,
    tags TEXT,
    created_at_shopify TIMESTAMPTZ,
    updated_at_shopify TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_shopify_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_handle ON products(handle);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- ============================================================================
-- VARIANTS TABLE
-- ============================================================================
-- Stores Shopify variant data with warehouse management fields
CREATE TABLE IF NOT EXISTS variants (
    id SERIAL PRIMARY KEY,
    shopify_variant_id BIGINT NOT NULL UNIQUE,
    shopify_product_id BIGINT NOT NULL REFERENCES products(shopify_product_id) ON DELETE CASCADE,

    -- Core Shopify fields
    sku TEXT,
    variant_title TEXT,
    price NUMERIC(10, 2),
    compare_at_price NUMERIC(10, 2),
    weight_grams NUMERIC(10, 2),
    barcode TEXT,
    inventory_item_id BIGINT,
    inventory_quantity INTEGER DEFAULT 0,

    -- Customs/shipping fields
    harmonized_system_code TEXT,
    country_code_of_origin TEXT,

    -- NEW: Warehouse management fields (from Shopify metafields)
    pick_number TEXT,              -- Pick number for warehouse location
    warehouse_location TEXT,        -- Warehouse shelf/bin location

    -- Metafield IDs for tracking (so updates don't require extra lookup)
    pick_metafield_id BIGINT,
    location_metafield_id BIGINT,

    -- Sync state tracking
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    last_shipstation_synced_at TIMESTAMPTZ,

    -- Dirty flags as JSONB for flexibility
    -- e.g., {"shopify": false, "shipstation": true}
    dirty_flags JSONB DEFAULT '{"shopify": false, "shipstation": false}'::jsonb,

    -- Soft delete for archived variants
    is_archived BOOLEAN DEFAULT FALSE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for variants
CREATE INDEX IF NOT EXISTS idx_variants_shopify_variant_id ON variants(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_variants_shopify_product_id ON variants(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants(sku);
CREATE INDEX IF NOT EXISTS idx_variants_pick_number ON variants(pick_number);
CREATE INDEX IF NOT EXISTS idx_variants_warehouse_location ON variants(warehouse_location);
CREATE INDEX IF NOT EXISTS idx_variants_is_archived ON variants(is_archived);

-- ============================================================================
-- PICK NUMBER DUPLICATE HANDLING APPROACH
-- ============================================================================
-- We use APPLICATION-LEVEL validation only (no DB unique constraint) because:
-- 1. Existing Shopify data may have duplicates that must be imported
-- 2. The system should flag duplicates in the UI, not crash on import
-- 3. NEW duplicates are prevented via application validation before save
--
-- A partial unique index could be added AFTER duplicates are resolved:
-- CREATE UNIQUE INDEX idx_variants_pick_number_unique
--     ON variants(pick_number)
--     WHERE pick_number IS NOT NULL AND pick_number != '' AND is_archived = FALSE;
-- ============================================================================

-- ============================================================================
-- SYNC LOG TABLE
-- ============================================================================
-- Tracks sync operations for auditing and debugging
CREATE TABLE IF NOT EXISTS product_sync_log (
    id SERIAL PRIMARY KEY,
    sync_type TEXT NOT NULL,          -- 'full', 'incremental', 'shopify_to_db', 'db_to_shipstation'
    sync_direction TEXT,              -- 'inbound' (Shopify->DB), 'outbound' (DB->Shopify/ShipStation)
    started_at TIMESTAMPTZ DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    success BOOLEAN DEFAULT FALSE,
    error_summary TEXT,
    counts JSONB,                     -- {"products_synced": 100, "variants_synced": 250, "errors": 2}
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_sync_log_type ON product_sync_log(sync_type);
CREATE INDEX IF NOT EXISTS idx_product_sync_log_started ON product_sync_log(started_at DESC);

-- ============================================================================
-- METAFIELD CONFIGURATION TABLE (optional but useful)
-- ============================================================================
-- Stores configurable metafield namespaces and keys
CREATE TABLE IF NOT EXISTS metafield_config (
    id SERIAL PRIMARY KEY,
    field_name TEXT NOT NULL UNIQUE,   -- 'pick_number', 'warehouse_location'
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    type TEXT NOT NULL,                -- 'single_line_text_field', 'number_integer', etc.
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default metafield configurations (can be customized via env vars)
INSERT INTO metafield_config (field_name, namespace, key, type) VALUES
    ('pick_number', 'custom', 'pick_number', 'single_line_text_field'),
    ('warehouse_location', 'custom', 'warehouse_location', 'single_line_text_field')
ON CONFLICT (field_name) DO NOTHING;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for auto-updating updated_at
DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_variants_updated_at ON variants;
CREATE TRIGGER update_variants_updated_at
    BEFORE UPDATE ON variants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEW FOR DUPLICATE PICK NUMBERS
-- ============================================================================
-- Useful for quickly identifying duplicates in the UI
CREATE OR REPLACE VIEW duplicate_pick_numbers AS
SELECT
    pick_number,
    COUNT(*) as count,
    array_agg(shopify_variant_id) as variant_ids,
    array_agg(sku) as skus
FROM variants
WHERE pick_number IS NOT NULL
  AND pick_number != ''
  AND is_archived = FALSE
GROUP BY pick_number
HAVING COUNT(*) > 1;

-- ============================================================================
-- VIEW FOR VARIANTS MISSING REQUIRED FIELDS
-- ============================================================================
CREATE OR REPLACE VIEW variants_missing_fields AS
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
  AND p.status = 'active';

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE products IS 'Cached Shopify products for the Hemlock & Oak admin tool';
COMMENT ON TABLE variants IS 'Cached Shopify variants with warehouse management fields';
COMMENT ON TABLE product_sync_log IS 'Audit log for product sync operations';
COMMENT ON TABLE metafield_config IS 'Configurable Shopify metafield namespaces and keys';
COMMENT ON COLUMN variants.pick_number IS 'Warehouse pick number from Shopify metafield';
COMMENT ON COLUMN variants.warehouse_location IS 'Warehouse shelf/bin location from Shopify metafield';
COMMENT ON COLUMN variants.dirty_flags IS 'JSON object tracking which systems need updates: {"shopify": bool, "shipstation": bool}';
