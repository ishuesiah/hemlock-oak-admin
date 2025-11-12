// routes/order-item-adder.js - UPDATED with working code from shipstation-add-item.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

// Import the working ShipStation API from shipstation-add-item.js
const { ShipStationAPI } = require('../shipstation-add-item');

// Import cache utilities
const { loadUnfulfilledOrders } = require('../utils/unfulfilled-orders-cache');
const { forceSyncUnfulfilledOrders } = require('../utils/unfulfilled-orders-sync-job');

// Initialize customs manager on startup
let shipstationAPI;
(async () => {
  try {
    shipstationAPI = new ShipStationAPI();

    // Try to load CUSMA database from different possible locations
    const possiblePaths = [
      path.join(__dirname, '../data/CUSMA.csv'),
      path.join(__dirname, '../CUSMA.csv'),
      './CUSMA.csv',
      './data/CUSMA.csv'
    ];

    let loaded = false;
    for (const csvPath of possiblePaths) {
      try {
        await shipstationAPI.loadCUSMA(csvPath);
        console.log('[Order Item Adder] CUSMA database loaded from:', csvPath);
        loaded = true;
        break;
      } catch (e) {
        // Try next path
      }
    }

    if (!loaded) {
      console.warn('[Order Item Adder] CUSMA database not found, using defaults');
    }
  } catch (error) {
    console.error('[Order Item Adder] Error loading CUSMA database:', error);
  }
})();

/**
 * GET /order-item-adder - Serve the UI page from views folder
 */
router.get('/order-item-adder', async (req, res) => {
  try {
    const htmlPath = path.join(__dirname, '../views/order-item-adder.html');
    const html = await fs.readFile(htmlPath, 'utf-8');
    res.send(html);
  } catch (error) {
    console.error('[Order Item Adder] Error loading view:', error);
    res.status(500).send('Error loading page');
  }
});

/**
 * POST /api/shipstation/orders/add-item - Add item to orders (BATCH PROCESSING)
 */
router.post('/api/shipstation/orders/add-item', async (req, res) => {
  try {
    const { orderNumbers, item, customsOnly } = req.body;

    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ error: 'Order numbers array is required' });
    }

    // Initialize results
    const results = {
      total: orderNumbers.length,
      successful: 0,
      skipped: 0,
      failed: 0,
      details: []
    };

    // Ensure API is initialized
    if (!shipstationAPI) {
      shipstationAPI = new ShipStationAPI();
      await shipstationAPI.loadCUSMA('./data/CUSMA.csv');
    }

    // Process each order
    for (const orderNumber of orderNumbers) {
      try {
        // Pass the item data with custom quantity/price if provided
        const result = await shipstationAPI.addItemToOrder(orderNumber, item);

        if (result.message && result.message.includes('already exists')) {
          results.skipped++;
          results.details.push({
            orderNumber,
            status: 'skipped',
            message: result.message,
            itemsCount: result.itemsCount,
            customsCount: result.customsCount
          });
        } else {
          results.successful++;
          results.details.push({
            orderNumber,
            status: 'success',
            message: result.message,
            itemsCount: result.itemsCount,
            customsCount: result.customsCount
          });
        }

        // Rate limiting - wait 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        results.failed++;
        results.details.push({
          orderNumber,
          status: 'error',
          error: error.message
        });
        console.error(`[Order Item Adder] Error processing order ${orderNumber}:`, error.message);
      }
    }

    res.json(results);

  } catch (error) {
    console.error('[API] Error in add-item endpoint:', error);
    res.status(500).json({
      error: error.message || 'Failed to process orders',
      details: error.response?.data
    });
  }
});

/**
 * GET /api/shipstation/unfulfilled-orders - Get cached unfulfilled orders
 */
router.get('/api/shipstation/unfulfilled-orders', async (req, res) => {
  try {
    const cache = await loadUnfulfilledOrders();

    res.json({
      orders: cache.orders,
      timestamp: cache.timestamp,
      isStale: cache.isStale,
      age: cache.age,
      count: cache.orders.length
    });
  } catch (error) {
    console.error('[API] Error fetching unfulfilled orders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shipstation/unfulfilled-orders/refresh - Force refresh unfulfilled orders cache
 */
router.post('/api/shipstation/unfulfilled-orders/refresh', async (req, res) => {
  try {
    console.log('[API] Manual refresh of unfulfilled orders requested');
    const orders = await forceSyncUnfulfilledOrders();

    res.json({
      success: true,
      message: `Refreshed ${orders.length} unfulfilled orders`,
      count: orders.length
    });
  } catch (error) {
    console.error('[API] Error refreshing unfulfilled orders:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/shipstation/order/:orderNumber - Get full order details
 */
router.get('/api/shipstation/order/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;

    if (!shipstationAPI) {
      shipstationAPI = new ShipStationAPI();
      await shipstationAPI.loadCUSMA('./data/CUSMA.csv');
    }

    const order = await shipstationAPI.getOrderByNumber(orderNumber);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
  } catch (error) {
    console.error('[API] Error fetching order details:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shipstation/orders/batch-tag - Add tag to multiple orders
 */
router.post('/api/shipstation/orders/batch-tag', async (req, res) => {
  try {
    const { orderNumbers, tagName } = req.body;

    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ error: 'Order numbers array is required' });
    }

    if (!tagName || typeof tagName !== 'string' || !tagName.trim()) {
      return res.status(400).json({ error: 'Tag name is required' });
    }

    // Ensure API is initialized
    if (!shipstationAPI) {
      shipstationAPI = new ShipStationAPI();
      await shipstationAPI.loadCUSMA('./data/CUSMA.csv').catch(() => {});
    }

    console.log(`[Batch Tag] Adding tag "${tagName}" to ${orderNumbers.length} orders`);

    let tagged = 0;
    let failed = 0;
    const errors = [];

    // Process each order
    for (const orderNumber of orderNumbers) {
      try {
        await shipstationAPI.addTagToOrder(orderNumber, tagName);
        tagged++;
        console.log(`[Batch Tag] ✓ Tagged order ${orderNumber}`);

        // Rate limiting - wait 500ms between requests
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        failed++;
        errors.push({ orderNumber, error: error.message });
        console.error(`[Batch Tag] ✗ Failed to tag order ${orderNumber}:`, error.message);
      }
    }

    res.json({
      success: true,
      tagged,
      failed,
      total: orderNumbers.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Tagged ${tagged} of ${orderNumbers.length} orders`
    });

  } catch (error) {
    console.error('[API] Error in batch-tag endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to tag orders'
    });
  }
});

module.exports = router;
