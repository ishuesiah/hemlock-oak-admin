// shipstation-add-item.js - FINAL WORKING VERSION - All-in-one solution
'use strict';

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ========== CUSTOMS MANAGER ==========
class CustomsManager {
  constructor() {
    this.customsData = new Map();
    this.loaded = false;
  }

  async loadCUSMADatabase(csvPath) {
    try {
      console.log('[CustomsManager] Loading CUSMA database from:', csvPath);
      const fileContent = await fs.readFile(csvPath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());
      
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const customsInfo = {
          sku: values[0],
          description: values[1] || 'General merchandise',
          tariffNumber: values[2] || '9999999999',
          countryOfOrigin: values[3] || 'CA'
        };
        this.customsData.set(customsInfo.sku.toUpperCase(), customsInfo);
      }
      
      // Add sticker item
      this.customsData.set('LIST-DEF', {
        sku: 'LIST-DEF',
        description: 'Paper sticker',
        tariffNumber: '4911998000',
        countryOfOrigin: 'CA'
      });
      
      this.loaded = true;
      console.log(`[CustomsManager] Loaded ${this.customsData.size} customs entries`);
      return true;
    } catch (error) {
      console.error('[CustomsManager] Error:', error.message);
      return false;
    }
  }

  getCustomsInfo(sku) {
    const upperSku = sku.toUpperCase();
    if (this.customsData.has(upperSku)) {
      return this.customsData.get(upperSku);
    }
    
    // Try base SKU
    const baseSku = upperSku.split('-').slice(0, -1).join('-');
    if (baseSku && this.customsData.has(baseSku)) {
      return this.customsData.get(baseSku);
    }
    
    // Default
    return {
      sku,
      description: 'General merchandise',
      tariffNumber: '9999999999',
      countryOfOrigin: 'CA'
    };
  }

  createCustomsItems(orderItems) {
    const customsItems = [];
    
    for (const item of orderItems) {
      const customsInfo = this.getCustomsInfo(item.sku || item.lineItemKey || '');
      
      const customsItem = {
        description: customsInfo.description || 'General merchandise',
        quantity: parseInt(item.quantity) || 1,
        value: parseFloat(item.unitPrice || item.price) || 0,
        harmonizedTariffCode: customsInfo.tariffNumber || '9999999999',
        countryOfOrigin: customsInfo.countryOfOrigin || 'CA'
      };
      
      // CRITICAL FIX: Only add customsItemId if valid
      if (item.orderItemId) {
        const itemId = parseInt(item.orderItemId);
        if (!isNaN(itemId) && itemId > 0) {
          customsItem.customsItemId = itemId;
        }
      }
      // If not valid, we DON'T include the field at all
      
      customsItems.push(customsItem);
    }
    
    return customsItems;
  }
}

// ========== SHIPSTATION API ==========
class ShipStationAPI {
  constructor() {
    this.key = process.env.SHIPSTATION_API_KEY;
    this.secret = process.env.SHIPSTATION_API_SECRET;
    if (!this.key || !this.secret) {
      throw new Error('Missing ShipStation credentials in .env');
    }
    this.client = axios.create({
      baseURL: 'https://ssapi.shipstation.com',
      headers: { 'Content-Type': 'application/json' },
      auth: { username: this.key, password: this.secret }
    });
    
    // Initialize customs manager
    this.customsManager = new CustomsManager();
  }

  async loadCUSMA(csvPath) {
    return await this.customsManager.loadCUSMADatabase(csvPath);
  }

  // Helper for retry logic on rate limits
  async retryWithBackoff(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (err.response?.status === 429 && i < maxRetries - 1) {
          const backoff = Math.pow(2, i) * 2000; // 2s, 4s, 8s
          console.log(`[ShipStation] Rate limited, waiting ${backoff}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }
  }

  async getOrderByNumber(orderNumber) {
    const { data } = await this.client.get('/orders', {
      params: { orderNumber: String(orderNumber) }
    });

    const orders = Array.isArray(data?.orders) ? data.orders :
                   Array.isArray(data) ? data : [];

    return orders[0] || null;
  }

  async getUnfulfilledOrders(page = 1, pageSize = 500) {
    try {
      console.log(`[ShipStation] Fetching unfulfilled orders (page ${page}, size ${pageSize})`);

      const { data } = await this.client.get('/orders', {
        params: {
          orderStatus: 'awaiting_shipment',
          page: page,
          pageSize: pageSize,
          sortBy: 'OrderDate',
          sortDir: 'DESC'
        }
      });

      const orders = data?.orders || [];
      console.log(`[ShipStation] Fetched ${orders.length} unfulfilled orders from page ${page}`);

      // Return simplified order data
      return orders.map(order => ({
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        orderKey: order.orderKey,
        orderDate: order.orderDate,
        orderStatus: order.orderStatus,
        customerName: order.shipTo?.name || 'Unknown',
        customerEmail: order.customerEmail,
        orderTotal: order.orderTotal,
        shippingAmount: order.shippingAmount,
        itemCount: order.items?.length || 0,
        shipTo: order.shipTo,
        items: order.items
      }));
    } catch (error) {
      console.error('[ShipStation] Error fetching unfulfilled orders:', error.message);
      throw error;
    }
  }

  async getAllUnfulfilledOrders() {
    try {
      console.log('[ShipStation] Fetching ALL unfulfilled orders (all pages)...');

      let allOrders = [];
      let page = 1;
      let hasMore = true;
      const pageSize = 500; // ShipStation max

      while (hasMore) {
        const orders = await this.getUnfulfilledOrders(page, pageSize);

        if (orders.length > 0) {
          allOrders = allOrders.concat(orders);
          console.log(`[ShipStation] Total so far: ${allOrders.length} orders`);
        }

        // If we got less than pageSize, we're done
        hasMore = orders.length === pageSize;

        if (hasMore) {
          page++;
          // Rate limiting - wait 1 second between pages
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`[ShipStation] ✅ Fetched ${allOrders.length} total unfulfilled orders across ${page} page(s)`);
      return allOrders;
    } catch (error) {
      console.error('[ShipStation] Error fetching all unfulfilled orders:', error.message);
      throw error;
    }
  }

  async addItemToOrder(orderNumber, newItem = null) {
    try {
      console.log(`[ShipStation] Adding item to order: ${orderNumber}`);
      
      // Get existing order
      const existingOrder = await this.getOrderByNumber(orderNumber);
      if (!existingOrder) {
        throw new Error(`Order ${orderNumber} not found`);
      }
      
      console.log(`[ShipStation] Found order with ${existingOrder.items?.length || 0} items`);
      
      // Prepare new item with defaults or custom values
      const itemToAdd = {
        lineItemKey: newItem?.lineItemKey || `${newItem?.sku || 'LIST-DEF'}-${Date.now()}`,
        sku: newItem?.sku || 'LIST-DEF',
        name: newItem?.name || 'Complimentary stickers',
        imageUrl: newItem?.imageUrl || '',
        weight: newItem?.weight || {},
        quantity: newItem?.quantity || 2,
        unitPrice: newItem?.price || 0.50,
        taxAmount: newItem?.taxAmount || 0,
        shippingAmount: newItem?.shippingAmount || 0,
        warehouseLocation: newItem?.warehouseLocation || '',
        options: newItem?.options || [],
        productId: newItem?.productId || null,
        fulfillmentSku: newItem?.fulfillmentSku || newItem?.sku || 'LIST-DEF',
        adjustment: newItem?.adjustment || false,
        upc: newItem?.upc || ''
      };
      
      // Check for duplicates
      const existingItems = existingOrder.items || [];
      const alreadyHasItem = existingItems.some(item => 
        item.sku === itemToAdd.sku && item.name === itemToAdd.name
      );
      
      if (alreadyHasItem) {
        console.log(`[ShipStation] Order already has ${itemToAdd.name}`);
        return { success: true, message: 'Item already exists in order' };
      }
      
      // Add new item
      const updatedItems = [...existingItems, itemToAdd];
      
      // Create customs items
      const customsItems = this.customsManager.createCustomsItems(updatedItems);
      
      // Build complete payload
      const payload = {
        orderId: existingOrder.orderId,
        orderKey: existingOrder.orderKey,
        orderNumber: existingOrder.orderNumber,
        orderDate: existingOrder.orderDate,
        paymentDate: existingOrder.paymentDate || existingOrder.orderDate,
        shipByDate: existingOrder.shipByDate,
        orderStatus: existingOrder.orderStatus,
        customerUsername: existingOrder.customerUsername || '',
        customerEmail: existingOrder.customerEmail || '',
        customerId: existingOrder.customerId,
        billTo: existingOrder.billTo,
        shipTo: existingOrder.shipTo,
        orderTotal: (existingOrder.orderTotal || 0) + itemToAdd.unitPrice,
        amountPaid: existingOrder.amountPaid || 0,
        taxAmount: existingOrder.taxAmount || 0,
        shippingAmount: existingOrder.shippingAmount || 0,
        customerNotes: existingOrder.customerNotes || '',
        internalNotes: existingOrder.internalNotes ||'',
        gift: existingOrder.gift || false,
        giftMessage: existingOrder.giftMessage || '',
        paymentMethod: existingOrder.paymentMethod || '',
        requestedShippingService: existingOrder.requestedShippingService,
        carrierCode: existingOrder.carrierCode,
        serviceCode: existingOrder.serviceCode,
        packageCode: existingOrder.packageCode,
        confirmation: existingOrder.confirmation,
        shipDate: existingOrder.shipDate,
        weight: existingOrder.weight || {},
        dimensions: existingOrder.dimensions || {},
        insuranceOptions: existingOrder.insuranceOptions || {},
        advancedOptions: existingOrder.advancedOptions || {},
        tagIds: existingOrder.tagIds || [],
        
        // Items with defaults
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
          productId: item.productId,
          fulfillmentSku: item.fulfillmentSku || '',
          adjustment: item.adjustment || false,
          upc: item.upc || ''
        })),
        
        // International options with customs
        internationalOptions: {
          contents: existingOrder.internationalOptions?.contents || 'merchandise',
          nonDelivery: existingOrder.internationalOptions?.nonDelivery || 'return_to_sender',
          customsItems: customsItems
        }
      };
      
      console.log(`[ShipStation] Updating with ${updatedItems.length} items, ${customsItems.length} customs`);
      
      const { data } = await this.client.post('/orders/createorder', payload);
      
      console.log(`[ShipStation] ✅ Successfully updated order ${orderNumber}`);
      
      return {
        success: true,
        message: `Added ${itemToAdd.name} to order ${orderNumber}`,
        itemsCount: updatedItems.length,
        customsCount: customsItems.length
      };
      
    } catch (error) {
      console.error('[ShipStation] Error:', error.message);
      if (error.response?.data) {
        console.error('[ShipStation] API Error:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Add a tag to an order by order number
   * @param {string} orderNumber - Order number
   * @param {string} tagName - Tag name to add
   * @returns {Promise<object>} Result of operation
   */
  async addTagToOrder(orderNumber, tagName) {
    try {
      console.log(`[ShipStation] Adding tag "${tagName}" to order ${orderNumber}`);

      // Get order to get orderId
      const order = await this.getOrderByNumber(orderNumber);
      if (!order) {
        throw new Error(`Order ${orderNumber} not found`);
      }

      // Get or create tag
      const { data: tags } = await this.client.get('/accounts/listtags');
      let tag = tags.find(t => t.name === tagName);

      if (!tag) {
        // Create tag
        const { data: newTag } = await this.client.post('/accounts/createtag', { name: tagName });
        tag = newTag;
        console.log(`[ShipStation] Created new tag: ${tagName} (ID: ${tag.tagId})`);
      } else {
        console.log(`[ShipStation] Using existing tag: ${tagName} (ID: ${tag.tagId})`);
      }

      // Add tag to order
      await this.client.post('/orders/addtag', {
        orderId: order.orderId,
        tagId: tag.tagId
      });

      console.log(`[ShipStation] ✅ Successfully added tag "${tagName}" to order ${orderNumber}`);

      return {
        success: true,
        orderNumber,
        tagName,
        tagId: tag.tagId
      };

    } catch (error) {
      console.error(`[ShipStation] Error adding tag to order ${orderNumber}:`, error.message);
      throw error;
    }
  }

  /**
   * Add a tag to an order by orderId (faster, no lookup needed)
   * @param {number} orderId - ShipStation order ID
   * @param {string} tagName - Tag name to add
   * @returns {Promise<object>} Result of operation
   */
  async addTagToOrderById(orderId, tagName) {
    return this.retryWithBackoff(async () => {
      console.log(`[ShipStation] Adding tag "${tagName}" to order ID ${orderId}`);

      // Get or create tag
      const { data: tags } = await this.client.get('/accounts/listtags');
      let tag = tags.find(t => t.name === tagName);

      if (!tag) {
        // Create tag
        const { data: newTag } = await this.client.post('/accounts/createtag', { name: tagName });
        tag = newTag;
        console.log(`[ShipStation] Created new tag: ${tagName} (ID: ${tag.tagId})`);
      } else {
        console.log(`[ShipStation] Using existing tag: ${tagName} (ID: ${tag.tagId})`);
      }

      // Add tag to order using ShipStation's addtag endpoint
      const payload = {
        orderId: orderId,
        tagId: tag.tagId
      };

      const { data } = await this.client.post('/orders/addtag', payload);

      console.log(`[ShipStation] ✅ Successfully added tag "${tagName}" to order ID ${orderId}`);

      return {
        success: true,
        orderId,
        tagName,
        tagId: tag.tagId,
        data
      };
    });
  }
}

// ========== TEST FUNCTION ==========
async function testOrder46993() {
  console.log('🔧 Testing Order 46993 - ALL-IN-ONE VERSION\n');
  console.log('='.repeat(60));
  
  try {
    // Initialize API
    const api = new ShipStationAPI();
    
    // Load CUSMA database
    const loaded = await api.loadCUSMA('./data/CUSMA.csv');
    console.log(loaded ? '✅ CUSMA loaded' : '⚠️ Using defaults');
    
    // Test the order
    console.log('\n📦 Adding item to order 46993...\n');
    const result = await api.addItemToOrder('46993');
    
    if (result.success) {
      console.log('✅ SUCCESS!');
      console.log(`   Message: ${result.message}`);
      console.log(`   Items: ${result.itemsCount}`);
      console.log(`   Customs: ${result.customsCount}`);
    }
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
  }
  
  console.log('\n' + '='.repeat(60));
}

// Run if called directly
if (require.main === module) {
  testOrder46993();
}

module.exports = { ShipStationAPI };