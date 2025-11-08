// routes/order-item-adder.js - UPDATED with working code from shipstation-add-item.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

// Import the working ShipStation API from shipstation-add-item.js
const { ShipStationAPI } = require('../shipstation-add-item');

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
        const result = await shipstationAPI.addItemToOrder(orderNumber, item || null);

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

module.exports = router;
