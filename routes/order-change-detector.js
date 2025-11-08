// routes/order-change-detector.js - Detect Shopify order changes and tag in ShipStation
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ShipStationAPI } = require('../shipstation-api.js');
const { ShopifyAPI } = require('../shopify-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

// Initialize APIs
const shipstation = new ShipStationAPI();
const shopify = new ShopifyAPI();

// Load HTML template
const orderChangeDetectorHTML = fs.readFileSync(path.join(__dirname, '../views/order-change-detector.html'), 'utf8');

// Main Order Change Detector page
router.get('/order-change-detector', requireAuth, (req, res) => {
  res.send(orderChangeDetectorHTML);
});

// ===== Helper Functions =====

/**
 * Compare Shopify and ShipStation line items to detect changes
 * Returns: { hasChanges: boolean, changes: Array, details: Object }
 */
function compareOrderItems(shopifyOrder, shipstationOrder) {
  // Extract line items from both orders
  const shopifyItems = shopifyOrder.line_items || [];
  const shipstationItems = shipstationOrder.items || [];
  
  // Create normalized item maps for comparison
  // Using SKU as the primary identifier, with name as fallback
  const shopifyItemMap = new Map();
  const shipstationItemMap = new Map();
  
  // Build Shopify item map
  // Each entry: { sku: { quantity, name, price } }
  shopifyItems.forEach(item => {
    const sku = item.sku || item.name; // Use name as fallback if no SKU
    const existing = shopifyItemMap.get(sku);
    
    if (existing) {
      // If SKU already exists, add quantities (for multiple line items with same SKU)
      existing.quantity += item.quantity;
    } else {
      shopifyItemMap.set(sku, {
        quantity: item.quantity,
        name: item.name,
        price: parseFloat(item.price),
        variantId: item.variant_id
      });
    }
  });
  
  // Build ShipStation item map
  // Each entry: { sku: { quantity, name, price } }
  shipstationItems.forEach(item => {
    const sku = item.sku || item.name; // Use name as fallback if no SKU
    const existing = shipstationItemMap.get(sku);
    
    if (existing) {
      // If SKU already exists, add quantities
      existing.quantity += item.quantity;
    } else {
      shipstationItemMap.set(sku, {
        quantity: item.quantity,
        name: item.name,
        price: parseFloat(item.unitPrice || 0)
      });
    }
  });
  
  // Detect changes
  const changes = [];
  let hasChanges = false;
  
  // Check for items in Shopify that are missing or have different quantities in ShipStation
  for (const [sku, shopifyItem] of shopifyItemMap) {
    const shipstationItem = shipstationItemMap.get(sku);
    
    if (!shipstationItem) {
      // Item exists in Shopify but NOT in ShipStation = REMOVED from ShipStation
      hasChanges = true;
      changes.push({
        type: 'removed',
        sku: sku,
        name: shopifyItem.name,
        quantity: shopifyItem.quantity,
        description: `Item "${shopifyItem.name}" (SKU: ${sku}) was removed from ShipStation (${shopifyItem.quantity} units)`
      });
    } else if (shipstationItem.quantity !== shopifyItem.quantity) {
      // Item exists in both but with DIFFERENT quantities = QUANTITY CHANGED
      hasChanges = true;
      const difference = shipstationItem.quantity - shopifyItem.quantity;
      const changeType = difference > 0 ? 'increased' : 'decreased';
      
      changes.push({
        type: 'quantity_changed',
        sku: sku,
        name: shopifyItem.name,
        shopifyQuantity: shopifyItem.quantity,
        shipstationQuantity: shipstationItem.quantity,
        difference: Math.abs(difference),
        changeType: changeType,
        description: `Item "${shopifyItem.name}" (SKU: ${sku}) quantity ${changeType} from ${shopifyItem.quantity} to ${shipstationItem.quantity}`
      });
    }
  }
  
  // Check for items in ShipStation that DON'T exist in Shopify = ADDED to ShipStation
  for (const [sku, shipstationItem] of shipstationItemMap) {
    const shopifyItem = shopifyItemMap.get(sku);
    
    if (!shopifyItem) {
      // Item exists in ShipStation but NOT in Shopify = ADDED to ShipStation
      hasChanges = true;
      changes.push({
        type: 'added',
        sku: sku,
        name: shipstationItem.name,
        quantity: shipstationItem.quantity,
        description: `Item "${shipstationItem.name}" (SKU: ${sku}) was added to ShipStation (${shipstationItem.quantity} units)`
      });
    }
  }
  
  return {
    hasChanges,
    changes,
    details: {
      shopifyItemCount: shopifyItems.length,
      shipstationItemCount: shipstationItems.length,
      totalChanges: changes.length
    }
  };
}

/**
 * Get Shopify order by order number
 * ShipStation uses order numbers like "1001", while Shopify uses names like "#1001"
 */
async function getShopifyOrderByNumber(orderNumber) {
  try {
    // Ensure order number has # prefix for Shopify
    const shopifyOrderNumber = orderNumber.startsWith('#') ? orderNumber : '#' + orderNumber;
    
    // Use the existing getOrderByNumber method from Shopify API
    const order = await shopify.getOrderByNumber(shopifyOrderNumber);
    
    return order;
  } catch (error) {
    console.error(`[Order Change Detector] Failed to get Shopify order ${orderNumber}:`, error.message);
    return null;
  }
}

// ===== API Endpoints =====

/**
 * API: Scan for orders with changes
 * Compares ShipStation orders with Shopify to find discrepancies
 */
router.get('/api/order-change-detector/scan', requireAuthApi, async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const maxOrders = Number(req.query.maxOrders || 200);
    
    console.log(`[Order Change Detector] Scanning last ${days} days for order changes (max: ${maxOrders})...`);
    
    // Calculate date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const createDateStart = startDate.toISOString().split('T')[0];
    
    // STEP 1: Fetch orders from ShipStation
    // We'll check "awaiting_shipment" orders since those are active and may have been edited
    console.log('[Order Change Detector] Fetching ShipStation orders...');
    const shipstationOrders = await shipstation.searchOrders({
      orderStatus: 'awaiting_shipment',
      createDateStart,
      pageSize: Math.min(maxOrders, 500),
      page: 1,
      sortBy: 'OrderDate',
      sortDir: 'DESC'
    });
    
    console.log(`[Order Change Detector] Found ${shipstationOrders.length} ShipStation orders`);
    
    // STEP 2: Check each order against Shopify
    const ordersWithChanges = [];
    const scannedOrders = [];
    let processedCount = 0;
    
    for (const ssOrder of shipstationOrders) {
      processedCount++;
      
      // Progress logging every 10 orders
      if (processedCount % 10 === 0) {
        console.log(`[Order Change Detector] Progress: ${processedCount}/${shipstationOrders.length} orders checked`);
      }
      
      try {
        // Get corresponding Shopify order
        const shopifyOrder = await getShopifyOrderByNumber(ssOrder.orderNumber);
        
        if (!shopifyOrder) {
          console.log(`[Order Change Detector] âš ï¸ No matching Shopify order found for #${ssOrder.orderNumber}`);
          
          // Track as scanned but no Shopify match
          scannedOrders.push({
            orderId: ssOrder.orderId,
            orderNumber: ssOrder.orderNumber,
            status: 'no_shopify_match',
            customerName: ssOrder.shipTo?.name || 'Unknown',
            orderDate: ssOrder.orderDate
          });
          
          continue;
        }
        
        // Compare the orders
        const comparison = compareOrderItems(shopifyOrder, ssOrder);
        
        // Track this order as scanned
        scannedOrders.push({
          orderId: ssOrder.orderId,
          orderNumber: ssOrder.orderNumber,
          status: comparison.hasChanges ? 'has_changes' : 'no_changes',
          customerName: ssOrder.shipTo?.name || 'Unknown',
          orderDate: ssOrder.orderDate,
          changeCount: comparison.changes.length
        });
        
        // If changes detected, add to results
        if (comparison.hasChanges) {
          ordersWithChanges.push({
            orderId: ssOrder.orderId,
            orderNumber: ssOrder.orderNumber,
            orderKey: ssOrder.orderKey,
            orderDate: ssOrder.orderDate,
            customerName: ssOrder.shipTo?.name || 'Unknown',
            customerEmail: ssOrder.customerEmail,
            changes: comparison.changes,
            changeCount: comparison.changes.length,
            shopifyItemCount: comparison.details.shopifyItemCount,
            shipstationItemCount: comparison.details.shipstationItemCount,
            // Include current tag status
            currentTags: ssOrder.tagIds || [],
            hasOrderChangeTag: false // Will be updated after checking tag
          });
        }
        
        // Rate limiting between Shopify API calls (550ms as per Shopify API rate limits)
        await new Promise(resolve => setTimeout(resolve, 550));
        
      } catch (error) {
        console.error(`[Order Change Detector] Error processing order ${ssOrder.orderNumber}:`, error.message);
        
        // Track as error
        scannedOrders.push({
          orderId: ssOrder.orderId,
          orderNumber: ssOrder.orderNumber,
          status: 'error',
          customerName: ssOrder.shipTo?.name || 'Unknown',
          orderDate: ssOrder.orderDate,
          error: error.message
        });
      }
    }
    
    console.log(`[Order Change Detector] âœ… Scan complete: Found ${ordersWithChanges.length} orders with changes`);
    
    // STEP 3: Check if "ORDER CHANGE" tag already exists on any of these orders
    if (ordersWithChanges.length > 0) {
      console.log('[Order Change Detector] Checking for existing "ORDER CHANGE" tags...');
      
      // Get the tag ID for "ORDER CHANGE"
      const orderChangeTagId = await shipstation.getTagId('ORDER CHANGE');
      
      if (orderChangeTagId) {
        // Update each order's tag status
        ordersWithChanges.forEach(order => {
          order.hasOrderChangeTag = order.currentTags.includes(orderChangeTagId);
        });
        
        const alreadyTaggedCount = ordersWithChanges.filter(o => o.hasOrderChangeTag).length;
        console.log(`[Order Change Detector] ${alreadyTaggedCount} orders already have "ORDER CHANGE" tag`);
      } else {
        console.log('[Order Change Detector] âš ï¸ "ORDER CHANGE" tag does not exist yet - will need to be created');
      }
    }
    
    // STEP 4: Return results
    res.json({
      success: true,
      totalScanned: scannedOrders.length,
      ordersWithChanges: ordersWithChanges.length,
      ordersAlreadyTagged: ordersWithChanges.filter(o => o.hasOrderChangeTag).length,
      orders: ordersWithChanges,
      scanSummary: {
        hasChanges: ordersWithChanges.length,
        noChanges: scannedOrders.filter(o => o.status === 'no_changes').length,
        noShopifyMatch: scannedOrders.filter(o => o.status === 'no_shopify_match').length,
        errors: scannedOrders.filter(o => o.status === 'error').length
      }
    });
    
  } catch (error) {
    console.error('[Order Change Detector] Scan failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Tag a single order with "ORDER CHANGE"
 */
router.post('/api/order-change-detector/tag-order', requireAuthApi, async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'orderId is required'
      });
    }
    
    console.log(`[Order Change Detector] Tagging order ${orderId} with "ORDER CHANGE"`);
    
    // Get or create the "ORDER CHANGE" tag
    let tagId = await shipstation.getTagId('ORDER CHANGE');
    
    if (!tagId) {
      console.log('[Order Change Detector] "ORDER CHANGE" tag does not exist - it needs to be created in ShipStation first');
      return res.status(400).json({
        success: false,
        error: 'Tag "ORDER CHANGE" does not exist in ShipStation. Please create it first in your ShipStation account.'
      });
    }
    
    // Add tag to order
    await shipstation.addTagToOrder(orderId, tagId);
    
    console.log(`[Order Change Detector] âœ… Tagged order ${orderId}`);
    
    res.json({
      success: true,
      orderId,
      tag: 'ORDER CHANGE'
    });
    
  } catch (error) {
    console.error('[Order Change Detector] Tag failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Bulk tag orders with "ORDER CHANGE"
 */
router.post('/api/order-change-detector/bulk-tag', requireAuthApi, async (req, res) => {
  try {
    const { orderIds } = req.body;
    
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'orderIds array is required'
      });
    }
    
    console.log(`[Order Change Detector] Bulk tagging ${orderIds.length} orders with "ORDER CHANGE"`);
    
    // Get or create the "ORDER CHANGE" tag
    let tagId = await shipstation.getTagId('ORDER CHANGE');
    
    if (!tagId) {
      console.log('[Order Change Detector] "ORDER CHANGE" tag does not exist');
      return res.status(400).json({
        success: false,
        error: 'Tag "ORDER CHANGE" does not exist in ShipStation. Please create it first in your ShipStation account.'
      });
    }
    
    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
    
    // Process each order
    for (let i = 0; i < orderIds.length; i++) {
      const orderId = orderIds[i];
      
      try {
        // Add tag to order
        await shipstation.addTagToOrder(orderId, tagId);
        results.success++;
        
        // Progress logging every 10 orders
        if ((i + 1) % 10 === 0) {
          console.log(`[Order Change Detector] Bulk tag progress: ${i + 1}/${orderIds.length} orders`);
        }
        
        // Rate limiting: wait 150ms between requests
        if (i < orderIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        
      } catch (error) {
        // Check if error is because tag already exists
        if (error.message && error.message.includes('already')) {
          results.skipped++;
        } else {
          results.failed++;
          results.errors.push({
            orderId: orderId,
            error: error.message
          });
        }
      }
    }
    
    console.log(`[Order Change Detector] Bulk tag complete: ${results.success} tagged, ${results.skipped} skipped, ${results.failed} failed`);
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('[Order Change Detector] Bulk tag failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Get background job status
 */
router.get('/api/order-change-detector/job-status', requireAuthApi, (req, res) => {
  try {
    const { getJobStats } = require('../utils/order-change-detector-job');
    const stats = getJobStats();
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API: Manually trigger background job
 */
router.post('/api/order-change-detector/run-job', requireAuthApi, async (req, res) => {
  try {
    const { triggerManualRun } = require('../utils/order-change-detector-job');
    const results = await triggerManualRun();
    
    res.json({
      success: true,
      results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
