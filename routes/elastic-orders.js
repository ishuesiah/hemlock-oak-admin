'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { ShipStationAPI } = require('../shipstation-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');

const shipstation = new ShipStationAPI();

// Serve the HTML page
const elasticOrdersHTML = fs.readFileSync(path.join(__dirname, '../views/elastic-orders.html'), 'utf8');
router.get('/elastic-orders', requireAuth, (_req, res) => res.send(elasticOrdersHTML));

/**
 * Helper function to check if an order contains elastic items
 * Searches line item SKUs, names, and stringifiedProperties
 */
function containsElastic(order) {
  if (!order || !Array.isArray(order.items)) return false;

  const elasticKeywords = ['elastic', 'clip band', 'clipband'];

  for (const item of order.items) {
    const sku = String(item.sku || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    const stringifiedProps = String(item.stringifiedProperties || '').toLowerCase();

    // Check if any elastic keyword appears in SKU, name, or stringifiedProperties
    for (const keyword of elasticKeywords) {
      if (sku.includes(keyword) || name.includes(keyword) || stringifiedProps.includes(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * API endpoint to scan for elastic orders
 * GET /api/elastic-orders/scan?days=30
 */
router.get('/api/elastic-orders/scan', requireAuthApi, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const pageSize = 100; // ShipStation max
    const maxPages = parseInt(req.query.maxPages) || 10;

    // Calculate date range
    const since = new Date();
    since.setDate(since.getDate() - days);
    const createDateStart = since.toISOString().split('T')[0]; // YYYY-MM-DD format

    console.log(`Scanning for elastic orders in the last ${days} days (since ${createDateStart})...`);

    // Statuses that indicate unfulfilled orders
    const unfulfilled_statuses = ['awaiting_shipment', 'awaiting_payment', 'on_hold'];

    const elasticOrders = [];
    const processedOrderIds = new Set();

    // Search through each unfulfilled status
    for (const status of unfulfilled_statuses) {
      console.log(`  Checking status: ${status}`);

      let page = 1;
      let hasMore = true;

      while (hasMore && page <= maxPages) {
        const params = {
          createDateStart,
          orderStatus: status,
          sortBy: 'OrderDate',
          sortDir: 'DESC',
          pageSize,
          page
        };

        console.log(`    Fetching page ${page}...`);
        const orders = await shipstation.searchOrders(params);

        if (!orders || orders.length === 0) {
          hasMore = false;
          break;
        }

        // Filter for elastic orders
        for (const order of orders) {
          // Skip if we've already processed this order
          if (processedOrderIds.has(order.orderId)) continue;

          if (containsElastic(order)) {
            processedOrderIds.add(order.orderId);

            // Extract elastic items from this order
            const elasticItems = order.items.filter(item => {
              const sku = String(item.sku || '').toLowerCase();
              const name = String(item.name || '').toLowerCase();
              const stringifiedProps = String(item.stringifiedProperties || '').toLowerCase();
              return ['elastic', 'clip band', 'clipband'].some(keyword =>
                sku.includes(keyword) || name.includes(keyword) || stringifiedProps.includes(keyword)
              );
            });

            elasticOrders.push({
              orderId: order.orderId,
              orderNumber: order.orderNumber,
              orderKey: order.orderKey,
              orderDate: order.orderDate,
              orderStatus: order.orderStatus,
              customerName: `${order.shipTo?.name || 'Unknown'}`,
              customerEmail: order.customerEmail || '',
              itemCount: order.items.length,
              elasticItems: elasticItems.map(item => ({
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                stringifiedProperties: item.stringifiedProperties || ''
              })),
              shipStationUrl: `https://ship.shipstation.com/orders/details/${order.orderId}`
            });
          }
        }

        // Check if there are more pages
        if (orders.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }

        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    // Sort by order date (newest first)
    elasticOrders.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

    console.log(`Found ${elasticOrders.length} unfulfilled orders containing elastic items`);

    res.json({
      success: true,
      totalOrders: elasticOrders.length,
      orders: elasticOrders,
      dateRange: {
        from: createDateStart,
        to: new Date().toISOString().split('T')[0]
      }
    });

  } catch (error) {
    console.error('Error scanning elastic orders:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
