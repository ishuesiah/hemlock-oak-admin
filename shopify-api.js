// shopify-api.js - OPTIMIZED - Extended version with customer methods + ORDER NOTES
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

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

    // Shopify REST: ~2 rps; keep it gentle
    this.lastRequestTime = 0;
    this.minRequestInterval = 550;
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
}

module.exports = { ShopifyAPI };