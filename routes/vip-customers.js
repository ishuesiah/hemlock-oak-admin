// routes/vip-customers.js - Updated to include ShipStation tagging
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ShopifyAPI } = require('../shopify-api.js');
const { ShipStationAPI } = require('../shipstation-api.js');
const { requireAuth, requireAuthApi } = require('../utils/auth-middleware');
const { initDB } = require('../utils/database');
const { getVIPCustomersFast, saveVIPCustomers, getSyncStatus } = require('../utils/vip-cache');

// Initialize database on startup
initDB().catch(console.error);

// Initialize APIs
const shopify = new ShopifyAPI();
const shipstation = new ShipStationAPI();

// Load HTML template
const vipCustomersHTML = fs.readFileSync(path.join(__dirname, '../views/vip-customers.html'), 'utf8');

// Main VIP customers page
router.get('/vip-customers', requireAuth, (req, res) => {
  res.send(vipCustomersHTML);
});

// API: Get VIP customers with SQLite caching
router.get('/api/vip-customers', requireAuthApi, async (req, res) => {
  try {
    const minSpent = Number(req.query.minSpent || 1000);
    const sortBy = req.query.sortBy || 'spent_desc';
    const forceRefresh = req.query.refresh === 'true';
    
    let vipCustomers;
    let fromCache = false;
    const startTime = Date.now();
    
    // Try to get from SQLite cache first (unless force refresh)
    if (!forceRefresh) {
      console.log(`[VIP Customers] Checking SQLite cache (min: $${minSpent})`);
      vipCustomers = await getVIPCustomersFast(minSpent);
      
      if (vipCustomers) {
        fromCache = true;
        console.log(`[VIP Customers] Loaded ${vipCustomers.length} customers from SQLite cache (instant!)`);
      }
    }
    
    // If not in cache or force refresh, fetch from Shopify
    if (!vipCustomers) {
      console.log(`[VIP Customers] Fetching fresh data from Shopify API...`);
      vipCustomers = await shopify.getVIPCustomers(minSpent, false);
      
      // Save to SQLite cache for next time
      try {
        await saveVIPCustomers(vipCustomers, minSpent);
        console.log(`[VIP Customers] Saved ${vipCustomers.length} customers to SQLite cache`);
      } catch (saveError) {
        console.error('[VIP Customers] Failed to save to cache:', saveError);
        // Continue even if cache save fails
      }
    }
    
    // Apply sorting based on query parameter
    switch(sortBy) {
      case 'spent_asc':
        vipCustomers.sort((a, b) => 
          parseFloat(a.total_spent || 0) - parseFloat(b.total_spent || 0)
        );
        break;
      case 'unfulfilled_desc':
        vipCustomers.sort((a, b) => 
          b.unfulfilled_count - a.unfulfilled_count
        );
        break;
      case 'unfulfilled_value_desc':
        vipCustomers.sort((a, b) => 
          b.unfulfilled_value - a.unfulfilled_value
        );
        break;
      case 'spent_desc':
      default:
        vipCustomers.sort((a, b) => 
          parseFloat(b.total_spent || 0) - parseFloat(a.total_spent || 0)
        );
        break;
    }
    
    // Format the response
    const formattedCustomers = vipCustomers.map(customer => ({
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name || '',
      last_name: customer.last_name || '',
      full_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Unknown',
      total_spent: parseFloat(customer.total_spent || 0),
      orders_count: customer.orders_count || 0,
      state: customer.state || 'enabled',
      created_at: customer.created_at,
      last_order_name: customer.last_order_name || '',
      tags: customer.tags || '',
      note: customer.note || '',
      verified_email: customer.verified_email || false,
      unfulfilled_count: customer.unfulfilled_count || 0,
      unfulfilled_value: customer.unfulfilled_value || 0,
      unfulfilled_orders: (customer.unfulfilled_orders || []).map(order => ({
        id: order.id,
        name: order.name,
        created_at: order.created_at,
        total_price: parseFloat(order.total_price || 0),
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status || 'unfulfilled',
        line_items_count: (order.line_items || []).length,
        shipping_address: order.shipping_address ? {
          city: order.shipping_address.city,
          province: order.shipping_address.province,
          country: order.shipping_address.country
        } : null
      }))
    }));
    
    // Calculate statistics
    const totalVIPs = formattedCustomers.length;
    const totalSpent = formattedCustomers.reduce((sum, c) => sum + c.total_spent, 0);
    const totalUnfulfilled = formattedCustomers.reduce((sum, c) => sum + c.unfulfilled_count, 0);
    const totalUnfulfilledValue = formattedCustomers.reduce((sum, c) => sum + c.unfulfilled_value, 0);
    
    const fetchTime = Math.round((Date.now() - startTime) / 1000);
    
    res.json({
      success: true,
      stats: {
        total_vips: totalVIPs,
        total_spent: totalSpent,
        avg_spent: totalVIPs > 0 ? totalSpent / totalVIPs : 0,
        total_unfulfilled_orders: totalUnfulfilled,
        total_unfulfilled_value: totalUnfulfilledValue
      },
      customers: formattedCustomers,
      cached: fromCache,
      cache_age: fromCache ? await getCacheAge() : null,
      fetch_time: fetchTime
    });
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    console.error('Error fetching VIP customers:', msg);
    res.status(status).json({ 
      success: false,
      error: msg 
    });
  }
});

// ===== NEW: ShipStation VIP Tagging Endpoints =====

/**
 * API: Sync VIP customers to ShipStation with 2026VIP tag
 * This endpoint tags all orders for VIP customers (>$1000 spent) in ShipStation
 */
router.post('/api/vip-customers/sync-to-shipstation', requireAuthApi, async (req, res) => {
  try {
    const minSpent = Number(req.body.minSpent || 1000);
    const tag = req.body.tag || '2026VIP';
    const onlyAwaitingShipment = req.body.onlyAwaitingShipment === true;
    
    console.log(`[ShipStation Sync] Starting VIP tag sync...`);
    console.log(`  Tag: ${tag}`);
    console.log(`  Min Spent: $${minSpent}`);
    console.log(`  Only Awaiting Shipment: ${onlyAwaitingShipment}`);
    
    // Get VIP customers from cache or Shopify
    let vipCustomers = await getVIPCustomersFast(minSpent);
    if (!vipCustomers) {
      console.log(`[ShipStation Sync] No cache, fetching from Shopify...`);
      vipCustomers = await shopify.getVIPCustomers(minSpent, false);
    }

    console.log(`[ShipStation Sync] Found ${vipCustomers.length} VIP customers to tag`);

    // Extract email addresses (filter out customers without email)
    const customerEmails = vipCustomers
      .filter(c => c.email && c.email.trim() !== '')
      .map(c => c.email.trim());

    console.log(`[ShipStation Sync] ${customerEmails.length} customers have valid emails`);

    if (customerEmails.length === 0) {
      return res.json({
        success: true,
        message: 'No customers with valid emails to tag',
        results: {
          totalCustomers: 0,
          totalOrdersUpdated: 0
        }
      });
    }

    // Batch tag all VIP customers in ShipStation
    // Pass orderStatus filter to optimize API calls
    const results = await shipstation.batchTagCustomers(
      customerEmails, 
      tag, 
      { 
        onlyAwaitingShipment, 
        skipCancelled: true,
        orderStatusFilter: onlyAwaitingShipment ? 'awaiting_shipment' : undefined
      }
    );
    
    console.log(`[ShipStation Sync] Complete!`);
    console.log(`  Orders Updated: ${results.totalOrdersUpdated}`);
    console.log(`  Orders Skipped: ${results.totalOrdersSkipped}`);
    console.log(`  Errors: ${results.errors.length}`);
    
    res.json({
      success: true,
      message: `Successfully tagged ${results.totalOrdersUpdated} orders for ${results.successfulCustomers} VIP customers`,
      results: {
        totalCustomers: results.totalCustomers,
        successfulCustomers: results.successfulCustomers,
        failedCustomers: results.failedCustomers,
        totalOrdersFound: results.totalOrdersFound,
        totalOrdersUpdated: results.totalOrdersUpdated,
        totalOrdersSkipped: results.totalOrdersSkipped,
        errors: results.errors.slice(0, 10)
      }
    });
    
  } catch (error) {
    console.error('[ShipStation Sync] Failed:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * API: Tag a single customer in ShipStation
 */
router.post('/api/vip-customers/tag-single', requireAuthApi, async (req, res) => {
  try {
    const { email, tag = '2026VIP', onlyAwaitingShipment = false } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is required' 
      });
    }
    
    console.log(`[ShipStation Sync] Tagging single customer: ${email}`);
    
    const result = await shipstation.addCustomerTag(
      email, 
      tag, 
      { onlyAwaitingShipment, skipCancelled: true }
    );
    
    res.json({
      success: true,
      message: `Tagged ${result.ordersUpdated} orders for ${email}`,
      result
    });
    
  } catch (error) {
    console.error('[ShipStation Sync] Failed:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// ===== END NEW ENDPOINTS =====

// Helper to get cache age
async function getCacheAge() {
  try {
    const status = await getSyncStatus();
    if (status.lastSync) {
      const age = Math.round((Date.now() - new Date(status.lastSync).getTime()) / 1000);
      return age;
    }
  } catch (e) {
    console.error('Error getting cache age:', e);
  }
  return null;
}

// API: Get cache status
router.get('/api/vip-customers/cache-status', requireAuthApi, async (req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({
      cache_type: 'sqlite',
      ...status,
      cache_ttl_hours: 2,
      background_sync_minutes: 30
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Clear cache (force refresh)
router.post('/api/vip-customers/clear-cache', requireAuthApi, async (req, res) => {
  try {
    // Fetch fresh data and save to cache
    console.log('[VIP Customers] Manual cache refresh requested');
    const minSpent = 1000;
    const vipCustomers = await shopify.getVIPCustomers(minSpent, false);
    await saveVIPCustomers(vipCustomers, minSpent); 
    
    res.json({ 
      success: true, 
      message: `Cache refreshed with ${vipCustomers.length} VIP customers` 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Export VIP customers to CSV
router.get('/api/vip-customers/export', requireAuthApi, async (req, res) => {
  try {
    const minSpent = Number(req.query.minSpent || 1000);
    
    // Try cache first for export
    let vipCustomers = await getVIPCustomersFast(minSpent);
    
    if (!vipCustomers) {
      console.log(`[VIP Export] No cache, fetching fresh data`);
      vipCustomers = await shopify.getVIPCustomers(minSpent, false);
    }
    
    // Create CSV headers
    const headers = [
      'Customer ID',
      'Email',
      'Name',
      'Total Spent',
      'Total Orders',
      'Unfulfilled Orders',
      'Unfulfilled Value',
      'Customer Since',
      'Tags',
      'Note',
      'Last Order'
    ];
    
    // Create CSV rows
    const rows = vipCustomers.map(customer => [
      customer.id,
      customer.email,
      `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      customer.total_spent || 0,
      customer.orders_count || 0,
      customer.unfulfilled_count || 0,
      customer.unfulfilled_value || 0,
      customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '',
      customer.tags || '',
      (customer.note || '').replace(/[\n\r,]/g, ' '),
      customer.last_order_name || ''
    ]);
    
    // Convert to CSV format
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => {
        const str = String(cell || '');
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"` 
          : str;
      }).join(','))
    ].join('\n');
    
    // Send as downloadable CSV
    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="vip_customers_${timestamp}.csv"`);
    res.send(csvContent);
    
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message;
    console.error('Error exporting VIP customers:', msg);
    res.status(status).json({ 
      success: false,
      error: msg 
    });
  }
});

module.exports = router;