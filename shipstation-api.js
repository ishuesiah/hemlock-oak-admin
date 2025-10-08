'use strict';

const axios = require('axios');

class ShipStationAPI {
  constructor() {
    this.key = process.env.SHIPSTATION_API_KEY;
    this.secret = process.env.SHIPSTATION_API_SECRET;
    if (!this.key || !this.secret) {
      throw new Error('Missing ShipStation credentials. Set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET in .env');
    }
    this.client = axios.create({
      baseURL: 'https://ssapi.shipstation.com',
      headers: { 'Content-Type': 'application/json' },
      auth: { username: this.key, password: this.secret }
    });
  }

  // Helper for retry logic on rate limits
  async retryWithBackoff(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (err.response?.status === 429 && i < maxRetries - 1) {
          const backoff = Math.pow(2, i) * 2000; // 2s, 4s, 8s
          console.log(`Rate limited, waiting ${backoff}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }
  }

  // ===== Orders =====
  async getOrder(orderId) {
    return this.retryWithBackoff(async () => {
      const { data } = await this.client.get(`/orders/${encodeURIComponent(orderId)}`);
      return data;
    });
  }

  // Create or Update an order. If body contains orderId, it updates that order in-place.
  async createOrUpdateOrder(orderBody) {
    const { data } = await this.client.post('/orders/createorder', orderBody);
    return data;
  }

  // Robust list/search that tolerates different shapes {orders|results|items|[]}
  async searchOrders(params = {}) {
    const { data } = await this.client.get('/orders', { params });
    const list =
      Array.isArray(data?.orders) ? data.orders :
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.items)   ? data.items   :
      Array.isArray(data)          ? data         : [];
    return list;
  }

  async getOrderByNumber(orderNumber) {
    const list = await this.searchOrders({ orderNumber: String(orderNumber) });
    return list[0] || null;
  }

  async getOrderByKey(orderKey) {
    const list = await this.searchOrders({ orderKey: String(orderKey) });
    return list[0] || null;
  }

  // ===== NEW: Customer Tag Management =====
  
  /**
   * Search for orders by customer email
   * @param {string} customerEmail - The customer's email address
   * @param {object} additionalParams - Optional additional search parameters
   * @returns {Promise<Array>} Array of orders for this customer
   */
  async getOrdersByCustomerEmail(customerEmail, additionalParams = {}) {
    return this.retryWithBackoff(async () => {
      // ShipStation uses 'customerEmail' parameter for order search
      const params = {
        customerEmail: customerEmail.trim(),
        pageSize: 500, // Get up to 500 orders per request
        ...additionalParams
      };
      
      const orders = await this.searchOrders(params);
      console.log(`  Found ${orders.length} orders for ${customerEmail}`);
      return orders;
    });
  }

  /**
   * Add a tag to a customer by updating all their orders
   * @param {string} customerEmail - Customer's email
   * @param {string} tag - Tag to add (e.g., "2026VIP")
   * @param {object} options - Options for filtering orders
   * @returns {Promise<object>} Summary of updates
   */
  async addCustomerTag(customerEmail, tag, options = {}) {
    const {
      onlyAwaitingShipment = false, // Only tag orders that haven't shipped
      skipCancelled = true           // Skip cancelled orders
    } = options;

    try {
      // Get all orders for this customer
      const orders = await this.getOrdersByCustomerEmail(customerEmail);
      
      if (orders.length === 0) {
        return {
          customerEmail,
          ordersFound: 0,
          ordersUpdated: 0,
          ordersSkipped: 0,
          errors: []
        };
      }

      let updated = 0;
      let skipped = 0;
      const errors = [];

      // Filter and update each order
      for (const order of orders) {
        try {
          // Skip orders based on options
          if (skipCancelled && order.orderStatus === 'cancelled') {
            skipped++;
            continue;
          }
          
          if (onlyAwaitingShipment && order.orderStatus !== 'awaiting_shipment') {
            skipped++;
            continue;
          }

          // Check if tag already exists
          const existingTags = order.customerTags || [];
          if (existingTags.includes(tag)) {
            skipped++;
            continue; // Tag already present, skip
          }

          // Add the new tag to existing tags
          const newTags = [...existingTags, tag];

          // Update the order with the new tag
          await this.updateOrderTags(order.orderId, newTags);
          updated++;

          // Rate limiting: ShipStation allows ~40 requests/minute
          // Add a small delay to be safe
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (orderError) {
          errors.push({
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            error: orderError.message
          });
        }
      }

      return {
        customerEmail,
        ordersFound: orders.length,
        ordersUpdated: updated,
        ordersSkipped: skipped,
        errors
      };

    } catch (error) {
      throw new Error(`Failed to add tag for ${customerEmail}: ${error.message}`);
    }
  }

  /**
   * Update customer tags on a specific order
   * @param {number} orderId - ShipStation order ID
   * @param {Array<string>} tags - Array of tags to set
   * @returns {Promise<object>} Updated order
   */
  async updateOrderTags(orderId, tags) {
    return this.retryWithBackoff(async () => {
      const updatePayload = {
        orderId: orderId,
        customerTags: tags // This is the field ShipStation uses for customer tags
      };

      const { data } = await this.client.post('/orders/createorder', updatePayload);
      return data;
    });
  }

  /**
   * Batch tag multiple customers with the same tag
   * @param {Array<string>} customerEmails - Array of customer emails
   * @param {string} tag - Tag to apply
   * @param {object} options - Tagging options
   * @returns {Promise<object>} Summary of all updates
   */
  async batchTagCustomers(customerEmails, tag, options = {}) {
    const results = {
      totalCustomers: customerEmails.length,
      totalOrdersFound: 0,
      totalOrdersUpdated: 0,
      totalOrdersSkipped: 0,
      successfulCustomers: 0,
      failedCustomers: 0,
      details: [],
      errors: []
    };

    for (const email of customerEmails) {
      try {
        console.log(`Tagging customer: ${email}`);
        const result = await this.addCustomerTag(email, tag, options);
        
        results.totalOrdersFound += result.ordersFound;
        results.totalOrdersUpdated += result.ordersUpdated;
        results.totalOrdersSkipped += result.ordersSkipped;
        
        if (result.ordersFound > 0) {
          results.successfulCustomers++;
        }
        
        results.details.push(result);

        if (result.errors.length > 0) {
          results.errors.push(...result.errors);
        }

      } catch (error) {
        results.failedCustomers++;
        results.errors.push({
          customerEmail: email,
          error: error.message
        });
      }
    }

    return results;
  }

  // ===== Products =====
  async getProductById(productId) {
    const { data } = await this.client.get(`/products/${encodeURIComponent(productId)}`);
    return data;
  }

  async searchProductsByName(name, pageSize = 200, maxPages = 5) {
    const q = String(name || '').trim();
    if (!q) return [];
    const results = [];
    let page = 1;

    while (page <= maxPages) {
      const { data } = await this.client.get('/products', { params: { name: q, page, pageSize } });
      const items =
        Array.isArray(data)            ? data :
        Array.isArray(data?.products)  ? data.products :
        Array.isArray(data?.items)     ? data.items :
        Array.isArray(data?.results)   ? data.results :
        [];
      if (!items.length) break;
      results.push(...items);
      if (items.length < pageSize) break;
      page += 1;
    }
    return results;
  }
}

module.exports = { ShipStationAPI };