// shipstation-api-enhanced-FINAL.js - Following YOUR exact patterns
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

  // Helper for retry logic on rate limits (from your existing code)
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
   * Add a complimentary item to an order - FOLLOWING YOUR EXACT PATTERN
   * Based on the payload structure in your shipstation.js
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
      
      // Step 2: Prepare the new item (matching YOUR patterns with || defaults)
      const itemToAdd = newItem || {
        lineItemKey: `LIST-DEF-${Date.now()}`,
        sku: 'LIST-DEF',
        name: 'Complimentary stickers',
        imageUrl: '',  // Empty string instead of null
        weight: {},    // Empty object instead of null
        quantity: 1,
        unitPrice: 1.00,
        taxAmount: 0,
        shippingAmount: 0,
        warehouseLocation: '',
        options: [],
        productId: null,  // This one can be null as per your code
        fulfillmentSku: 'LIST-DEF',
        adjustment: false,
        upc: ''
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
      
      // Step 5: Create customs items (using the sanitized version)
      const rawCustomsItems = customsManager.createCustomsItems(updatedItems);
      const sanitizedCustoms = customsManager.sanitizeCustomsItems(rawCustomsItems);
      
      // Step 6: Build the COMPLETE payload (matching YOUR shipstation.js pattern exactly)
      const payload = {
        // Primary identifiers
        orderId: existingOrder.orderId,
        orderKey: existingOrder.orderKey,
        orderNumber: existingOrder.orderNumber,
        
        // All dates
        orderDate: existingOrder.orderDate,
        paymentDate: existingOrder.paymentDate || existingOrder.orderDate,
        shipByDate: existingOrder.shipByDate,
        
        // Status
        orderStatus: existingOrder.orderStatus,
        
        // Customer
        customerUsername: existingOrder.customerUsername || '',
        customerEmail: existingOrder.customerEmail || '',
        customerId: existingOrder.customerId,
        
        // Addresses
        billTo: existingOrder.billTo,
        shipTo: existingOrder.shipTo,
        
        // Financial - Update orderTotal to include new item
        orderTotal: (existingOrder.orderTotal || 0) + itemToAdd.unitPrice,
        amountPaid: existingOrder.amountPaid || 0,
        taxAmount: existingOrder.taxAmount || 0,
        shippingAmount: existingOrder.shippingAmount || 0,
        
        // Notes - Add tracking note for the addition
        customerNotes: existingOrder.customerNotes || '',
        internalNotes: existingOrder.internalNotes 
          ? `${existingOrder.internalNotes}\n[Auto-added: ${itemToAdd.name} on ${new Date().toISOString()}]`
          : `[Auto-added: ${itemToAdd.name} on ${new Date().toISOString()}]`,
        
        // Gift
        gift: existingOrder.gift || false,
        giftMessage: existingOrder.giftMessage || '',
        
        // Payment
        paymentMethod: existingOrder.paymentMethod || '',
        
        // Shipping
        requestedShippingService: existingOrder.requestedShippingService,
        carrierCode: existingOrder.carrierCode,
        serviceCode: existingOrder.serviceCode,
        packageCode: existingOrder.packageCode,
        confirmation: existingOrder.confirmation,
        shipDate: existingOrder.shipDate,
        
        // Physical
        weight: existingOrder.weight || {},
        dimensions: existingOrder.dimensions || {},
        
        // Options
        insuranceOptions: existingOrder.insuranceOptions || {},
        advancedOptions: existingOrder.advancedOptions || {},
        tagIds: existingOrder.tagIds || [],
        
        // Items - UPDATED with new item, following YOUR exact pattern
        items: updatedItems.map(item => ({
          orderItemId: item.orderItemId,
          lineItemKey: item.lineItemKey || '',
          sku: item.sku || '',
          name: item.name || '',
          imageUrl: item.imageUrl || '',
          weight: item.weight || {},
          quantity: item.quantity || 1,
          unitPrice: item.unitPrice || 0,
          taxAmount: item.taxAmount || 0,
          shippingAmount: item.shippingAmount || 0,
          warehouseLocation: item.warehouseLocation || '',
          options: item.options || [],
          productId: item.productId,  // Can be null
          fulfillmentSku: item.fulfillmentSku || '',
          adjustment: item.adjustment || false,
          upc: item.upc || ''
        })),
        
        // International with SANITIZED customs (following YOUR pattern)
        internationalOptions: {
          contents: existingOrder.internationalOptions?.contents || 'merchandise',
          nonDelivery: existingOrder.internationalOptions?.nonDelivery || 'return_to_sender',
          customsItems: sanitizedCustoms  // Using sanitized customs items
        }
      };
      
      // Step 7: Update the order via API
      console.log(`[ShipStation] Updating order with ${updatedItems.length} items and ${sanitizedCustoms.length} customs declarations`);
      
      const { data } = await this.client.post('/orders/createorder', payload);
      
      console.log(`[ShipStation] ✅ Successfully updated order ${orderNumber}`);
      
      return {
        success: true,
        message: `Added ${itemToAdd.name} to order ${orderNumber}`,
        itemsCount: updatedItems.length,
        customsCount: sanitizedCustoms.length,
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
   * Update only the customs declarations for an order
   */
  async updateOrderCustomsDeclarations(orderNumber) {
    try {
      console.log(`[ShipStation] Updating customs declarations for order: ${orderNumber}`);
      
      // Get the existing order
      const existingOrder = await this.getOrderByNumber(orderNumber);
      if (!existingOrder) {
        throw new Error(`Order ${orderNumber} not found`);
      }
      
      // Create and sanitize customs items
      const rawCustomsItems = customsManager.createCustomsItems(existingOrder.items || []);
      const sanitizedCustoms = customsManager.sanitizeCustomsItems(rawCustomsItems);
      
      // Prepare COMPLETE payload (ShipStation needs the full order)
      const payload = {
        orderId: existingOrder.orderId,
        orderKey: existingOrder.orderKey,
        orderNumber: existingOrder.orderNumber,
        internationalOptions: {
          contents: existingOrder.internationalOptions?.contents || 'merchandise',
          nonDelivery: existingOrder.internationalOptions?.nonDelivery || 'return_to_sender',
          customsItems: sanitizedCustoms
        }
      };
      
      const { data } = await this.client.post('/orders/createorder', payload);
      
      return {
        success: true,
        message: `Updated customs for order ${orderNumber}`,
        customsCount: sanitizedCustoms.length,
        order: data
      };
      
    } catch (error) {
      console.error(`[ShipStation] Error updating customs:`, error.message);
      throw error;
    }
  }
}

module.exports = { ShipStationAPIEnhanced };