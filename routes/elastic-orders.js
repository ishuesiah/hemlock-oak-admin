'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { ShipStationAPI } = require('../shipstation-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');
const {
  getCachedOrders,
  saveCachedOrders,
  getCacheSyncStatus,
  isCacheFresh
} = require('../utils/shipstation-cache');

const shipstation = new ShipStationAPI();

// Serve the HTML page
const elasticOrdersHTML = fs.readFileSync(path.join(__dirname, '../views/elastic-orders.html'), 'utf8');
router.get('/elastic-orders', requireAuth, (_req, res) => res.send(elasticOrdersHTML));

/**
 * Helper function to check if an order contains items matching search terms
 * Searches line item SKUs, names, and options (ItemOption array)
 */
function containsSearchTerm(order, searchTerms) {
  if (!order || !Array.isArray(order.items)) return false;

  for (const item of order.items) {
    const sku = String(item.sku || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();

    // Check SKU and name
    for (const keyword of searchTerms) {
      if (sku.includes(keyword) || name.includes(keyword)) {
        return true;
      }
    }

    // Check options array (ItemOption model: {name, value})
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        const optionName = String(option.name || '').toLowerCase();
        const optionValue = String(option.value || '').toLowerCase();

        for (const keyword of searchTerms) {
          if (optionName.includes(keyword) || optionValue.includes(keyword)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Get cache status
 * GET /api/elastic-orders/cache-status
 */
router.get('/api/elastic-orders/cache-status', requireAuthApi, async (req, res) => {
  try {
    const status = await getCacheSyncStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting cache status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * API endpoint to scan for orders containing specific items
 * GET /api/elastic-orders/scan?days=30&searchTerm=elastic&refresh=true
 */
router.get('/api/elastic-orders/scan', requireAuthApi, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const pageSize = 100; // ShipStation max
    const maxPages = parseInt(req.query.maxPages) || 10;
    const searchTermParam = req.query.searchTerm || 'elastic';
    const forceRefresh = req.query.refresh === 'true';

    // Parse search terms - support comma-separated values
    const searchTerms = searchTermParam
      .split(',')
      .map(term => term.trim().toLowerCase())
      .filter(term => term.length > 0);

    // Check if we can use cache
    const useCache = !forceRefresh && await isCacheFresh(24);

    if (useCache) {
      console.log('[Cache] Using cached orders (fast mode)');
      const cachedOrders = await getCachedOrders(searchTerms);
      const totalItemQuantity = cachedOrders.reduce((sum, order) =>
        sum + order.matchingItems.reduce((itemSum, item) => itemSum + (item.quantity || 0), 0), 0
      );

      const cacheStatus = await getCacheSyncStatus();

      return res.json({
        success: true,
        searchTerm: searchTermParam,
        totalOrders: cachedOrders.length,
        totalItemQuantity: totalItemQuantity,
        orders: cachedOrders,
        fromCache: true,
        cacheLastSync: cacheStatus.lastSync,
        dateRange: {
          from: 'cached',
          to: 'cached'
        }
      });
    }

    // Calculate date range
    const since = new Date();
    since.setDate(since.getDate() - days);
    const createDateStart = since.toISOString().split('T')[0]; // YYYY-MM-DD format

    console.log(`Scanning for orders with "${searchTermParam}" in the last ${days} days (since ${createDateStart})...`);

    // Statuses that indicate unfulfilled orders
    const unfulfilled_statuses = ['awaiting_shipment', 'awaiting_payment', 'on_hold'];

    const matchedOrders = [];
    const processedOrderIds = new Set();
    let totalItemQuantity = 0;

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

        // Filter for matching orders
        for (const order of orders) {
          // Skip if we've already processed this order
          if (processedOrderIds.has(order.orderId)) continue;

          if (containsSearchTerm(order, searchTerms)) {
            processedOrderIds.add(order.orderId);

            // Extract matching items from this order
            const matchingItems = order.items.filter(item => {
              const sku = String(item.sku || '').toLowerCase();
              const name = String(item.name || '').toLowerCase();

              // Check SKU and name
              if (searchTerms.some(keyword => sku.includes(keyword) || name.includes(keyword))) {
                return true;
              }

              // Check options array
              if (Array.isArray(item.options)) {
                for (const option of item.options) {
                  const optionName = String(option.name || '').toLowerCase();
                  const optionValue = String(option.value || '').toLowerCase();
                  if (searchTerms.some(keyword => optionName.includes(keyword) || optionValue.includes(keyword))) {
                    return true;
                  }
                }
              }

              return false;
            });

            // Calculate total quantity for these items
            const orderItemQuantity = matchingItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
            totalItemQuantity += orderItemQuantity;

            matchedOrders.push({
              orderId: order.orderId,
              orderNumber: order.orderNumber,
              orderKey: order.orderKey,
              orderDate: order.orderDate,
              orderStatus: order.orderStatus,
              customerName: `${order.shipTo?.name || 'Unknown'}`,
              customerEmail: order.customerEmail || '',
              itemCount: order.items.length,
              matchingItems: matchingItems.map(item => ({
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                options: item.options || []
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
    matchedOrders.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

    console.log(`Found ${matchedOrders.length} unfulfilled orders containing "${searchTermParam}" (${totalItemQuantity} total items)`);

    // Save to cache (async, don't wait)
    saveCachedOrders(matchedOrders).catch(err =>
      console.error('[Cache] Failed to save orders:', err)
    );

    res.json({
      success: true,
      searchTerm: searchTermParam,
      totalOrders: matchedOrders.length,
      totalItemQuantity: totalItemQuantity,
      orders: matchedOrders,
      fromCache: false,
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
