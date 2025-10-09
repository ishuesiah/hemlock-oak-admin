// utils/vip-cache.js
const { getDB } = require('./database');

async function getVIPCustomersFast(minSpent = 1000) {
  const db = await getDB();
  
  // Check if we have recent data (within last 2 hours)
  const lastSync = await db.get(
    'SELECT * FROM sync_log WHERE sync_type = "customers" ORDER BY synced_at DESC LIMIT 1'
  );
  
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const lastSyncTime = new Date(lastSync.synced_at).getTime();
  const needsSync = !lastSync || lastSyncTime < twoHoursAgo;
  
  if (needsSync) {
    console.log('[DB] Data is stale or missing');
    return null; // Trigger fresh fetch
  }
  
  console.log('[DB] Loading from database (instant!)');
  
  // Get VIP customers from cache
  const customers = await db.all(`
    SELECT c.*, 
           COUNT(DISTINCT co.id) as unfulfilled_count,
           COALESCE(SUM(co.total_price), 0) as unfulfilled_value
    FROM customers c
    LEFT JOIN customer_orders co ON c.id = co.customer_id AND co.unfulfilled = 1
    WHERE c.total_spent >= ?
    GROUP BY c.id
    ORDER BY c.total_spent DESC
  `, minSpent);
  
  // Parse JSON data and get unfulfilled orders
  const results = [];
  for (const c of customers) {
    const customerData = JSON.parse(c.data || '{}');
    
    // Get unfulfilled orders for this customer
    const orders = await db.all(
      'SELECT order_data FROM customer_orders WHERE customer_id = ? AND unfulfilled = 1',
      c.id
    );
    
    customerData.unfulfilled_orders = orders.map(o => JSON.parse(o.order_data));
    customerData.unfulfilled_count = c.unfulfilled_count;
    customerData.unfulfilled_value = c.unfulfilled_value;
    
    results.push(customerData);
  }
  
  return results;
}

async function saveVIPCustomers(customers) {
  const db = await getDB();
  
  console.log(`[DB] Saving ${customers.length} VIP customers to database...`);
  const startTime = Date.now();
  
  await db.run('BEGIN TRANSACTION');
  
  try {
    // Clear old data
    await db.run('DELETE FROM customers');
    await db.run('DELETE FROM customer_orders');
    
    // Insert customers
    for (const customer of customers) {
      await db.run(`
        INSERT INTO customers (id, email, first_name, last_name, total_spent, orders_count, tags, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        customer.id,
        customer.email,
        customer.first_name,
        customer.last_name,
        customer.total_spent,
        customer.orders_count,
        customer.tags,
        customer.created_at,
        JSON.stringify(customer)
      ]);
      
      // Insert unfulfilled orders
      if (customer.unfulfilled_orders && customer.unfulfilled_orders.length > 0) {
        for (const order of customer.unfulfilled_orders) {
          await db.run(`
            INSERT INTO customer_orders (id, customer_id, order_data, unfulfilled, total_price, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            order.id,
            customer.id,
            JSON.stringify(order),
            1,
            order.total_price || 0,
            order.created_at
          ]);
        }
      }
    }
    
    // Log sync
    await db.run('INSERT INTO sync_log (sync_type) VALUES ("customers")');
    
    await db.run('COMMIT');
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[DB] Saved to database in ${elapsed}s`);
    
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[DB] Save failed:', error);
    throw error;
  }
}

// Get sync status
async function getSyncStatus() {
  const db = await getDB();
  const lastSync = await db.get(
    'SELECT * FROM sync_log WHERE sync_type = "customers" ORDER BY synced_at DESC LIMIT 1'
  );
  
  const customerCount = await db.get('SELECT COUNT(*) as count FROM customers');
  
  return {
    lastSync: lastSync?.synced_at,
    customerCount: customerCount?.count || 0,
    isStale: !lastSync || new Date(lastSync.synced_at) < new Date(Date.now() - 2 * 60 * 60 * 1000)
  };
}

module.exports = { getVIPCustomersFast, saveVIPCustomers, getSyncStatus };