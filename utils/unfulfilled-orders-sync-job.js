// utils/unfulfilled-orders-sync-job.js - Background job to sync unfulfilled orders
const { ShipStationAPI } = require('../shipstation-add-item');
const { saveUnfulfilledOrders, loadUnfulfilledOrders } = require('./unfulfilled-orders-cache');

let syncInterval = null;
let isSyncing = false;

/**
 * Sync unfulfilled orders from ShipStation to cache
 */
async function syncUnfulfilledOrders() {
  if (isSyncing) {
    console.log('[Orders Sync] Sync already in progress, skipping...');
    return;
  }

  try {
    isSyncing = true;
    console.log('[Orders Sync] Starting sync of unfulfilled orders...');

    const api = new ShipStationAPI();
    await api.loadCUSMA('./data/CUSMA.csv').catch(() => {
      console.log('[Orders Sync] CUSMA database not loaded, continuing without it');
    });

    // Fetch ALL unfulfilled orders (handles pagination automatically)
    const orders = await api.getAllUnfulfilledOrders();

    // Save to cache
    await saveUnfulfilledOrders(orders);

    console.log(`[Orders Sync] ✅ Sync complete - ${orders.length} unfulfilled orders cached`);
    return orders;
  } catch (error) {
    console.error('[Orders Sync] ❌ Error syncing unfulfilled orders:', error.message);
    throw error;
  } finally {
    isSyncing = false;
  }
}

/**
 * Start the background sync job (runs every 30 minutes)
 */
function startUnfulfilledOrdersSyncJob() {
  if (syncInterval) {
    console.log('[Orders Sync] Job already running');
    return;
  }

  console.log('[Orders Sync] Starting background sync job (every 30 minutes)');

  // Run immediately on startup
  syncUnfulfilledOrders().catch(error => {
    console.error('[Orders Sync] Initial sync failed:', error.message);
  });

  // Then run every 30 minutes
  syncInterval = setInterval(async () => {
    try {
      await syncUnfulfilledOrders();
    } catch (error) {
      console.error('[Orders Sync] Background sync failed:', error.message);
    }
  }, 30 * 60 * 1000); // 30 minutes

  console.log('[Orders Sync] Background job started');
}

/**
 * Stop the background sync job
 */
function stopUnfulfilledOrdersSyncJob() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    console.log('[Orders Sync] Background job stopped');
  }
}

/**
 * Force a manual sync
 */
async function forceSyncUnfulfilledOrders() {
  console.log('[Orders Sync] Manual sync triggered');
  return await syncUnfulfilledOrders();
}

module.exports = {
  startUnfulfilledOrdersSyncJob,
  stopUnfulfilledOrdersSyncJob,
  syncUnfulfilledOrders,
  forceSyncUnfulfilledOrders
};
