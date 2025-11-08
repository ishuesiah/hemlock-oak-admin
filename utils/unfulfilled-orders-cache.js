// utils/unfulfilled-orders-cache.js - Cache for ShipStation unfulfilled orders
const fs = require('fs').promises;
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/unfulfilled-orders-cache.json');
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Save unfulfilled orders to cache
 */
async function saveUnfulfilledOrders(orders) {
  try {
    const cacheData = {
      orders: orders,
      timestamp: Date.now(),
      count: orders.length
    };

    // Ensure data directory exists
    const dataDir = path.join(__dirname, '../data');
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
    }

    await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log(`[Orders Cache] Saved ${orders.length} unfulfilled orders to cache`);
    return true;
  } catch (error) {
    console.error('[Orders Cache] Error saving to cache:', error);
    return false;
  }
}

/**
 * Load unfulfilled orders from cache
 */
async function loadUnfulfilledOrders() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const cacheData = JSON.parse(data);

    const age = Date.now() - cacheData.timestamp;
    const isStale = age > CACHE_DURATION;

    console.log(`[Orders Cache] Loaded ${cacheData.count} orders from cache (age: ${Math.round(age / 1000)}s, stale: ${isStale})`);

    return {
      orders: cacheData.orders || [],
      timestamp: cacheData.timestamp,
      isStale: isStale,
      age: age
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[Orders Cache] No cache file found');
      return { orders: [], timestamp: null, isStale: true, age: null };
    }
    console.error('[Orders Cache] Error loading from cache:', error);
    return { orders: [], timestamp: null, isStale: true, age: null };
  }
}

/**
 * Check if cache exists and is fresh
 */
async function isCacheFresh() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const cacheData = JSON.parse(data);
    const age = Date.now() - cacheData.timestamp;
    return age < CACHE_DURATION;
  } catch {
    return false;
  }
}

/**
 * Clear the cache
 */
async function clearCache() {
  try {
    await fs.unlink(CACHE_FILE);
    console.log('[Orders Cache] Cache cleared');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true; // Already doesn't exist
    }
    console.error('[Orders Cache] Error clearing cache:', error);
    return false;
  }
}

module.exports = {
  saveUnfulfilledOrders,
  loadUnfulfilledOrders,
  isCacheFresh,
  clearCache,
  CACHE_DURATION
};
