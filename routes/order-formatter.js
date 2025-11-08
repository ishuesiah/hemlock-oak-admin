// routes/order-formatter.js - Bulk order formatting and tagging
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ShipStationAPI } = require('../shipstation-api.js');
const { ShopifyAPI } = require('../shopify-api.js'); 
const shopify = new ShopifyAPI(); // NEW!
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

// Initialize ShipStation API
const shipstation = new ShipStationAPI();

// Load HTML template
const orderFormatterHTML = fs.readFileSync(path.join(__dirname, '../views/order-formatter.html'), 'utf8');

// Main Order Formatter page
router.get('/order-formatter', requireAuth, (req, res) => {
  res.send(orderFormatterHTML);
});

// ===== Helper Functions =====

// Ignore properties (same as Tampermonkey) - MOVED TO MODULE LEVEL
const IGNORE_PROPERTIES = ['Monthly Tabs', 'Brass Pen', 'optionSetId', 'hc_default',
  'addOnVariant', 'itemKey', 'addonChargePrice', 'stringifiedProperties',
  'parentKey', '_', 'Available', 'On Hand'];

/**
 * Remove measurements from text
 * Removes patterns like (8.60mm x 14.99mm) or similar measurement formats
 */
function removeMeasurements(text) {
  if (!text) return text;
  
  // Remove measurements in parentheses
  let cleaned = text.replace(/\([^)]*\d+\.?\d*\s*(mm|cm|m|km|in|inch|inches|ft|feet|foot|"|'|yard|yards|yd|yds)[^)]*\)/gi, '');
  
  // Remove standalone measurement patterns like "8.60mm x 14.99mm"
  cleaned = cleaned.replace(/\d+\.?\d*\s*(mm|cm|m|km|in|inch|inches|ft|feet|foot|"|')\s*[x×]\s*\d+\.?\d*\s*(mm|cm|m|km|in|inch|inches|ft|feet|foot|"|')/gi, '');
  
  // Remove dimensions patterns
  cleaned = cleaned.replace(/\b(width|height|length|size|dimension|diameter|radius)[\s:]*\d+\.?\d*\s*(mm|cm|m|in|inch|inches|ft|feet|foot)/gi, '');
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Parse stringified properties from order items
 * This mimics the Tampermonkey script logic
 */
function parseCustomizations(order) {
  const customizations = [];
  
  if (!order.items || order.items.length === 0) return customizations;
  
  order.items.forEach(item => {
    const itemCustomizations = {};
    
    // Check for properties in options array
    if (item.options && Array.isArray(item.options)) {
      item.options.forEach(option => {
        const label = String(option.name || '').trim();
        const value = String(option.value || '').trim();
        
        // Skip ignored properties
        const shouldIgnore = IGNORE_PROPERTIES.some(ignore =>
          label.toLowerCase().includes(ignore.toLowerCase()) ||
          label === '' || label.startsWith('_')
        );
        
        if (!shouldIgnore && value !== '') {
          // Clean up label
          const cleanLabel = label.replace(' copy', '').trim();
          itemCustomizations[cleanLabel] = value;
        }
      });
    }
    
    // Only add items that have customizations
    if (Object.keys(itemCustomizations).length > 0) {
      customizations.push({
        name: item.name || 'Unknown Item',
        sku: item.sku || '',
        customizations: itemCustomizations
      });
    }
  });
  
  return customizations;
}

/**
 * Format customizations into Gift Note text
 * This matches the Tampermonkey script output format
 */
function formatCustomizations(items) {
  let formatted = 'CUSTOMIZATIONS:\n\n';
  
  items.forEach((item, index) => {
    // Add item name as header
    formatted += `${item.name}\n`;
    
    const customKeys = Object.keys(item.customizations);
    const processedKeys = new Set();
    
    // Check if this is a Daily Duo book
    const isDailyDuo = item.name.toLowerCase().includes('daily duo');
    
    if (isDailyDuo) {
      // Group customizations by book (Daily Duo special handling)
      const bookOneCustomizations = [];
      const bookTwoCustomizations = [];
      const otherCustomizations = [];
      
      customKeys.forEach(key => {
        if (processedKeys.has(key)) return;
        
        let cleanKey = key.replace(' copy', '').replace(/:/g, '').trim();
        let value = item.customizations[key];
        
        // Skip monogram letter for book two
        if (key.toLowerCase().includes('monogram letter for book two')) {
          processedKeys.add(key);
          return;
        }
        
        // Check if it's a BOOK ONE property
        if (cleanKey.toUpperCase().startsWith('BOOK ONE')) {
          let propertyName = cleanKey.replace(/BOOK ONE:?\s*/i, '').trim();
          
          // Handle monogram charm
          if (value.toLowerCase().includes('monogram') && propertyName.toLowerCase().includes('ribbon charm')) {
            const monogramKey = customKeys.find(k => {
              const lowerK = k.toLowerCase();
              return lowerK.includes('book one') &&
                     lowerK.includes('monogram letter') &&
                     !processedKeys.has(k);
            });
            
            if (monogramKey) {
              value = `Monogram Charm ${item.customizations[monogramKey]}`;
              processedKeys.add(monogramKey);
            }
          }
          
          // REMOVE MEASUREMENTS from value
          value = removeMeasurements(value);
          
          bookOneCustomizations.push(`☐ ${propertyName}: ${value}`);
          processedKeys.add(key);
        }
        // Check if it's a BOOK TWO property
        else if (cleanKey.toUpperCase().startsWith('BOOK TWO')) {
          let propertyName = cleanKey.replace(/BOOK TWO:?\s*/i, '').trim();
          
          // Handle monogram charm
          if (value.toLowerCase().includes('monogram') && propertyName.toLowerCase().includes('ribbon charm')) {
            const monogramKey = customKeys.find(k => {
              const lowerK = k.toLowerCase();
              return (lowerK.includes('book two') && lowerK.includes('monogram letter')) ||
                     (lowerK.includes('monogram letter') && lowerK.includes('book two')) ||
                     (lowerK.includes('monogram letter') && lowerK.includes('charm')) &&
                     !processedKeys.has(k);
            });
            
            if (monogramKey) {
              value = `Monogram Charm ${item.customizations[monogramKey]}`;
              processedKeys.add(monogramKey);
            }
          }
          
          // REMOVE MEASUREMENTS from value
          value = removeMeasurements(value);
          
          bookTwoCustomizations.push(`☐ ${propertyName}: ${value}`);
          processedKeys.add(key);
        }
        // Other customizations
        else if (!key.toLowerCase().includes('monogram letter')) {
          // REMOVE MEASUREMENTS from value
          value = removeMeasurements(value);
          otherCustomizations.push(`☐ ${cleanKey}: ${value}`);
          processedKeys.add(key);
        }
      });
      
      // Format output for Daily Duo
      if (bookOneCustomizations.length > 0) {
        formatted += 'BOOK ONE\n';
        bookOneCustomizations.forEach(custom => {
          formatted += custom + '\n';
        });
        if (bookTwoCustomizations.length > 0 || otherCustomizations.length > 0) {
          formatted += '\n';
        }
      }
      
      if (bookTwoCustomizations.length > 0) {
        formatted += 'BOOK TWO\n';
        bookTwoCustomizations.forEach(custom => {
          formatted += custom + '\n';
        });
        if (otherCustomizations.length > 0) {
          formatted += '\n';
        }
      }
      
      if (otherCustomizations.length > 0) {
        otherCustomizations.forEach(custom => {
          formatted += custom + '\n';
        });
      }
    } else {
      // Standard formatting for non-Daily Duo items
      
      // Handle all ribbon charms with their monogram letters
      customKeys.forEach(key => {
        if (key.toLowerCase().includes('ribbon charm') && !processedKeys.has(key)) {
          let cleanKey = key.replace(' copy', '').trim();
          let charmValue = item.customizations[key];
          
          // Check if this is a monogram charm and find its corresponding letter
          if (charmValue.toLowerCase().includes('monogram')) {
            let ribbonNumber = '';
            if (key.toLowerCase().includes('first')) {
              ribbonNumber = 'one';
            } else if (key.toLowerCase().includes('second')) {
              ribbonNumber = 'two';
            } else if (key.toLowerCase().includes('third')) {
              ribbonNumber = 'three';
            }
            
            const monogramKey = customKeys.find(k =>
              k.toLowerCase().includes(`ribbon ${ribbonNumber} monogram letter`) &&
              !processedKeys.has(k)
            );
            
            if (monogramKey) {
              charmValue = `${charmValue} ${item.customizations[monogramKey]}`;
              processedKeys.add(monogramKey);
            }
          }
          
          // REMOVE MEASUREMENTS from charm value
          charmValue = removeMeasurements(charmValue);
          
          formatted += `☐ ${cleanKey} - ${charmValue}\n`;
          processedKeys.add(key);
        }
      });
      
      // Handle other charm properties (non-ribbon charms)
      customKeys.forEach(key => {
        if (!processedKeys.has(key) &&
            key.toLowerCase().includes('charm') &&
            !key.toLowerCase().includes('ribbon charm')) {
          let cleanKey = key.replace(' copy', '').trim();
          // REMOVE MEASUREMENTS from charm value
          let charmValue = removeMeasurements(item.customizations[key]);
          formatted += `☐ ${cleanKey} - ${charmValue}\n`;
          processedKeys.add(key);
        }
      });
      
      // Handle all non-charm customizations
      customKeys.forEach(key => {
        if (!processedKeys.has(key) &&
            !key.toLowerCase().includes('monogram letter') &&
            !key.toLowerCase().includes('charm') &&
            !IGNORE_PROPERTIES.some(ignore =>
              key.toLowerCase().includes(ignore.toLowerCase())
            )) {
          // REMOVE MEASUREMENTS from value
          let value = removeMeasurements(item.customizations[key]);
          formatted += `☐ ${key} - ${value}\n`;
          processedKeys.add(key);
        }
      });
    }
    
    if (index < items.length - 1) {
      formatted += '\n';
    }
  });
  
  return formatted;
}

/**
 * Fill customs declaration SKUs
 * IMPORTANT: ShipStation's customs API doesn't have a dedicated "SKU" field!
 * This function uses a WORKAROUND by appending SKU to the description field.
 * 
 * ShipStation customs fields:
 * - description (string) - Item description
 * - quantity (number) - Quantity
 * - value (number) - Unit value
 * - harmonizedTariffCode (string) - HS/tariff code (6-10 digits)
 * - countryOfOrigin (string) - 2-letter country code
 * 
 * WORKAROUND: We'll append "[SKU: ABC123]" to the description field
 */
async function fillCustomsSKUs(orderId) {
  try {
    console.log(`[SKU Filler] Filling customs SKUs for order ${orderId}`);
    
    // Get the full order
    const order = await shipstation.getOrder(orderId);
    
    if (!order.items || order.items.length === 0) {
      console.log('[SKU Filler] No items found in order');
      return { success: false, error: 'No items found' };
    }
    
    // Check if order has customs info
    if (!order.advancedOptions || !order.advancedOptions.customsItems || 
        order.advancedOptions.customsItems.length === 0) {
      console.log('[SKU Filler] No customs declarations found');
      return { success: false, error: 'No customs declarations' };
    }
    
    // Prepare items for matching
    const shipmentItems = order.items.map(item => ({
      name: item.name || '',
      sku: item.sku || '',
      unitPrice: parseFloat(item.unitPrice) || 0,
      quantity: parseInt(item.quantity) || 1,
      customsPrice: (parseFloat(item.unitPrice) || 0) === 0 ? 1.00 : parseFloat(item.unitPrice),
      used: false
    }));
    
    // Description matching rules (from Tampermonkey)
    const DESCRIPTION_RULES = {
      'planner agenda': ['planner'],
      'notebook (bound journal)': ['notebook', ['A5', 'TN']],
      'notebook (sewn journal, B5': ['notebook', 'B5'],
      'notepad': ['notepad'],
      'sticky notepad': ['stickies', 'sticky'],
      'paper sticker': ['sticker', 'stickers', 'botanical', 'wellness', 'solstice', 'finance', 'tabs', 'highlight'],
      'gel ink pen': ['brass', 'pen'],
      'planner inserts': ['inserts'],
      'decorative tape': ['washi', 'tape', 'MT Washi'],
      'journal': ['notebook', 'dotted', 'graph', 'lined'],
      'transparent pocket': ['pocket', 'transparent'],
      'charm': ['charm', 'bracelet', 'jewelry']
    };
    
    // Function to check if product matches description
    function productMatchesDescription(productName, customsDescription) {
      const prodLower = productName.toLowerCase();
      const descLower = customsDescription.toLowerCase();
      
      for (const [descPattern, keywords] of Object.entries(DESCRIPTION_RULES)) {
        if (descLower.includes(descPattern)) {
          if (Array.isArray(keywords[0])) {
            const primaryKeyword = keywords[0];
            const secondaryKeywords = keywords[1];
            
            const hasPrimary = primaryKeyword.some(k => prodLower.includes(k.toLowerCase()));
            const hasSecondary = Array.isArray(secondaryKeywords)
              ? secondaryKeywords.some(k => prodLower.includes(k.toLowerCase()))
              : prodLower.includes(secondaryKeywords.toLowerCase());
            
            if (hasPrimary && hasSecondary) return true;
          } else {
            const matches = keywords.some(keyword =>
              prodLower.includes(keyword.toLowerCase())
            );
            if (matches) return true;
          }
        }
      }
      
      return false;
    }
    
    // Fill SKUs in customs items
    let filledCount = 0;
    const updatedCustomsItems = order.advancedOptions.customsItems.map((customsItem, idx) => {
      console.log(`[SKU Filler] Processing customs item ${idx + 1}:`, {
        description: customsItem.description,
        value: customsItem.value,
        quantity: customsItem.quantity
      });
      
      // Check if SKU already appended to description
      if (customsItem.description && customsItem.description.includes('[SKU:')) {
        console.log(`[SKU Filler] Item ${idx + 1} already has SKU in description`);
        return customsItem;
      }
      
      const customsDescription = customsItem.description || '';
      const declarationPrice = parseFloat(customsItem.value) || 0;
      const quantity = parseInt(customsItem.quantity) || 1;
      
      console.log(`[SKU Filler] Looking for match: price=${declarationPrice}, qty=${quantity}`);
      
      // Find matching shipment items by price
      const priceMatches = shipmentItems.filter(item =>
        !item.used && Math.abs(item.customsPrice - declarationPrice) < 0.01
      );
      
      console.log(`[SKU Filler] Found ${priceMatches.length} price matches`);
      
      let matchingItem = null;
      
      if (priceMatches.length === 1) {
        matchingItem = priceMatches[0];
        console.log(`[SKU Filler] Single price match found: ${matchingItem.sku}`);
      } else if (priceMatches.length > 1) {
        // Try multiple matching strategies
        matchingItem = priceMatches.find(item =>
          item.quantity === quantity &&
          productMatchesDescription(item.name, customsDescription)
        ) || priceMatches.find(item =>
          productMatchesDescription(item.name, customsDescription)
        ) || priceMatches.find(item =>
          item.quantity === quantity
        ) || priceMatches[0];
        
        console.log(`[SKU Filler] Multiple matches, selected: ${matchingItem ? matchingItem.sku : 'NONE'}`);
      } else {
        console.log(`[SKU Filler] No price matches found for item ${idx + 1}`);
      }
      
      if (matchingItem && matchingItem.sku) {
        matchingItem.used = true;
        filledCount++;
        
        // WORKAROUND: Append SKU to description since no dedicated SKU field exists
        const newDescription = `${customsDescription} [SKU: ${matchingItem.sku}]`;
        
        console.log(`[SKU Filler] ✅ Matched "${customsDescription}" -> SKU: ${matchingItem.sku}`);
        console.log(`[SKU Filler] ✅ Updated description: "${newDescription}"`);
        
        // Return updated customs item with SKU appended to description
        return {
          ...customsItem,
          description: newDescription
        };
      }
      
      console.log(`[SKU Filler] ❌ No match found for item ${idx + 1}`);
      return customsItem;
    });
    
    // Update the order with filled SKUs
    if (filledCount > 0) {
      const updatedOrder = {
        ...order,
        advancedOptions: {
          ...order.advancedOptions,
          customsItems: updatedCustomsItems
        }
      };
      
      await shipstation.createOrUpdateOrder(updatedOrder);
      console.log(`[SKU Filler] ✅ Appended ${filledCount} SKUs to customs descriptions`);
      
      return { 
        success: true, 
        filledCount,
        message: `SKUs appended to description field (ShipStation doesn't have a dedicated SKU field in customs)`
      };
    } else {
      console.log('[SKU Filler] No SKUs to fill');
      return { success: true, filledCount: 0 };
    }
    
  } catch (error) {
    console.error('[SKU Filler] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Determine if order should be tagged with Charm or Customization
 */
function determineTag(customizations) {
  // Check if any customization contains charm
  for (const item of customizations) {
    for (const key in item.customizations) {
      const keyLower = key.toLowerCase();
      const valueLower = item.customizations[key].toLowerCase();
      
      if (keyLower.includes('charm') || valueLower.includes('charm')) {
        return 'Charm';
      }
    }
  }
  
  // Otherwise it's a customization
  return 'Customization';
}

// ===== API Endpoints =====

/**
 * API: Scan for orders with customizations
 * Finds orders with stringified properties or sub-line items
 * NOW WITH PAGINATION - Can fetch more than 500 orders!
 */
router.get('/api/order-formatter/scan', requireAuthApi, async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const maxOrders = Number(req.query.maxOrders || 200);
    
    console.log(`[Order Formatter] Scanning last ${days} days for orders with customizations (max: ${maxOrders})...`);
    
    // Calculate date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const createDateStart = startDate.toISOString().split('T')[0];
    
    // STEP 1: Fetch orders from ShipStation WITH PAGINATION
    const orders = [];
    let page = 1;
    const pageSize = 500;
    
    while (orders.length < maxOrders) {
      console.log(`[Order Formatter] Fetching page ${page}...`);
      
      const pageOrders = await shipstation.searchOrders({
        orderStatus: 'awaiting_shipment',
        createDateStart,
        pageSize: pageSize,
        page: page,
        sortBy: 'OrderDate',
        sortDir: 'DESC'
      });
      
      if (!pageOrders || pageOrders.length === 0) {
        console.log(`[Order Formatter] No more orders found on page ${page}`);
        break;
      }
      
      orders.push(...pageOrders);
      console.log(`[Order Formatter] Page ${page}: Found ${pageOrders.length} orders (total: ${orders.length})`);
      
      if (pageOrders.length < pageSize) {
        console.log(`[Order Formatter] Reached last page`);
        break;
      }
      
      if (orders.length >= maxOrders) {
        console.log(`[Order Formatter] Reached max orders limit (${maxOrders})`);
        break;
      }
      
      page++;
      
      if (page > 10) {
        console.log(`[Order Formatter] Safety limit: stopped at page 10`);
        break;
      }
      
      // Rate limiting between pages
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const trimmedOrders = orders.slice(0, maxOrders);
    console.log(`[Order Formatter] Found ${trimmedOrders.length} awaiting shipment orders`);
    
    // STEP 2: Filter orders that have customizations
    const ordersWithCustomizations = [];
    
    for (const order of trimmedOrders) {
      const customizations = parseCustomizations(order);
      
      if (customizations.length > 0) {
        const tag = determineTag(customizations);
        const formattedText = formatCustomizations(customizations);
        
        ordersWithCustomizations.push({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          orderKey: order.orderKey,
          orderDate: order.orderDate,
          customerEmail: order.customerEmail,
          customerName: `${order.shipTo?.name || 'Unknown'}`,
          itemCount: order.items?.length || 0,
          customizations,
          suggestedTag: tag,
          formattedText,
          currentGiftNote: order.giftMessage || '',
          currentInternalNote: order.internalNotes || '',
          shopifyNote: '' // Will be filled in step 3
        });
      }
    }
    
    console.log(`[Order Formatter] Found ${ordersWithCustomizations.length} orders with customizations`);
    
    // STEP 3: Fetch Shopify notes (NOW ordersWithCustomizations exists!)
    if (shopify.isConfigured() && ordersWithCustomizations.length > 0) {
      console.log(`[Order Formatter] Fetching Shopify notes for ${ordersWithCustomizations.length} orders...`);
      
      try {
        const orderNumbers = ordersWithCustomizations.map(o => o.orderNumber);
        const shopifyNotes = await shopify.batchGetOrderNotes(orderNumbers);
        
        ordersWithCustomizations.forEach(order => {
          order.shopifyNote = shopifyNotes[order.orderNumber] || '';
        });
        
        const notesCount = ordersWithCustomizations.filter(o => o.shopifyNote).length;
        console.log(`[Order Formatter] ✅ Found ${notesCount} orders with Shopify notes`);
        
      } catch (error) {
        console.error('[Order Formatter] Failed to fetch Shopify notes:', error.message);
      }
    } else if (!shopify.isConfigured()) {
      console.log('[Order Formatter] ⚠️ Shopify API not configured - skipping note fetch');
    }
    
    // STEP 4: Return response
    res.json({
      success: true,
      totalScanned: trimmedOrders.length,
      foundWithCustomizations: ordersWithCustomizations.length,
      orders: ordersWithCustomizations,
      shopifyConfigured: shopify.isConfigured()
    });
    
  } catch (error) {
    console.error('[Order Formatter] Scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Tag single order
 */
router.post('/api/order-formatter/tag-order', requireAuthApi, async (req, res) => {
  try {
    const { orderId, tag } = req.body;
    
    if (!orderId || !tag) {
      return res.status(400).json({
        success: false,
        error: 'orderId and tag are required'
      });
    }
    
    console.log(`[Order Formatter] Tagging order ${orderId} with ${tag}`);
    
    // Get the tag ID
    const tagId = await shipstation.getTagId(tag);
    
    if (!tagId) {
      return res.status(400).json({
        success: false,
        error: `Tag "${tag}" not found in ShipStation. Please create it first.`
      });
    }
    
    // Add tag to order
    await shipstation.addTagToOrder(orderId, tagId);
    
    res.json({
      success: true,
      orderId,
      tag
    });
    
  } catch (error) {
    console.error('[Order Formatter] Tag failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Format single order (update Gift Note)
 */
router.post('/api/order-formatter/format-order', requireAuthApi, async (req, res) => {
  try {
    const { orderId, formattedText, shopifyNote } = req.body; // ADD shopifyNote
    
    if (!orderId || !formattedText) {
      return res.status(400).json({
        success: false,
        error: 'orderId and formattedText are required'
      });
    }
    
    console.log(`[Order Formatter] Formatting order ${orderId}`);
    
    const order = await shipstation.getOrder(orderId);
    
    const updatedOrder = {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      orderKey: order.orderKey,
      orderDate: order.orderDate,
      orderStatus: order.orderStatus,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
      billTo: order.billTo,
      shipTo: order.shipTo,
      items: order.items,
      orderTotal: order.orderTotal,
      amountPaid: order.amountPaid,
      taxAmount: order.taxAmount,
      shippingAmount: order.shippingAmount,
      customerNotes: order.customerNotes,
      internalNotes: shopifyNote || order.internalNotes || '', // SYNC SHOPIFY NOTE HERE
      giftMessage: formattedText,
      paymentMethod: order.paymentMethod,
      requestedShippingService: order.requestedShippingService,
      carrierCode: order.carrierCode,
      serviceCode: order.serviceCode,
      packageCode: order.packageCode,
      confirmation: order.confirmation,
      shipDate: order.shipDate,
      weight: order.weight,
      dimensions: order.dimensions,
      insuranceOptions: order.insuranceOptions,
      internationalOptions: order.internationalOptions,
      advancedOptions: order.advancedOptions,
      tagIds: order.tagIds
    };
    
    await shipstation.createOrUpdateOrder(updatedOrder);
    
    console.log(`[Order Formatter] ✅ Formatted order ${orderId}`);
    if (shopifyNote) {
      console.log(`[Order Formatter] ✅ Synced Shopify note to internal notes`);
    }
    
    res.json({
      success: true,
      orderId,
      syncedNote: !!shopifyNote
    });
    
  } catch (error) {
    console.error('[Order Formatter] Format failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Fill customs SKUs for single order
 */
router.post('/api/order-formatter/fill-skus', requireAuthApi, async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'orderId is required'
      });
    }
    
    const result = await fillCustomsSKUs(orderId);
    
    res.json(result);
    
  } catch (error) {
    console.error('[Order Formatter] Fill SKUs failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Bulk tag orders
 */
router.post('/api/order-formatter/bulk-tag', requireAuthApi, async (req, res) => {
  try {
    const { orders } = req.body; // Array of { orderId, tag }
    
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'orders array is required'
      });
    }
    
    console.log(`[Order Formatter] Bulk tagging ${orders.length} orders`);
    
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };
    
    // Process in batches to avoid rate limits
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      
      try {
        // Get tag ID
        const tagId = await shipstation.getTagId(order.tag);
        
        if (!tagId) {
          throw new Error(`Tag "${order.tag}" not found`);
        }
        
        // Add tag
        await shipstation.addTagToOrder(order.orderId, tagId);
        results.success++;
        
        // Rate limiting: wait 100ms between requests
        if (i < orders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          orderId: order.orderId,
          error: error.message
        });
      }
    }
    
    console.log(`[Order Formatter] Bulk tag complete: ${results.success} success, ${results.failed} failed`);
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('[Order Formatter] Bulk tag failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Bulk format orders
 */
router.post('/api/order-formatter/bulk-format', requireAuthApi, async (req, res) => {
  try {
    const { orders } = req.body; // Array of { orderId, formattedText }
    
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'orders array is required'
      });
    }
    
    console.log(`[Order Formatter] Bulk formatting ${orders.length} orders`);
    
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };
    
    // Process in batches to avoid rate limits
    for (let i = 0; i < orders.length; i++) {
      const orderData = orders[i];
      
      try {
        // Fetch the full order
        const order = await shipstation.getOrder(orderData.orderId);
        
        // Update gift message
        const updatedOrder = {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          orderKey: order.orderKey,
          orderDate: order.orderDate,
          orderStatus: order.orderStatus,
          customerId: order.customerId,
          customerEmail: order.customerEmail,
          billTo: order.billTo,
          shipTo: order.shipTo,
          items: order.items,
          orderTotal: order.orderTotal,
          amountPaid: order.amountPaid,
          taxAmount: order.taxAmount,
          shippingAmount: order.shippingAmount,
          customerNotes: order.customerNotes,
          internalNotes: order.internalNotes,
          giftMessage: orderData.formattedText,
          paymentMethod: order.paymentMethod,
          requestedShippingService: order.requestedShippingService,
          carrierCode: order.carrierCode,
          serviceCode: order.serviceCode,
          packageCode: order.packageCode,
          confirmation: order.confirmation,
          shipDate: order.shipDate,
          weight: order.weight,
          dimensions: order.dimensions,
          insuranceOptions: order.insuranceOptions,
          internationalOptions: order.internationalOptions,
          advancedOptions: order.advancedOptions,
          tagIds: order.tagIds
        };
        
        // Send update
        await shipstation.createOrUpdateOrder(updatedOrder);
        results.success++;
        
        // Rate limiting: wait 200ms between requests (formatting is slower)
        if (i < orders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          orderId: orderData.orderId,
          error: error.message
        });
      }
    }
    
    console.log(`[Order Formatter] Bulk format complete: ${results.success} success, ${results.failed} failed`);
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('[Order Formatter] Bulk format failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Bulk fill customs SKUs
 */
router.post('/api/order-formatter/bulk-fill-skus', requireAuthApi, async (req, res) => {
  try {
    const { orders } = req.body; // Array of { orderId }
    
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'orders array is required'
      });
    }
    
    console.log(`[Order Formatter] Bulk filling SKUs for ${orders.length} orders`);
    
    const results = {
      success: 0,
      failed: 0,
      totalFilled: 0,
      errors: []
    };
    
    // Process orders sequentially
    for (let i = 0; i < orders.length; i++) {
      const orderData = orders[i];
      
      try {
        const result = await fillCustomsSKUs(orderData.orderId);
        
        if (result.success) {
          results.success++;
          results.totalFilled += result.filledCount || 0;
        } else {
          results.failed++;
          results.errors.push({
            orderId: orderData.orderId,
            error: result.error
          });
        }
        
        // Rate limiting: wait 200ms between requests
        if (i < orders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          orderId: orderData.orderId,
          error: error.message
        });
      }
    }
    
    console.log(`[Order Formatter] Bulk SKU fill complete: ${results.success} success, ${results.totalFilled} SKUs filled, ${results.failed} failed`);
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('[Order Formatter] Bulk SKU fill failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;