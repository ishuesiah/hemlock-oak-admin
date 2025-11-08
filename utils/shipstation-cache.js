// utils/shipstation-cache.js
const { getDB } = require('./database');

/**
 * Get orders from cache, filtering by search term
 */
async function getCachedOrders(searchTerms = []) {
  const db = await getDB();

  // Get all orders with their items
  const orders = await db.all(`
    SELECT
      o.order_id,
      o.order_number,
      o.order_date,
      o.order_status,
      o.customer_name,
      o.customer_email,
      o.order_data
    FROM shipstation_orders o
    ORDER BY o.order_date DESC
  `);

  const results = [];

  for (const order of orders) {
    // Get items for this order
    const items = await db.all(
      'SELECT sku, name, quantity, options FROM shipstation_order_items WHERE order_id = ?',
      order.order_id
    );

    // Parse stored JSON
    const parsedItems = items.map(item => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      options: item.options ? JSON.parse(item.options) : []
    }));

    // If search terms provided, filter orders
    if (searchTerms && searchTerms.length > 0) {
      const matchesSearch = parsedItems.some(item => {
        const sku = String(item.sku || '').toLowerCase();
        const name = String(item.name || '').toLowerCase();

        // Check SKU and name
        for (const keyword of searchTerms) {
          if (sku.includes(keyword) || name.includes(keyword)) {
            return true;
          }
        }

        // Check options
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

        return false;
      });

      if (!matchesSearch) continue;
    }

    // Parse order data
    const orderData = JSON.parse(order.order_data);

    // Add matching items to result
    let matchingItems = parsedItems;
    if (searchTerms && searchTerms.length > 0) {
      matchingItems = parsedItems.filter(item => {
        const sku = String(item.sku || '').toLowerCase();
        const name = String(item.name || '').toLowerCase();

        if (searchTerms.some(keyword => sku.includes(keyword) || name.includes(keyword))) {
          return true;
        }

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
    }

    results.push({
      orderId: orderData.orderId,
      orderNumber: orderData.orderNumber,
      orderKey: orderData.orderKey,
      orderDate: orderData.orderDate,
      orderStatus: orderData.orderStatus,
      customerName: orderData.customerName,
      customerEmail: orderData.customerEmail,
      itemCount: parsedItems.length,
      matchingItems: matchingItems,
      shipStationUrl: orderData.shipStationUrl
    });
  }

  return results;
}

/**
 * Save orders to cache
 */
async function saveCachedOrders(orders) {
  const db = await getDB();

  console.log(`[DB] Saving ${orders.length} orders to cache...`);
  const startTime = Date.now();

  await db.run('BEGIN TRANSACTION');

  try {
    // Clear old data
    await db.run('DELETE FROM shipstation_orders');
    await db.run('DELETE FROM shipstation_order_items');

    // Insert orders
    for (const order of orders) {
      await db.run(`
        INSERT INTO shipstation_orders (order_id, order_number, order_date, order_status, customer_name, customer_email, order_data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        order.orderId,
        order.orderNumber,
        order.orderDate,
        order.orderStatus,
        order.customerName,
        order.customerEmail,
        JSON.stringify(order)
      ]);

      // Insert order items
      if (order.matchingItems && order.matchingItems.length > 0) {
        for (const item of order.matchingItems) {
          await db.run(`
            INSERT INTO shipstation_order_items (order_id, sku, name, quantity, options)
            VALUES (?, ?, ?, ?, ?)
          `, [
            order.orderId,
            item.sku,
            item.name,
            item.quantity,
            JSON.stringify(item.options || [])
          ]);
        }
      }
    }

    // Log sync
    await db.run('INSERT INTO sync_log (sync_type) VALUES ("shipstation_orders")');

    await db.run('COMMIT');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[DB] Saved ${orders.length} orders to cache in ${elapsed}s`);

  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[DB] Save failed:', error);
    throw error;
  }
}

/**
 * Get cache sync status
 */
async function getCacheSyncStatus() {
  const db = await getDB();
  const lastSync = await db.get(
    'SELECT * FROM sync_log WHERE sync_type = "shipstation_orders" ORDER BY synced_at DESC LIMIT 1'
  );

  const orderCount = await db.get('SELECT COUNT(*) as count FROM shipstation_orders');
  const itemCount = await db.get('SELECT COUNT(*) as count FROM shipstation_order_items');

  return {
    lastSync: lastSync?.synced_at || null,
    orderCount: orderCount?.count || 0,
    itemCount: itemCount?.count || 0,
    isStale: !lastSync || new Date(lastSync.synced_at) < new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours
  };
}

/**
 * Check if cache is available and fresh
 */
async function isCacheFresh(maxAgeHours = 24) {
  const db = await getDB();
  const lastSync = await db.get(
    'SELECT * FROM sync_log WHERE sync_type = "shipstation_orders" ORDER BY synced_at DESC LIMIT 1'
  );

  if (!lastSync) return false;

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const lastSyncTime = new Date(lastSync.synced_at).getTime();

  return (Date.now() - lastSyncTime) < maxAgeMs;
}

module.exports = {
  getCachedOrders,
  saveCachedOrders,
  getCacheSyncStatus,
  isCacheFresh
};
