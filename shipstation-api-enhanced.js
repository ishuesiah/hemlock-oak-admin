// shipstation-api-enhanced.js - Enhanced ShipStation API with item addition functionality
'use strict';

const axios = require('axios');
const customsManager = require('./utils/customs-manager');

class ShipStationAPIEnhanced {
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

  /**
   * Get order by order number
   */
  async getOrderByNumber(orderNumber) {
    return this.retryWithBackoff(async () => {
      const { data } = await this.client.get('/orders', {
        params: { orderNumber: String(orderNumber) }
      });
      
      const orders = Array.isArray(data?.orders) ? data.orders :
                     Array.isArray(data) ? data : [];
      
      return orders[0] || null;
    });
  }

  /**
   * Add a complimentary item to an order and update customs declarations
   * @param {string|number} orderNumber - The order number to update
   * @param {object} newItem - The item to add (optional, defaults to stickers)
   * @returns {object} Updated order
   */
  async addItemToOrder(orderNumber, newItem = null) {
    try {
      console.log(`[ShipStation] Adding item to order: ${orderNumber}`);
      
      // Step 1: Get the existing order
      const existingOrder = await this.getOrderByNumber(orderNumber);
      if (!existingOrder) {
        throw new Error(`Order ${orderNumber} not found`);
      }
      
      console.log(`[ShipStation] Found order ${orderNumber} with ${existingOrder.items?.length || 0} items`);
      
      // Step 2: Prepare the new item (default to complimentary stickers)
      const itemToAdd = newItem || {
        lineItemKey: `LIST-DEF-${Date.now()}`, // Unique key for this line item
        sku: 'LIST-DEF',
        name: 'Complimentary stickers',
        imageUrl: null,
        weight: {
          value: 0.1,
          units: 'ounces'
        },
        quantity: 1,
        unitPrice: 1.00,
        taxAmount: 0,
        shippingAmount: 0,
        warehouseLocation: null,
        options: [],
        productId: null,
        fulfillmentSku: 'LIST-DEF',
        adjustment: false,
        upc: null
      };
      
      // Step 3: Check if item already exists (avoid duplicates)
      const existingItems = existingOrder.items || [];
      const alreadyHasItem = existingItems.some(item => 
        item.sku === itemToAdd.sku && item.name === itemToAdd.name
      );
      
      if (alreadyHasItem) {
        console.log(`[ShipStation] Order already has ${itemToAdd.name}, skipping...`);
        return {
          success: true,
          message: 'Item already exists in order',
          order: existingOrder
        };
      }
      
      // Step 4: Add the new item to the items array
      const updatedItems = [...existingItems, itemToAdd];
      
      // Step 5: Create customs items for ALL items (including the new one)
      const customsItems = customsManager.createCustomsItems(updatedItems);
      
      // Step 6: Prepare the update payload
      // We need to send the ENTIRE order with modifications
      const updatePayload = {
        orderId: existingOrder.orderId, // CRITICAL: Include orderId to update existing order
        orderNumber: existingOrder.orderNumber,
        orderKey: existingOrder.orderKey,
        orderDate: existingOrder.orderDate,
        paymentDate: existingOrder.paymentDate,
        shipByDate: existingOrder.shipByDate,
        orderStatus: existingOrder.orderStatus,
        
        // Customer information
        customerId: existingOrder.customerId,
        customerUsername: existingOrder.customerUsername,
        customerEmail: existingOrder.customerEmail,
        
        // Billing address
        billTo: existingOrder.billTo,
        
        // Shipping address
        shipTo: existingOrder.shipTo,
        
        // UPDATED: Items array with new item
        items: updatedItems,
        
        // Order totals (update if needed)
        orderTotal: existingOrder.orderTotal + itemToAdd.unitPrice,
        amountPaid: existingOrder.amountPaid,
        taxAmount: existingOrder.taxAmount,
        shippingAmount: existingOrder.shippingAmount,
        
        // Other order details
        customerNotes: existingOrder.customerNotes,
        internalNotes: existingOrder.internalNotes 
          ? `${existingOrder.internalNotes}\n[Auto-added: ${itemToAdd.name} on ${new Date().toISOString()}]`
          : `[Auto-added: ${itemToAdd.name} on ${new Date().toISOString()}]`,
        gift: existingOrder.gift,
        giftMessage: existingOrder.giftMessage,
        paymentMethod: existingOrder.paymentMethod,
        requestedShippingService: existingOrder.requestedShippingService,
        carrierCode: existingOrder.carrierCode,
        serviceCode: existingOrder.serviceCode,
        packageCode: existingOrder.packageCode,
        confirmation: existingOrder.confirmation,
        shipDate: existingOrder.shipDate,
        weight: existingOrder.weight,
        dimensions: existingOrder.dimensions,
        insuranceOptions: existingOrder.insuranceOptions,
        
        // INTERNATIONAL/CUSTOMS SECTION
        internationalOptions: {
          contents: existingOrder.internationalOptions?.contents || 'merchandise',
          nonDelivery: existingOrder.internationalOptions?.nonDelivery || 'return_to_sender',
          
          // UPDATED: Customs items with proper declarations for all items
          customsItems: customsItems
        },
        
        // Advanced options
        advancedOptions: existingOrder.advancedOptions,
        
        // Tags (preserve existing)
        tagIds: existingOrder.tagIds || []
      };
      
      // Step 7: Update the order via API
      console.log(`[ShipStation] Updating order with ${updatedItems.length} items and ${customsItems.length} customs declarations`);
      
      const { data } = await this.client.post('/orders/createorder', updatePayload);
      
      console.log(`[ShipStation] ✅ Successfully updated order ${orderNumber}`);
      
      return {
        success: true,
        message: `Added ${itemToAdd.name} to order ${orderNumber}`,
        itemsCount: updatedItems.length,
        customsCount: customsItems.length,
        order: data
      };
      
    } catch (error) {
      console.error(`[ShipStation] Error adding item to order:`, error.message);
      if (error.response?.data) {
        console.error(`[ShipStation] API Error Details:`, error.response.data);
      }
      throw error;
    }
  }

  /**
   * Add items to multiple orders in batch
   * @param {array} orderNumbers - Array of order numbers
   * @param {object} newItem - Item to add (optional, defaults to stickers)
   * @returns {object} Summary of results
   */
  async batchAddItemToOrders(orderNumbers, newItem = null) {
    const results = {
      total: orderNumbers.length,
      successful: 0,
      skipped: 0,
      failed: 0,
      details: []
    };
    
    for (const orderNumber of orderNumbers) {
      try {
        console.log(`\n[Batch] Processing order ${orderNumber}...`);
        const result = await this.addItemToOrder(orderNumber, newItem);
        
        if (result.message.includes('already exists')) {
          results.skipped++;
        } else {
          results.successful++;
        }
        
        results.details.push({
          orderNumber,
          status: 'success',
          message: result.message,
          itemsCount: result.itemsCount,
          customsCount: result.customsCount
        });
        
        // Rate limiting between orders
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        results.failed++;
        results.details.push({
          orderNumber,
          status: 'error',
          error: error.message
        });
      }
    }
    
    return results;
  }

  /**
   * Update only the customs declarations for an order (without adding items)
   */
  async updateOrderCustomsDeclarations(orderNumber) {
    try {
      console.log(`[ShipStation] Updating customs declarations for order: ${orderNumber}`);
      
      // Get the existing order
      const existingOrder = await this.getOrderByNumber(orderNumber);
      if (!existingOrder) {
        throw new Error(`Order ${orderNumber} not found`);
      }
      
      // Create customs items for existing items
      const customsItems = customsManager.createCustomsItems(existingOrder.items || []);
      
      // Prepare minimal update payload (only customs)
      const updatePayload = {
        orderId: existingOrder.orderId,
        internationalOptions: {
          contents: existingOrder.internationalOptions?.contents || 'merchandise',
          nonDelivery: existingOrder.internationalOptions?.nonDelivery || 'return_to_sender',
          customsItems: customsItems
        }
      };
      
      const { data } = await this.client.post('/orders/createorder', updatePayload);
      
      return {
        success: true,
        message: `Updated customs for order ${orderNumber}`,
        customsCount: customsItems.length,
        order: data
      };
      
    } catch (error) {
      console.error(`[ShipStation] Error updating customs:`, error.message);
      throw error;
    }
  }
}

module.exports = { ShipStationAPIEnhanced };
