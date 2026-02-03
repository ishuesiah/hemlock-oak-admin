// shopify-api.js - OPTIMIZED - Extended version with customer methods + ORDER NOTES + METAFIELDS
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

// Metafield configuration - configurable via environment variables
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

class ShopifyAPI {
  constructor() {
    this.store = process.env.SHOPIFY_STORE;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = '2024-01';

    if (!this.store || !this.accessToken) {
      throw new Error('Missing Shopify credentials in .env file');
    }

    this.client = axios.create({
      baseURL: `https://${this.store}/admin/api/${this.apiVersion}`,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    });

    // GraphQL client for efficient metafield queries
    this.graphqlClient = axios.create({
      baseURL: `https://${this.store}/admin/api/${this.apiVersion}`,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    });

    // Shopify REST: ~2 rps; keep it gentle
    this.lastRequestTime = 0;
    this.minRequestInterval = 550;

    // Metafield configuration
    this.metafieldConfig = METAFIELD_CONFIG;
  }

  async rateLimit() {
    const now = Date.now();
    const gap = now - this.lastRequestTime;
    if (gap < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - gap));
    }
    this.lastRequestTime = Date.now();
  }

  // -------- Customer Methods -------------------------------------------
  
  /**
   * Get VIP customers (spent > minSpent)
   * PERFORMANCE NOTE: Setting includeOrders=true is VERY SLOW (60+ seconds for 100 customers)
   * because it makes individual API calls for each customer's orders.
   * 
   * @param {number} minSpent - Minimum lifetime spend threshold (default: 1000)
   * @param {boolean} includeOrders - Whether to fetch unfulfilled orders (default: false) - SLOW if true!
   * @returns {Promise<Array>} Array of VIP customer objects
   */
  async getVIPCustomers(minSpent = 1000, includeOrders = false) {
    console.log(`[Shopify API] Fetching VIP customers (min: $${minSpent}, includeOrders: ${includeOrders})`);
    const startTime = Date.now();
    
    // Step 1: Get all customers (this is relatively fast - 5-10 seconds)
    const customers = await this.getAllCustomers();
    console.log(`[Shopify API] Found ${customers.length} total customers in ${Math.round((Date.now() - startTime) / 1000)}s`);
    
    // Step 2: Filter for VIPs based on total_spent
    const vipCustomers = customers.filter(c => 
      parseFloat(c.total_spent || 0) >= minSpent
    );
    console.log(`[Shopify API] Filtered to ${vipCustomers.length} VIP customers`);
    
    // Step 3: Sort by total spent (descending)
    vipCustomers.sort((a, b) => 
      parseFloat(b.total_spent || 0) - parseFloat(a.total_spent || 0)
    );
    
    // Step 4: FAST PATH - Return immediately without order data (recommended)
    if (!includeOrders) {
      const fastResult = vipCustomers.map(customer => ({
        ...customer,
        unfulfilled_orders: [],
        unfulfilled_count: 0,
        unfulfilled_value: 0
      }));
      console.log(`[Shopify API] Returning ${fastResult.length} VIPs without order data (FAST MODE) in ${Math.round((Date.now() - startTime) / 1000)}s`);
      return fastResult;
    }
    
    // Step 5: SLOW PATH - Fetch orders for each VIP (only if explicitly requested)
    console.log(`[Shopify API] WARNING: Fetching unfulfilled orders for ${vipCustomers.length} VIPs (this will be VERY slow - ~60+ seconds)...`);
    const orderFetchStart = Date.now();
    
    const vipWithOrders = await Promise.all(
      vipCustomers.map(async (customer) => {
        await this.rateLimit();
        
        try {
          // Fetch unfulfilled orders for this customer
          const orders = await this.getCustomerOrders(customer.id, 'any');
          const unfulfilledOrders = orders.filter(order => 
            order.fulfillment_status !== 'fulfilled' && 
            order.cancelled_at === null &&
            ['pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded'].includes(order.financial_status)
          );
          
          return {
            ...customer,
            unfulfilled_orders: unfulfilledOrders,
            unfulfilled_count: unfulfilledOrders.length,
            unfulfilled_value: unfulfilledOrders.reduce((sum, order) => 
              sum + parseFloat(order.total_price || 0), 0
            )
          };
        } catch (error) {
          // Log errors but don't fail the entire operation
          console.error(`Error fetching orders for customer ${customer.id}:`, error.message);
          return {
            ...customer,
            unfulfilled_orders: [],
            unfulfilled_count: 0,
            unfulfilled_value: 0
          };
        }
      })
    );
    
    console.log(`[Shopify API] Order fetching took ${Math.round((Date.now() - orderFetchStart) / 1000)}s`);
    console.log(`[Shopify API] Total time: ${Math.round((Date.now() - startTime) / 1000)}s`);
    
    return vipWithOrders;
  }
  
  // Get all customers
  async getAllCustomers() {
    const customers = [];
    let hasNextPage = true;
    let pageInfo = null;
    
    while (hasNextPage) {
      await this.rateLimit();
      const query = pageInfo
        ? `customers.json?limit=250&page_info=${pageInfo}`
        : `customers.json?limit=250`;
      
      const response = await this.client.get(query);
      customers.push(...response.data.customers);
      
      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }
    
    return customers;
  }
  
  // Get orders for a specific customer
  async getCustomerOrders(customerId, status = 'any') {
    await this.rateLimit();
    const response = await this.client.get('/orders.json', {
      params: {
        customer_id: customerId,
        status: status,
        limit: 250
      }
    });
    return response.data.orders || [];
  }

  // -------- Order Note Methods (NEW - For Order Formatter) ------------------------
  
  /**
   * Get order by order number or order name
   * Used by Order Formatter to fetch Shopify internal notes
   * @param {string|number} orderIdentifier - Order number (e.g., "1001") or name (e.g., "#1001")
   * @returns {Object} Shopify order object or null if not found
   */
  async getOrderByNumber(orderIdentifier) {
    try {
      // Ensure order number has # prefix for Shopify API
      let orderNumber = String(orderIdentifier).trim();
      if (!orderNumber.startsWith('#')) {
        orderNumber = '#' + orderNumber;
      }
      
      // Search for order by name (Shopify's order number)
      // Note: "name" in Shopify API must be like "#55534"
      await this.rateLimit();
      const response = await this.client.get('/orders.json', {
        params: {
          name: orderNumber,  // Must include # prefix
          status: 'any'
        }
      });
      
      if (response.data.orders && response.data.orders.length > 0) {
        return response.data.orders[0]; // Return first match
      }
      
      return null;
      
    } catch (error) {
      console.error(`[Shopify API] Failed to get order ${orderIdentifier}:`, error.message);
      return null;
    }
  }
  
  /**
   * Get internal note for an order
   * Fetches the "note" field from Shopify which contains internal CS notes
   * @param {string|number} orderNumber - ShipStation order number (e.g., "1001")
   * @returns {string|null} Internal note text or null if not found
   */
  async getOrderNote(orderNumber) {
    try {
      const order = await this.getOrderByNumber(orderNumber);
      
      if (!order) {
        console.log(`[Shopify API] Order ${orderNumber} not found in Shopify`);
        return null;
      }
      
      // Shopify's "note" field is the internal note
      const note = order.note || '';
      
      if (note) {
        console.log(`[Shopify API] ✅ Found note for order ${orderNumber} (${note.length} chars)`);
      } else {
        console.log(`[Shopify API] No note for order ${orderNumber}`);
      }
      
      return note;
      
    } catch (error) {
      console.error(`[Shopify API] Failed to get note for order ${orderNumber}:`, error.message);
      return null;
    }
  }
  
  /**
   * Batch fetch notes for multiple orders
   * More efficient than calling getOrderNote() individually
   * Includes progress logging and rate limiting
   * @param {Array<string|number>} orderNumbers - Array of order numbers (e.g., ["1001", "1002", "1003"])
   * @returns {Object} Map of orderNumber -> note (e.g., { "1001": "Rush order", "1002": "", "1003": "Gift wrap" })
   */
  async batchGetOrderNotes(orderNumbers) {
    const notes = {};
    
    try {
      console.log(`[Shopify API] Fetching notes for ${orderNumbers.length} orders...`);
      const startTime = Date.now();
      
      for (let i = 0; i < orderNumbers.length; i++) {
        const orderNumber = orderNumbers[i];
        
        try {
          const note = await this.getOrderNote(orderNumber);
          notes[orderNumber] = note || '';
          
          // Progress logging every 10 orders
          if ((i + 1) % 10 === 0) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const rate = ((i + 1) / elapsed).toFixed(1);
            console.log(`[Shopify API] Progress: ${i + 1}/${orderNumbers.length} orders (${rate} orders/sec)`);
          }
          
        } catch (error) {
          console.error(`[Shopify API] Failed to fetch note for order ${orderNumber}:`, error.message);
          notes[orderNumber] = '';
        }
      }
      
      const notesFound = Object.values(notes).filter(n => n).length;
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`[Shopify API] ✅ Fetched ${notesFound}/${orderNumbers.length} notes in ${totalTime}s`);
      
      return notes;
      
    } catch (error) {
      console.error('[Shopify API] Batch fetch failed:', error.message);
      return notes;
    }
  }
  
  /**
   * Check if Shopify API is configured properly
   * Used by Order Formatter to determine if note fetching is available
   * @returns {boolean} true if SHOPIFY_STORE and SHOPIFY_ACCESS_TOKEN are set
   */
  isConfigured() {
    return !!(this.store && this.accessToken);
  }

  // -------- Existing Product Methods (unchanged) ------------------------
  
  async getAllProducts(status = 'active') {
    const products = [];
    let hasNextPage = true;
    let pageInfo = null;
    let pageCount = 0;

    while (hasNextPage) {
      await this.rateLimit();
      const query = pageInfo
        ? `products.json?limit=250&page_info=${pageInfo}`
        : `products.json?limit=250&status=${status}`;

      const response = await this.client.get(query);
      products.push(...response.data.products);
      pageCount++;

      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>]+)>; rel="next"/);
        pageInfo = match ? match[1] : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }

    return products;
  }

  async getAllProductsWithInventory(status = 'active') {
    const products = await this.getAllProducts(status);
    await this.attachInventoryFields(products);
    return products;
  }

  async attachInventoryFields(products) {
    const ids = [];
    products.forEach(p => p.variants.forEach(v => {
      if (v.inventory_item_id) ids.push(v.inventory_item_id);
    }));
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return;

    const invMap = new Map();
    const chunkSize = 50;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const slice = uniqueIds.slice(i, i + chunkSize);
      await this.rateLimit();
      const resp = await this.client.get('/inventory_items.json', {
        params: { ids: slice.join(',') }
      });
      const items = resp.data.inventory_items || [];
      items.forEach(it => invMap.set(it.id, it));
    }

    products.forEach(p => p.variants.forEach(v => {
      const it = invMap.get(v.inventory_item_id);
      if (it) {
        v.harmonized_system_code = it.harmonized_system_code || '';
        v.country_code_of_origin = it.country_code_of_origin || it.country_of_origin || '';
      } else {
        v.harmonized_system_code = v.harmonized_system_code || '';
        v.country_code_of_origin = v.country_code_of_origin || '';
      }
    }));
  }

  async updateVariants(updates) {
    const results = { updated: 0, failed: 0, errors: [] };

    for (const update of updates) {
      await this.rateLimit();

      try {
        const { id, sku, price, weight, harmonized_system_code, country_code_of_origin, ...rest } = update;

        const needsVariantUpdate = (sku !== undefined) || (price !== undefined) || (weight !== undefined) || Object.keys(rest).length > 0;
        const needsInventoryUpdate = (harmonized_system_code !== undefined) || (country_code_of_origin !== undefined);

        if (needsVariantUpdate) {
          const payload = { variant: { id } };
          if (sku !== undefined) payload.variant.sku = sku;
          if (price !== undefined) payload.variant.price = parseFloat(price);
          if (weight !== undefined) {
            payload.variant.weight = parseFloat(weight);
            payload.variant.weight_unit = 'g';
          }
          Object.assign(payload.variant, rest);

          await this.client.put(`/variants/${id}.json`, payload);
        }

        if (needsInventoryUpdate) {
          await this.rateLimit();
          const vResp = await this.client.get(`/variants/${id}.json`);
          const inventoryItemId = vResp.data?.variant?.inventory_item_id;
          if (!inventoryItemId) throw new Error(`No inventory_item_id for variant ${id}`);

          const invPayload = { inventory_item: { id: inventoryItemId } };
          if (harmonized_system_code !== undefined) invPayload.inventory_item.harmonized_system_code = harmonized_system_code || '';
          if (country_code_of_origin !== undefined) invPayload.inventory_item.country_code_of_origin = country_code_of_origin || '';

          await this.rateLimit();
          await this.client.put(`/inventory_items/${inventoryItemId}.json`, invPayload);
        }

        results.updated++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          variantId: update.id,
          error: error.response?.data?.errors || error.message
        });
      }
    }

    return results;
  }

  async getProduct(productId) {
    await this.rateLimit();
    const response = await this.client.get(`/products/${productId}.json`);
    return response.data.product;
  }

  async getVariant(variantId) {
    await this.rateLimit();
    const response = await this.client.get(`/variants/${variantId}.json`);
    return response.data.variant;
  }

  async validateSKUs(products = null) {
    if (!products) products = await this.getAllProducts();
    const skuMap = new Map();
    const duplicates = [];
    const missing = [];

    products.forEach(product => {
      product.variants.forEach(variant => {
        const key = `${product.title} - ${variant.title || 'Default'}`;
        if (!variant.sku || variant.sku.trim() === '') {
          missing.push({ product: product.title, variant: variant.title || 'Default', id: variant.id });
        } else {
          const sku = variant.sku.trim().toUpperCase();
          if (skuMap.has(sku)) duplicates.push({ sku, products: [skuMap.get(sku), key] });
          else skuMap.set(sku, key);
        }
      });
    });

    return {
      total: products.reduce((sum, p) => sum + p.variants.length, 0),
      unique: skuMap.size,
      duplicates,
      missing
    };
  }

  // ============================================================================
  // METAFIELD METHODS (NEW - For Pick Number and Warehouse Location)
  // ============================================================================

  /**
   * GraphQL query to fetch variant metafields efficiently
   * Uses cursor-based pagination for large datasets
   */
  async fetchAllVariantMetafields() {
    console.log('[Shopify API] Fetching variant metafields via GraphQL...');
    const startTime = Date.now();

    const { namespace: pickNs, key: pickKey } = this.metafieldConfig.pick_number;
    const { namespace: locNs, key: locKey } = this.metafieldConfig.warehouse_location;

    const metafieldsMap = new Map(); // variantId -> { pick_number, warehouse_location, pick_metafield_id, location_metafield_id }
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    while (hasNextPage) {
      await this.rateLimit();

      const query = `
        query GetVariantMetafields($cursor: String) {
          productVariants(first: 250, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                legacyResourceId
                sku
                metafields(first: 10, keys: ["${pickNs}.${pickKey}", "${locNs}.${locKey}"]) {
                  edges {
                    node {
                      id
                      namespace
                      key
                      value
                      legacyResourceId
                    }
                  }
                }
              }
            }
          }
        }
      `;

      try {
        const response = await this.graphqlClient.post('/graphql.json', {
          query,
          variables: { cursor }
        });

        const data = response.data.data?.productVariants;
        if (!data) {
          console.error('[Shopify API] GraphQL response missing productVariants:', response.data);
          break;
        }

        for (const edge of data.edges) {
          const variant = edge.node;
          const variantId = variant.legacyResourceId;

          const metafieldData = {
            pick_number: null,
            warehouse_location: null,
            pick_metafield_id: null,
            location_metafield_id: null
          };

          for (const mfEdge of variant.metafields.edges) {
            const mf = mfEdge.node;
            if (mf.namespace === pickNs && mf.key === pickKey) {
              metafieldData.pick_number = mf.value;
              metafieldData.pick_metafield_id = mf.legacyResourceId;
            } else if (mf.namespace === locNs && mf.key === locKey) {
              metafieldData.warehouse_location = mf.value;
              metafieldData.location_metafield_id = mf.legacyResourceId;
            }
          }

          metafieldsMap.set(String(variantId), metafieldData);
        }

        hasNextPage = data.pageInfo.hasNextPage;
        cursor = data.pageInfo.endCursor;
        pageCount++;

        if (pageCount % 5 === 0) {
          console.log(`[Shopify API] Fetched ${metafieldsMap.size} variant metafields (page ${pageCount})...`);
        }
      } catch (error) {
        console.error('[Shopify API] GraphQL metafield fetch error:', error.response?.data || error.message);
        throw error;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Debug: Count how many have actual values
    let withPick = 0, withLoc = 0;
    metafieldsMap.forEach((mf) => {
      if (mf.pick_number) withPick++;
      if (mf.warehouse_location) withLoc++;
    });
    console.log(`[Shopify API] Fetched metafields for ${metafieldsMap.size} variants in ${elapsed}s`);
    console.log(`[Shopify API] DEBUG: Found ${withPick} with pick_number, ${withLoc} with warehouse_location`);

    return metafieldsMap;
  }

  /**
   * Get all products with inventory AND metafields
   * This is the comprehensive data fetch for the product database
   */
  async getAllProductsWithMetafields(status = 'active') {
    console.log('[Shopify API] Fetching all products with inventory and metafields...');
    const startTime = Date.now();

    // Step 1: Get products with inventory (existing method)
    const products = await this.getAllProductsWithInventory(status);
    console.log(`[Shopify API] Fetched ${products.length} products with ${products.reduce((s, p) => s + p.variants.length, 0)} variants`);

    // Step 2: Fetch all variant metafields via GraphQL
    const metafieldsMap = await this.fetchAllVariantMetafields();

    // Step 3: Merge metafields into products
    let metafieldsAttached = 0;
    for (const product of products) {
      for (const variant of product.variants) {
        const mf = metafieldsMap.get(String(variant.id));
        if (mf) {
          variant.pick_number = mf.pick_number;
          variant.warehouse_location = mf.warehouse_location;
          variant.pick_metafield_id = mf.pick_metafield_id;
          variant.location_metafield_id = mf.location_metafield_id;
          metafieldsAttached++;
        } else {
          variant.pick_number = null;
          variant.warehouse_location = null;
          variant.pick_metafield_id = null;
          variant.location_metafield_id = null;
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Shopify API] Complete: ${products.length} products, ${metafieldsAttached} variants with metafields, in ${elapsed}s`);

    return products;
  }

  /**
   * Get metafields for a single variant
   */
  async getVariantMetafields(variantId) {
    await this.rateLimit();

    const { namespace: pickNs, key: pickKey } = this.metafieldConfig.pick_number;
    const { namespace: locNs, key: locKey } = this.metafieldConfig.warehouse_location;

    const query = `
      query GetVariantMetafields($id: ID!) {
        productVariant(id: $id) {
          id
          legacyResourceId
          metafields(first: 10, keys: ["${pickNs}.${pickKey}", "${locNs}.${locKey}"]) {
            edges {
              node {
                id
                namespace
                key
                value
                legacyResourceId
              }
            }
          }
        }
      }
    `;

    try {
      const response = await this.graphqlClient.post('/graphql.json', {
        query,
        variables: { id: `gid://shopify/ProductVariant/${variantId}` }
      });

      const variant = response.data.data?.productVariant;
      if (!variant) return null;

      const result = {
        pick_number: null,
        warehouse_location: null,
        pick_metafield_id: null,
        location_metafield_id: null
      };

      for (const edge of variant.metafields.edges) {
        const mf = edge.node;
        if (mf.namespace === pickNs && mf.key === pickKey) {
          result.pick_number = mf.value;
          result.pick_metafield_id = mf.legacyResourceId;
        } else if (mf.namespace === locNs && mf.key === locKey) {
          result.warehouse_location = mf.value;
          result.location_metafield_id = mf.legacyResourceId;
        }
      }

      return result;
    } catch (error) {
      console.error('[Shopify API] Error fetching variant metafields:', error.message);
      return null;
    }
  }

  /**
   * Update or create a metafield for a variant
   * @param {string} variantId - Shopify variant ID
   * @param {string} fieldName - 'pick_number' or 'warehouse_location'
   * @param {string} value - The value to set
   * @param {string|null} existingMetafieldId - If known, the metafield ID to update
   * @returns {Object} Updated metafield data with id
   */
  async setVariantMetafield(variantId, fieldName, value, existingMetafieldId = null) {
    await this.rateLimit();

    const config = this.metafieldConfig[fieldName];
    if (!config) {
      throw new Error(`Unknown metafield: ${fieldName}`);
    }

    const { namespace, key, type } = config;

    // If value is empty/null, delete the metafield if it exists
    if (!value || value.trim() === '') {
      if (existingMetafieldId) {
        return await this.deleteMetafield(existingMetafieldId);
      }
      return { deleted: true, metafield_id: null };
    }

    // Use GraphQL mutation for creating/updating metafields
    const mutation = `
      mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
            legacyResourceId
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    try {
      const response = await this.graphqlClient.post('/graphql.json', {
        query: mutation,
        variables: {
          metafields: [{
            ownerId: `gid://shopify/ProductVariant/${variantId}`,
            namespace,
            key,
            type,
            value: String(value).trim()
          }]
        }
      });

      const result = response.data.data?.metafieldsSet;
      if (result?.userErrors?.length > 0) {
        throw new Error(result.userErrors.map(e => e.message).join(', '));
      }

      const metafield = result?.metafields?.[0];
      return {
        success: true,
        metafield_id: metafield?.legacyResourceId,
        value: metafield?.value
      };
    } catch (error) {
      console.error(`[Shopify API] Error setting metafield ${fieldName}:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a metafield by ID
   */
  async deleteMetafield(metafieldId) {
    await this.rateLimit();

    try {
      await this.client.delete(`/metafields/${metafieldId}.json`);
      return { deleted: true, metafield_id: null };
    } catch (error) {
      // If 404, metafield already deleted
      if (error.response?.status === 404) {
        return { deleted: true, metafield_id: null };
      }
      throw error;
    }
  }

  /**
   * Update variant with all fields including metafields
   * This is the comprehensive update method for the product database
   */
  async updateVariantWithMetafields(update) {
    const {
      id: variantId,
      sku,
      price,
      weight,
      harmonized_system_code,
      country_code_of_origin,
      pick_number,
      warehouse_location,
      pick_metafield_id,
      location_metafield_id
    } = update;

    const results = {
      variant: { updated: false },
      inventory: { updated: false },
      metafields: { pick_number: null, warehouse_location: null }
    };

    try {
      // 1. Update core variant fields (sku, price, weight)
      const needsVariantUpdate = (sku !== undefined) || (price !== undefined) || (weight !== undefined);
      if (needsVariantUpdate) {
        await this.rateLimit();
        const payload = { variant: { id: variantId } };
        if (sku !== undefined) payload.variant.sku = sku;
        if (price !== undefined) payload.variant.price = parseFloat(price);
        if (weight !== undefined) {
          payload.variant.weight = parseFloat(weight);
          payload.variant.weight_unit = 'g';
        }
        await this.client.put(`/variants/${variantId}.json`, payload);
        results.variant.updated = true;
      }

      // 2. Update inventory fields (HS code, country of origin)
      const needsInventoryUpdate = (harmonized_system_code !== undefined) || (country_code_of_origin !== undefined);
      if (needsInventoryUpdate) {
        await this.rateLimit();
        const vResp = await this.client.get(`/variants/${variantId}.json`);
        const inventoryItemId = vResp.data?.variant?.inventory_item_id;
        if (inventoryItemId) {
          const invPayload = { inventory_item: { id: inventoryItemId } };
          if (harmonized_system_code !== undefined) invPayload.inventory_item.harmonized_system_code = harmonized_system_code || '';
          if (country_code_of_origin !== undefined) invPayload.inventory_item.country_code_of_origin = country_code_of_origin || '';

          await this.rateLimit();
          await this.client.put(`/inventory_items/${inventoryItemId}.json`, invPayload);
          results.inventory.updated = true;
        }
      }

      // 3. Update metafields (pick number, warehouse location)
      if (pick_number !== undefined) {
        const mfResult = await this.setVariantMetafield(variantId, 'pick_number', pick_number, pick_metafield_id);
        results.metafields.pick_number = mfResult;
      }

      if (warehouse_location !== undefined) {
        const mfResult = await this.setVariantMetafield(variantId, 'warehouse_location', warehouse_location, location_metafield_id);
        results.metafields.warehouse_location = mfResult;
      }

      return { success: true, ...results };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.errors || error.message,
        ...results
      };
    }
  }

  /**
   * Batch update variants with metafields
   * Extends the existing updateVariants method to include metafield updates
   */
  async updateVariantsWithMetafields(updates) {
    const results = { updated: 0, failed: 0, errors: [], details: [] };

    for (const update of updates) {
      try {
        const result = await this.updateVariantWithMetafields(update);
        if (result.success) {
          results.updated++;
          results.details.push({
            variantId: update.id,
            success: true,
            ...result
          });
        } else {
          results.failed++;
          results.errors.push({
            variantId: update.id,
            error: result.error
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          variantId: update.id,
          error: error.response?.data?.errors || error.message
        });
      }
    }

    return results;
  }
}

module.exports = { ShopifyAPI, METAFIELD_CONFIG };