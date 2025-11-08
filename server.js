// server.js - CORRECTED ORDER
const express = require('express');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const sessionMiddleware = require('./middleware/session-config');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8080;
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);
// ❌ DON'T mount routes here - too early!

// Debug logging for ALL requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  // ... rest of debug logging
  next();
});

// Serve static client assets
app.use(express.static('public'));

// ==================== ROUTES ====================

// Import route modules
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const shipstationRoutes = require('./routes/shipstation');
const vipCustomersRoutes = require('./routes/vip-customers');
const orderFormatterRoutes = require('./routes/order-formatter');
const orderChangeDetectorRoutes = require('./routes/order-change-detector');
const orderItemAdderRoutes = require('./routes/order-item-adder'); // ← Move import here

// Mount routes (ALL TOGETHER)
app.use(authRoutes);
app.use(productRoutes);
app.use(shipstationRoutes);
app.use(vipCustomersRoutes);
app.use(orderFormatterRoutes);
app.use(orderChangeDetectorRoutes);
app.use(orderItemAdderRoutes); // ← ADD HERE, not at line 20

// ==================== ERROR HANDLING ====================

// Catch-all JSON 404 for unknown API routes
app.use('/api', (req, res) => {
  console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Unified JSON error handler for API routes
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const status = err.response?.status || err.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message || 'Server error';
    return res.status(status).json({ error: msg });
  }
  next(err);
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  // Start Order Change Detector background job
  try {
    const { startOrderChangeDetectorJob } = require('./utils/order-change-detector-job');
    startOrderChangeDetectorJob();
  } catch (error) {
    console.error('[Server] Failed to start order change detector job:', error.message);
  }
  
  // Background sync every 30 minutes (FAST MODE - no order fetching)
  setInterval(async () => {
    try {
      console.log('[Background Sync] Updating VIP customer cache...');
      const { ShopifyAPI } = require('./shopify-api');
      const { saveVIPCustomers } = require('./utils/vip-cache');
      
      const shopify = new ShopifyAPI();
      // CRITICAL: Pass false as second parameter to skip order fetching (FAST MODE)
      // This makes the sync take 5-10 seconds instead of 60+ seconds
      const vips = await shopify.getVIPCustomers(1000, false);
      await saveVIPCustomers(vips);
      
      console.log('[Background Sync] Complete - cached', vips.length, 'VIP customers');
    } catch (error) {
      console.error('[Background Sync] Failed:', error.message);
    }
  }, 30 * 60 * 1000); // 30 minutes

  console.log(`
    ========================================
    Hemlock & Oak tools (Refactored)
    ========================================
    - Product Manager:        http://localhost:${PORT}/
    - ShipStation Customs:    http://localhost:${PORT}/shipstation
    - VIP Customers:          http://localhost:${PORT}/vip-customers
    - Order Formatter:        http://localhost:${PORT}/order-formatter
    - Order Change Detector:  http://localhost:${PORT}/order-change-detector
    - Order Item Adder:       http://localhost:${PORT}/order-item-adder  ← ADD THIS
    ========================================
    Server running on port ${PORT}
    ========================================
  `);
});