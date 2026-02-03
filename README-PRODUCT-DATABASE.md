# Product Database Integration

This document describes the Neon Postgres database integration for the Hemlock & Oak Product Manager.

## Overview

The Product Manager now uses a persistent Postgres database (Neon) to store product and variant data, including warehouse management fields (pick number and warehouse location) that sync to/from Shopify metafields and ShipStation.

## Required Environment Variables

Add these to your `.env` file:

```env
# Neon Postgres Database
PRODUCT_DATABASE_NEON=postgresql://user:pass@host/db?sslmode=require

# Metafield Configuration (optional - defaults shown)
PICK_NUMBER_METAFIELD_NAMESPACE=custom
PICK_NUMBER_METAFIELD_KEY=pick_number
PICK_NUMBER_METAFIELD_TYPE=single_line_text_field
WAREHOUSE_LOCATION_METAFIELD_NAMESPACE=custom
WAREHOUSE_LOCATION_METAFIELD_KEY=warehouse_location
WAREHOUSE_LOCATION_METAFIELD_TYPE=single_line_text_field

# Existing credentials (already configured)
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx
SHIPSTATION_API_KEY=xxxxx
SHIPSTATION_API_SECRET=xxxxx
```

## Installation

1. Install the new dependency:
   ```bash
   npm install
   ```

2. Run database migrations:
   ```bash
   # Via API endpoint (after starting server)
   curl -X POST http://localhost:8080/api/products/db/migrate

   # Or migrations run automatically on first API call
   ```

3. Initial full sync from Shopify:
   ```bash
   # Via API
   curl -X POST http://localhost:8080/api/products/sync -H "Content-Type: application/json" -d '{"mode":"full"}'

   # Or use the "Sync from Shopify" button in the UI
   ```

## Database Schema

### Tables

- **products**: Cached Shopify product data
- **variants**: Cached variant data with warehouse management fields
- **product_sync_log**: Audit log for sync operations
- **metafield_config**: Configurable metafield namespaces/keys

### Key Fields

| Field | Description |
|-------|-------------|
| `pick_number` | Warehouse pick number (from Shopify metafield) |
| `warehouse_location` | Warehouse bin/shelf location (from Shopify metafield) |
| `pick_metafield_id` | Shopify metafield ID for pick number (for efficient updates) |
| `location_metafield_id` | Shopify metafield ID for location |
| `dirty_flags` | JSONB tracking which systems need sync: `{"shopify": false, "shipstation": true}` |

## API Endpoints

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | Get all products from DB |
| GET | `/api/products?source=shopify` | Get directly from Shopify (debug) |
| POST | `/api/products/update` | Update variants (DB + Shopify + track ShipStation dirty) |
| GET | `/api/products/stats` | Get comprehensive statistics |

### Sync Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/products/sync` | Sync from Shopify to DB |
| GET | `/api/products/sync-status` | Get last sync timestamps |
| POST | `/api/products/sync-shipstation` | Sync warehouse locations to ShipStation |
| GET | `/api/products/shipstation-pending` | List variants needing ShipStation sync |

### Validation

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products/duplicates` | Get duplicate SKUs and pick numbers |
| GET | `/api/products/missing` | Get variants missing required fields |
| POST | `/api/products/validate-pick-numbers` | Validate pick number uniqueness |

## Data Flow

### Shopify -> DB Sync
1. Fetch all products via REST API
2. Fetch variant metafields via GraphQL (efficient bulk query)
3. Upsert to Postgres in a transaction
4. Log sync status

### DB -> Shopify Updates (on Save)
1. Validate pick number uniqueness
2. Update Shopify variant (sku, price, weight)
3. Update Shopify inventory item (HS code, country of origin)
4. Create/update metafields (pick number, warehouse location)
5. Update DB with new metafield IDs
6. Mark variants as dirty for ShipStation

### DB -> ShipStation Sync
1. Query dirty variants from DB
2. Upsert products to ShipStation with warehouse location
3. Mark variants as synced

## Pick Number Duplicate Handling

The system uses **application-level validation** rather than a database unique constraint because:

1. Existing Shopify data may contain duplicates that must be imported
2. The system flags duplicates in the UI rather than crashing on import
3. NEW duplicates are prevented via validation before save

Existing duplicates are:
- Imported into the database without crashing
- Flagged with a "DUP PICK" badge in the UI
- Prevented from being saved (new duplicates blocked)

## UI Features

### New Columns
- **Pick #**: Editable pick number from Shopify metafield
- **Location**: Editable warehouse location from Shopify metafield

### New Status Badges
- `DUP SKU` - Duplicate SKU (red)
- `NO SKU` - Missing SKU (orange)
- `DUP PICK` - Duplicate pick number (red)
- `NO PICK` - Missing pick number (purple)
- `NO LOC` - Missing warehouse location (blue)

### New Stats
- Duplicate Pick #
- Missing Pick #
- Missing Location

### New Filters
- Show duplicate pick numbers only
- Show missing pick numbers only
- Show missing locations only

### Sync Buttons
- **Sync from Shopify**: Full sync of products/variants/metafields
- **Sync to ShipStation**: Sync dirty warehouse locations

## Conflict Resolution

| Scenario | Resolution |
|----------|------------|
| Shopify edited directly | DB reflects change on next sync |
| UI edits | Immediately pushed to Shopify, DB updated |
| Both changed | Most recent updated_at wins for core fields; pick/location prefer DB if edited in tool |

## Troubleshooting

### Database not initializing
```bash
# Check connection string
echo $PRODUCT_DATABASE_NEON

# Manual migration
curl -X POST http://localhost:8080/api/products/db/migrate
```

### Metafields not syncing
- Verify metafield namespace/key match your Shopify setup
- Check GraphQL permissions for your Shopify access token
- Ensure `read_products` and `write_products` scopes

### ShipStation sync failing
- Verify ShipStation API credentials
- Check rate limiting (max 40 requests/minute)
- Review error log in UI for specific failures

## Performance Notes

- GraphQL bulk query fetches all variant metafields in ~10 API pages
- DB queries use indexes on `shopify_variant_id`, `sku`, `pick_number`
- ShipStation sync uses 500ms delay between requests to avoid rate limits
