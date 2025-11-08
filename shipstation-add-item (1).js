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
        description: 'Paper sticker',  // Changed to just "Paper sticker"
        tariffNumber: '4911998000',     // Updated HS code
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
    
    // Special handling for LIST-DEF if not in database
    if (upperSku === 'LIST-DEF') {
      return {
        sku: 'LIST-DEF',
        description: 'Paper sticker',  // Just "Paper sticker"
        tariffNumber: '4911998000',     // Updated HS code
        countryOfOrigin: 'CA'
      };
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

  async getOrderByNumber(orderNumber) {
    const { data } = await this.client.get('/orders', {
      params: { orderNumber: String(orderNumber) }
    });
    
    const orders = Array.isArray(data?.orders) ? data.orders :
                   Array.isArray(data) ? data : [];
    
    return orders[0] || null;
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
      
      // Prepare new item
      const itemToAdd = newItem || {
        lineItemKey: `LIST-DEF-${Date.now()}`,
        sku: 'LIST-DEF',
        name: 'Complimentary stickers',
        imageUrl: '',
        weight: {},
        quantity: 1,
        unitPrice: 1.00,
        taxAmount: 0,
        shippingAmount: 0,
        warehouseLocation: '',
        options: [],
        productId: null,
        fulfillmentSku: 'LIST-DEF',
        adjustment: false,
        upc: ''
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
        internalNotes: existingOrder.internalNotes || '',  // Don't add any note
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
}

  // Batch processing method
  async batchAddItemToOrders(orderNumbers) {
    const results = {
      successful: [],
      skipped: [],
      failed: []
    };
    
    console.log(`Processing ${orderNumbers.length} orders...\n`);
    
    for (let i = 0; i < orderNumbers.length; i++) {
      const orderNumber = orderNumbers[i];
      console.log(`[${i + 1}/${orderNumbers.length}] Order ${orderNumber}...`);
      
      try {
        const result = await this.addItemToOrder(orderNumber);
        
        if (result.message.includes('already exists')) {
          console.log(`  ⏩ Skipped - already has item`);
          results.skipped.push(orderNumber);
        } else {
          console.log(`  ✅ Added - ${result.itemsCount} items, ${result.customsCount} customs`);
          results.successful.push(orderNumber);
        }
        
        // Rate limiting
        if (i < orderNumbers.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.log(`  ❌ Failed - ${error.message}`);
        results.failed.push({ orderNumber, error: error.message });
      }
    }
    
    return results;
  }
}

// ========== TEST FUNCTIONS ==========
async function testOrder46993() {
  console.log('🔧 Testing Order 46993 - ALL-IN-ONE VERSION\n');
  console.log('='.repeat(60));
  
  try {
    const api = new ShipStationAPI();
    const loaded = await api.loadCUSMA('./data/CUSMA.csv');
    console.log(loaded ? '✅ CUSMA loaded' : '⚠️ Using defaults');
    
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

async function processBatch() {
  const orderNumbers = [
    '50218', '50175', '51655', '49038', '51150', '50871',
    '49742', '52119', '49124', '50026', '51555', '51104'
  ];
  
  console.log('🎯 BATCH PROCESSING\n');
  console.log('='.repeat(60));
  
  try {
    const api = new ShipStationAPI();
    const loaded = await api.loadCUSMA('./data/CUSMA.csv');
    console.log(loaded ? '✅ CUSMA loaded' : '⚠️ Using defaults');
    console.log('');
    
    const results = await api.batchAddItemToOrders(orderNumbers);
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESULTS:');
    console.log(`✅ Successful: ${results.successful.length}`);
    console.log(`⏩ Skipped: ${results.skipped.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    
    if (results.failed.length > 0) {
      console.log('\nFailed orders:');
      results.failed.forEach(f => console.log(`  ${f.orderNumber}: ${f.error}`));
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
  }
  
  console.log('='.repeat(60));
}

// Run if called directly
if (require.main === module) {
  // Check command line args
  const args = process.argv.slice(2);
  
  if (args[0] === 'batch') {
    processBatch();
  } else if (args[0] === 'test') {
    testOrder46993();
  } else if (args.length > 0) {
    // Process specific order numbers from command line
    console.log(`Processing orders: ${args.join(', ')}\n`);
    const api = new ShipStationAPI();
    api.loadCUSMA('./data/CUSMA.csv').then(() => {
      return api.batchAddItemToOrders(args);
    }).then(results => {
      console.log('\nDone!');
      console.log(`✅ ${results.successful.length} successful`);
      console.log(`⏩ ${results.skipped.length} skipped`);
      console.log(`❌ ${results.failed.length} failed`);
    });
  } else {
    // Default: run batch for your specific orders
    processBatch();
  }
}

module.exports = { ShipStationAPI };