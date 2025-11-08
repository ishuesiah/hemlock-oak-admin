// utils/order-change-detector-job.js - Background job for automatic order change detection
const { ShipStationAPI } = require('../shipstation-api.js');
const { ShopifyAPI } = require('../shopify-api.js');
const fs = require('fs');
const path = require('path');

// Initialize APIs
const shipstation = new ShipStationAPI();
const shopify = new ShopifyAPI();

// Cache file to track processed orders (prevents re-checking same orders)
const CACHE_FILE = path.join(__dirname, '../data/order-change-cache.json');

// Job configuration
const JOB_CONFIG = {
  enabled: process.env.ORDER_CHANGE_DETECTOR_ENABLED !== 'false', // Enable by default
  intervalMinutes: parseInt(process.env.ORDER_CHANGE_DETECTOR_INTERVAL) || 15, // Run every 15 minutes by default
  hoursToScan: parseInt(process.env.ORDER_CHANGE_DETECTOR_HOURS) || 24, // Check last 24 hours
  autoTag: process.env.ORDER_CHANGE_DETECTOR_AUTO_TAG === 'true', // Auto-tag if enabled
  maxOrdersPerRun: parseInt(process.env.ORDER_CHANGE_DETECTOR_MAX_ORDERS) || 500 // Max orders per scan
};

// Job state
let lastRunTime = null;
let isRunning = false;
let jobStats = {
  totalRuns: 0,
  lastRunDate: null,
  lastRunDuration: 0,
  ordersScanned: 0,
  changesDetected: 0,
  ordersTagged: 0,
  errors: []
};

/**
 * Load order change cache from disk
 * Cache structure: { orderId: { lastChecked, hasChanges, changes, tagged } }
 */
function loadCache() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[Order Change Job] Failed to load cache:', error.message);
  }
  return {};
}

/**
 * Save order change cache to disk
 */
function saveCache(cache) {
  try {
    const dataDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.error('[Order Change Job] Failed to save cache:', error.message);
  }
}

/**
 * Clean old entries from cache (older than 7 days)
 */
function cleanCache(cache) {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let cleaned = 0;
  
  for (const orderId in cache) {
    if (cache[orderId].lastChecked < sevenDaysAgo) {
      delete cache[orderId];
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Order Change Job] Cleaned ${cleaned} old entries from cache`);
  }
  
  return cache;
}

/**
 * Check if an item is a discount/promo code based on common patterns
 * Returns true if the item appears to be a discount code
 * 
 * This function checks multiple signals:
 * 1. Price = $0 or negative (discount codes typically have zero/negative price)
 * 2. Keywords like "discount", "referral", "affiliate", "promo", "coupon"
 * 3. Common SKU patterns used for discount codes:
 *    - NAME+NUMBER (e.g., ELIZA10, NICOLE10, AMANDA20)
 *    - Random alphanumeric (e.g., WH4WW9Z7, PS7GB8N8)
 *    - All-caps names (e.g., AMANDASFAVORITES, AIKA)
 */
function isDiscountOrPromoCode(sku, name, price = null) {
  // FILTER 1: Check if price is $0 or negative (most discount codes have zero/negative price)
  if (price !== null) {
    const numPrice = parseFloat(price);
    if (numPrice <= 0) {
      return true;
    }
  }
  
  // FILTER 2: Check name/SKU for discount keywords
  const text = `${name || ''} ${sku || ''}`.toLowerCase();
  const discountKeywords = ['discount', 'referral', 'affiliate', 'promo', 'coupon', 'code', 'voucher'];
  if (discountKeywords.some(keyword => text.includes(keyword))) {
    return true;
  }
  
  // FILTER 3: Check for common discount code patterns in the SKU
  const skuUpper = (sku || '').trim().toUpperCase();
  if (skuUpper) {
    // Pattern 1: NAME + NUMBER (e.g., ELIZA10, NICOLE10, ELLEN10, AMANDA20)
    // Letters followed by numbers, all caps, 4-20 chars
    // This catches referral codes like "FRIENDNAME10" or "INFLUENCER15"
    if (/^[A-Z]{2,15}\d{1,4}$/.test(skuUpper)) {
      return true;
    }
    
    // Pattern 2: Random alphanumeric codes (e.g., WH4WW9Z7, PS7GB8N8, HG6NRFNG, 95QNGP4Z)
    // 6-10 characters, mix of letters and numbers, no spaces
    // These are often auto-generated discount codes
    if (/^[A-Z0-9]{6,10}$/.test(skuUpper) && /[A-Z]/.test(skuUpper) && /[0-9]/.test(skuUpper)) {
      // Additional check: if it has alternating letters/numbers, it's likely a generated code
      const hasAlternating = /([A-Z]\d|\d[A-Z])/.test(skuUpper);
      if (hasAlternating) {
        return true;
      }
    }
    
    // Pattern 3: All caps names without numbers (e.g., AMANDASFAVORITES, AIKA)
    // But only if it's unusual (not a typical product SKU format)
    // Real product SKUs usually have dashes, underscores, or mixed case
    if (/^[A-Z]{4,20}$/.test(skuUpper) && !skuUpper.includes('-') && !skuUpper.includes('_')) {
      // Check if it looks like a person's name or contains "favorite/favourite"
      const nameLikeWords = ['FAVORITES', 'FAVOURITES', 'PICK', 'CHOICE', 'SPECIAL'];
      if (nameLikeWords.some(word => skuUpper.includes(word))) {
        return true;
      }
      // If it's a short all-caps name (4-12 chars), likely a referral code
      // (e.g., AIKA, AMANDA, NICOLE)
      if (skuUpper.length >= 4 && skuUpper.length <= 12) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Compare Shopify and ShipStation line items
 * 
 * IMPORTANT: This function ONLY compares actual product line items.
 * It filters out:
 * - Discount codes (detected by $0 price, negative price, or code patterns)
 * - Promotional codes (referral codes, affiliate codes)
 * - Gift cards
 * - Tips
 * - Any non-product items (items without product_id in Shopify)
 * 
 * This ensures that order change alerts are ONLY triggered for real product changes,
 * not when discount codes or promotional items are added/removed.
 */
function compareOrderItems(shopifyOrder, shipstationOrder) {
  const shopifyItems = shopifyOrder.line_items || [];
  const shipstationItems = shipstationOrder.items || [];
  
  // FILTER: Only include actual products from Shopify
  // Exclude discounts, gift cards, tips, and other non-product items
  const shopifyProductItems = shopifyItems.filter(item => {
    // Must have a product_id (real products have this, discounts/tips don't)
    // However, discount codes might still have a product_id if they're set up as products
    if (!item.product_id) {
      return false;
    }
    
    // Exclude gift cards (gift_card = true)
    if (item.gift_card === true) {
      return false;
    }
    
    // NEW: Check if this is a discount/promo code based on price and pattern
    // Most discount codes have price = $0
    if (isDiscountOrPromoCode(item.sku, item.name, item.price)) {
      console.log(`[Filter] Excluding Shopify item "${item.name}" (SKU: ${item.sku}, Price: $${item.price}) - detected as discount/promo code`);
      return false;
    }
    
    return true; // This is a real product
  });
  
  // FILTER: Only include actual products from ShipStation
  const shipstationProductItems = shipstationItems.filter(item => {
    // Exclude any items without a name
    if (!item.name || item.name.trim() === '') {
      return false;
    }
    
    // NEW: Check if this is a discount/promo code based on price and pattern
    // ShipStation discount items typically have unitPrice = 0
    if (isDiscountOrPromoCode(item.sku, item.name, item.unitPrice)) {
      console.log(`[Filter] Excluding ShipStation item "${item.name}" (SKU: ${item.sku}, Price: $${item.unitPrice || 0}) - detected as discount/promo code`);
      return false;
    }
    
    return true; // This is a real product
  });
  
  const shopifyItemMap = new Map();
  const shipstationItemMap = new Map();
  
  // Build Shopify item map (aggregate by SKU)
  shopifyProductItems.forEach(item => {
    const sku = item.sku || item.name;
    const existing = shopifyItemMap.get(sku);
    
    if (existing) {
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
  
  // Build ShipStation item map (aggregate by SKU)
  shipstationProductItems.forEach(item => {
    const sku = item.sku || item.name;
    const existing = shipstationItemMap.get(sku);
    
    if (existing) {
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
  
  // Check for removed or quantity changed items
  for (const [sku, shopifyItem] of shopifyItemMap) {
    const shipstationItem = shipstationItemMap.get(sku);
    
    if (!shipstationItem) {
      hasChanges = true;
      changes.push({
        type: 'removed',
        sku: sku,
        name: shopifyItem.name,
        quantity: shopifyItem.quantity,
        description: `Item "${shopifyItem.name}" (SKU: ${sku}) was removed from ShipStation (${shopifyItem.quantity} units)`
      });
    } else if (shipstationItem.quantity !== shopifyItem.quantity) {
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
  
  // Check for added items
  for (const [sku, shipstationItem] of shipstationItemMap) {
    const shopifyItem = shopifyItemMap.get(sku);
    
    if (!shopifyItem) {
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
      shopifyItemCount: shopifyProductItems.length,
      shipstationItemCount: shipstationProductItems.length,
      shopifyItems: Array.from(shopifyItemMap.entries()).map(([sku, item]) => ({
        sku,
        name: item.name,
        quantity: item.quantity
      })),
      shipstationItems: Array.from(shipstationItemMap.entries()).map(([sku, item]) => ({
        sku,
        name: item.name,
        quantity: item.quantity
      }))
    }
  };
}

/**
 * Helper to get Shopify order by order number (with retry)
 */
async function getShopifyOrderByNumber(orderNumber) {
  try {
    const order = await shopify.getOrderByNumber(orderNumber);
    return order;
  } catch (error) {
    console.error(`[Order Change Job] Failed to get Shopify order ${orderNumber}:`, error.message);
    return null;
  }
}

/**
 * Run the order change detection job
 * This scans recent ShipStation orders and compares them with Shopify
 */
async function runOrderChangeDetection() {
  if (isRunning) {
    console.log('[Order Change Job] ⏸️  Job already running, skipping this run');
    return null;
  }
  
  isRunning = true;
  lastRunTime = new Date();
  const startTime = Date.now();
  
  console.log('\n========================================');
  console.log('[Order Change Job] 🔍 Starting order change detection...');
  console.log(`[Order Change Job] Time: ${lastRunTime.toISOString()}`);
  console.log('========================================\n');
  
  const runStats = {
    ordersScanned: 0,
    ordersSkipped: 0,
    changesDetected: 0,
    newChanges: 0,
    ordersTagged: 0,
    errors: []
  };
  
  try {
    // Load cache
    let cache = loadCache();
    cache = cleanCache(cache);
    
    // Get recent orders from ShipStation
    const now = new Date();
    const startDate = new Date(now.getTime() - (JOB_CONFIG.hoursToScan * 60 * 60 * 1000));
    
    console.log(`[Order Change Job] Fetching orders from ${startDate.toISOString()} to ${now.toISOString()}`);
    
    const shipstationOrders = await shipstation.searchOrders({
      modifyDateStart: startDate.toISOString(),
      modifyDateEnd: now.toISOString(),
      orderStatus: 'awaiting_shipment',
      pageSize: JOB_CONFIG.maxOrdersPerRun,
      page: 1
    });
    
    console.log(`[Order Change Job] Found ${shipstationOrders.length} orders to check`);
    
    if (shipstationOrders.length === 0) {
      console.log('[Order Change Job] ✅ No orders to check');
      isRunning = false;
      return runStats;
    }
    
    // Get "ORDER CHANGE" tag ID (create if doesn't exist)
    let orderChangeTagId = await shipstation.getTagId('ORDER CHANGE');
    
    if (!orderChangeTagId) {
      console.log('[Order Change Job] ⚠️  "ORDER CHANGE" tag not found in ShipStation');
      if (JOB_CONFIG.autoTag) {
        console.log('[Order Change Job] ⚠️  Cannot auto-tag without tag. Please create "ORDER CHANGE" tag in ShipStation.');
      }
    }
    
    // Process each order
    for (let i = 0; i < shipstationOrders.length; i++) {
      const ssOrder = shipstationOrders[i];
      const orderId = String(ssOrder.orderId);
      
      try {
        // Check cache first - skip if recently checked and no changes
        const cachedData = cache[orderId];
        const cacheAge = cachedData ? Date.now() - cachedData.lastChecked : null;
        const cacheValidHours = 6; // Re-check after 6 hours
        
        if (cachedData && cacheAge < (cacheValidHours * 60 * 60 * 1000)) {
          // Skip if already checked recently and has no changes
          if (!cachedData.hasChanges) {
            runStats.ordersSkipped++;
            continue;
          }
          
          // Skip if already tagged and has changes
          if (cachedData.hasChanges && cachedData.tagged) {
            runStats.ordersSkipped++;
            continue;
          }
        }
        
        // Get Shopify order for comparison
        const shopifyOrder = await getShopifyOrderByNumber(ssOrder.orderNumber);
        
        if (!shopifyOrder) {
          runStats.errors.push({
            orderId: ssOrder.orderId,
            orderNumber: ssOrder.orderNumber,
            error: 'No matching Shopify order found'
          });
          
          // Cache as "no shopify match"
          cache[orderId] = {
            lastChecked: Date.now(),
            hasChanges: false,
            error: 'no_shopify_match'
          };
          
          // Rate limit
          await new Promise(resolve => setTimeout(resolve, 550));
          continue;
        }
        
        // Compare orders (this now filters out discount codes automatically)
        const comparison = compareOrderItems(shopifyOrder, ssOrder);
        runStats.ordersScanned++;
        
        // Update cache
        cache[orderId] = {
          lastChecked: Date.now(),
          hasChanges: comparison.hasChanges,
          changes: comparison.changes,
          orderNumber: ssOrder.orderNumber,
          tagged: false
        };
        
        // If changes detected
        if (comparison.hasChanges) {
          runStats.changesDetected++;
          
          // Check if this is a new detection (not in cache before or cache was "no changes")
          if (!cachedData || !cachedData.hasChanges) {
            runStats.newChanges++;
            
            console.log(`\n[Order Change Job] 🚨 CHANGES DETECTED in Order #${ssOrder.orderNumber}`);
            console.log(`[Order Change Job] Order ID: ${ssOrder.orderId}`);
            console.log(`[Order Change Job] Customer: ${ssOrder.shipTo?.name || 'Unknown'}`);
            console.log(`[Order Change Job] Changes:`);
            comparison.changes.forEach(change => {
              console.log(`  - ${change.description}`);
            });
          }
          
          // Auto-tag if enabled and tag exists
          if (JOB_CONFIG.autoTag && orderChangeTagId) {
            // Check if order already has the tag
            const currentTags = ssOrder.tagIds || [];
            const alreadyTagged = currentTags.includes(orderChangeTagId);
            
            if (!alreadyTagged) {
              try {
                await shipstation.addTagToOrder(ssOrder.orderId, orderChangeTagId);
                runStats.ordersTagged++;
                cache[orderId].tagged = true;
                console.log(`[Order Change Job] ✅ Tagged order #${ssOrder.orderNumber}`);
                
                // Rate limit after tagging
                await new Promise(resolve => setTimeout(resolve, 150));
              } catch (tagError) {
                console.error(`[Order Change Job] Failed to tag order ${ssOrder.orderNumber}:`, tagError.message);
                runStats.errors.push({
                  orderId: ssOrder.orderId,
                  orderNumber: ssOrder.orderNumber,
                  error: `Tagging failed: ${tagError.message}`
                });
              }
            } else {
              cache[orderId].tagged = true;
            }
          }
        }
        
        // Rate limit between Shopify API calls (every 10 orders, show progress)
        if ((i + 1) % 10 === 0) {
          console.log(`[Order Change Job] Progress: ${i + 1}/${shipstationOrders.length} orders checked`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 550));
        
      } catch (error) {
        console.error(`[Order Change Job] Error processing order ${ssOrder.orderNumber}:`, error.message);
        runStats.errors.push({
          orderId: ssOrder.orderId,
          orderNumber: ssOrder.orderNumber,
          error: error.message
        });
      }
    }
    
    // Save updated cache
    saveCache(cache);
    
    // Update global job stats
    jobStats.totalRuns++;
    jobStats.lastRunDate = new Date();
    jobStats.lastRunDuration = Date.now() - startTime;
    jobStats.ordersScanned += runStats.ordersScanned;
    jobStats.changesDetected += runStats.changesDetected;
    jobStats.ordersTagged += runStats.ordersTagged;
    
    // Print summary
    console.log('\n========================================');
    console.log('[Order Change Job] 📊 Run Summary');
    console.log('========================================');
    console.log(`Orders scanned:      ${runStats.ordersScanned}`);
    console.log(`Orders skipped:      ${runStats.ordersSkipped} (cached)`);
    console.log(`Changes detected:    ${runStats.changesDetected}`);
    console.log(`New changes:         ${runStats.newChanges}`);
    console.log(`Orders tagged:       ${runStats.ordersTagged}`);
    console.log(`Errors:              ${runStats.errors.length}`);
    console.log(`Duration:            ${Math.round((Date.now() - startTime) / 1000)}s`);
    console.log('========================================\n');
    
    if (runStats.newChanges > 0) {
      console.log(`[Order Change Job] ⚠️  ${runStats.newChanges} orders have NEW changes that need attention!`);
    }
    
  } catch (error) {
    console.error('[Order Change Job] ❌ Job failed:', error);
    runStats.errors.push({
      error: `Job failed: ${error.message}`
    });
  } finally {
    isRunning = false;
  }
  
  return runStats;
}

/**
 * Start the background job scheduler
 */
function startOrderChangeDetectorJob() {
  if (!JOB_CONFIG.enabled) {
    console.log('[Order Change Job] ⏸️  Background job is DISABLED');
    console.log('[Order Change Job] Set ORDER_CHANGE_DETECTOR_ENABLED=true in .env to enable');
    return;
  }
  
  console.log('[Order Change Job] 🚀 Starting background job scheduler...');
  console.log(`[Order Change Job] Interval: ${JOB_CONFIG.intervalMinutes} minutes`);
  console.log(`[Order Change Job] Scan window: Last ${JOB_CONFIG.hoursToScan} hours`);
  console.log(`[Order Change Job] Auto-tag: ${JOB_CONFIG.autoTag ? 'ENABLED' : 'DISABLED'}`);
  console.log(`[Order Change Job] Max orders per run: ${JOB_CONFIG.maxOrdersPerRun}`);
  
  // Run immediately on startup
  setTimeout(() => {
    runOrderChangeDetection().catch(error => {
      console.error('[Order Change Job] Initial run failed:', error);
    });
  }, 5000); // Wait 5 seconds after server starts
  
  // Schedule recurring job
  const intervalMs = JOB_CONFIG.intervalMinutes * 60 * 1000;
  setInterval(() => {
    runOrderChangeDetection().catch(error => {
      console.error('[Order Change Job] Scheduled run failed:', error);
    });
  }, intervalMs);
  
  console.log('[Order Change Job] ✅ Background job scheduler started');
}

/**
 * Get job statistics
 */
function getJobStats() {
  return {
    ...jobStats,
    config: JOB_CONFIG,
    isRunning,
    lastRunTime,
    nextRunTime: lastRunTime ? new Date(lastRunTime.getTime() + (JOB_CONFIG.intervalMinutes * 60 * 1000)) : null
  };
}

/**
 * Manually trigger a job run (for API endpoint)
 */
async function triggerManualRun() {
  if (isRunning) {
    throw new Error('Job is already running');
  }
  
  return await runOrderChangeDetection();
}

module.exports = {
  startOrderChangeDetectorJob,
  getJobStats,
  triggerManualRun,
  JOB_CONFIG
};