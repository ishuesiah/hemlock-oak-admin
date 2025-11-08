// routes/order-item-adder.js - Route handler for adding items to ShipStation orders
const express = require('express');
const router = express.Router();
const { ShipStationAPIEnhanced } = require('../shipstation-api-enhanced');
const customsManager = require('../utils/customs-manager');
const path = require('path');

// Initialize customs manager on startup
(async () => {
  try {
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
        await customsManager.loadCUSMADatabase(csvPath);
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
 * GET /order-item-adder - Serve the UI page
 */
router.get('/order-item-adder', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Add Items to ShipStation Orders | Hemlock & Oak</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            width: 100%;
            max-width: 800px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 25px;
        }
        label {
            display: block;
            color: #555;
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 14px;
        }
        textarea {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            font-family: 'Courier New', monospace;
            transition: border-color 0.3s;
            resize: vertical;
            min-height: 120px;
        }
        textarea:focus {
            outline: none;
            border-color: #667eea;
        }
        .item-config {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .item-config h3 {
            color: #444;
            margin-bottom: 15px;
            font-size: 16px;
        }
        .config-row {
            display: grid;
            grid-template-columns: 1fr 2fr 1fr;
            gap: 15px;
            margin-bottom: 15px;
        }
        input[type="text"], input[type="number"] {
            padding: 10px;
            border: 2px solid #e0e0e0;
            border-radius: 6px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input[type="text"]:focus, input[type="number"]:focus {
            outline: none;
            border-color: #667eea;
        }
        .checkbox-group {
            background: #fff;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
        }
        .checkbox-label {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            cursor: pointer;
        }
        .checkbox-label:last-child {
            margin-bottom: 0;
        }
        .checkbox-label input[type="checkbox"] {
            margin-right: 10px;
            width: 18px;
            height: 18px;
            cursor: pointer;
        }
        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 14px 30px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            display: inline-block;
            margin-right: 10px;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        .btn-secondary {
            background: #6c757d;
        }
        .btn-secondary:hover {
            box-shadow: 0 10px 20px rgba(108, 117, 125, 0.4);
        }
        .results {
            margin-top: 30px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            display: none;
        }
        .results.show {
            display: block;
        }
        .results h3 {
            color: #333;
            margin-bottom: 15px;
        }
        .result-item {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 10px;
            border-left: 4px solid #28a745;
        }
        .result-item.error {
            border-left-color: #dc3545;
        }
        .result-item.skipped {
            border-left-color: #ffc107;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat {
            background: white;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #667eea;
        }
        .stat-label {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .loading.show {
            display: block;
        }
        .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .help-text {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎁 Add Items to ShipStation Orders</h1>
        <p class="subtitle">Add complimentary items and update customs declarations</p>
        
        <form id="addItemForm">
            <div class="item-config">
                <h3>Item Configuration</h3>
                <div class="config-row">
                    <div>
                        <label>SKU</label>
                        <input type="text" id="itemSku" value="LIST-DEF" placeholder="SKU">
                    </div>
                    <div>
                        <label>Product Name</label>
                        <input type="text" id="itemName" value="Complimentary stickers" placeholder="Product name">
                    </div>
                    <div>
                        <label>Price ($)</label>
                        <input type="number" id="itemPrice" value="1.00" step="0.01" min="0" placeholder="0.00">
                    </div>
                </div>
                <div class="checkbox-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="useDefaultItem" checked>
                        <span>Use default item (Complimentary stickers, $1.00)</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="updateCustomsOnly">
                        <span>Only update customs declarations (don't add item)</span>
                    </label>
                </div>
            </div>
            
            <div class="form-group">
                <label for="orderNumbers">Order Numbers</label>
                <textarea 
                    id="orderNumbers" 
                    name="orderNumbers" 
                    placeholder="Enter order numbers, one per line or comma-separated&#10;&#10;Example:&#10;HO-1234&#10;HO-1235&#10;HO-1236&#10;&#10;Or: HO-1234, HO-1235, HO-1236"
                    rows="8"
                ></textarea>
                <div class="help-text">
                    Enter Shopify order numbers (e.g., HO-1234) to add the item to each order
                </div>
            </div>
            
            <button type="submit" class="btn" id="submitBtn">Add Item to Orders</button>
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('orderNumbers').value=''">Clear</button>
        </form>
        
        <div class="loading" id="loading">
            <div class="spinner"></div>
            <p>Processing orders... Please wait.</p>
        </div>
        
        <div class="results" id="results">
            <h3>Results</h3>
            <div class="stats" id="stats"></div>
            <div id="resultDetails"></div>
        </div>
    </div>
    
    <script>
        // Handle checkbox interactions
        document.getElementById('useDefaultItem').addEventListener('change', function() {
            const useDefault = this.checked;
            document.getElementById('itemSku').disabled = useDefault;
            document.getElementById('itemName').disabled = useDefault;
            document.getElementById('itemPrice').disabled = useDefault;
            
            if (useDefault) {
                document.getElementById('itemSku').value = 'LIST-DEF';
                document.getElementById('itemName').value = 'Complimentary stickers';
                document.getElementById('itemPrice').value = '1.00';
            }
        });
        
        // Initialize with default item
        document.getElementById('itemSku').disabled = true;
        document.getElementById('itemName').disabled = true;
        document.getElementById('itemPrice').disabled = true;
        
        document.getElementById('addItemForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const orderNumbersText = document.getElementById('orderNumbers').value.trim();
            if (!orderNumbersText) {
                alert('Please enter at least one order number');
                return;
            }
            
            // Parse order numbers (handle both newlines and commas)
            const orderNumbers = orderNumbersText
                .split(/[,\\n]+/)
                .map(num => num.trim())
                .filter(num => num.length > 0);
            
            if (orderNumbers.length === 0) {
                alert('Please enter valid order numbers');
                return;
            }
            
            const useDefault = document.getElementById('useDefaultItem').checked;
            const customsOnly = document.getElementById('updateCustomsOnly').checked;
            
            // Prepare item data if not using default
            let itemData = null;
            if (!useDefault && !customsOnly) {
                itemData = {
                    sku: document.getElementById('itemSku').value,
                    name: document.getElementById('itemName').value,
                    price: parseFloat(document.getElementById('itemPrice').value)
                };
            }
            
            // Prepare request data
            const requestData = {
                orderNumbers: orderNumbers,
                customsOnly: customsOnly
            };
            
            if (itemData) {
                requestData.item = itemData;
            }
            
            // Show loading
            document.getElementById('loading').classList.add('show');
            document.getElementById('results').classList.remove('show');
            document.getElementById('submitBtn').disabled = true;
            
            try {
                const response = await fetch('/api/shipstation/orders/add-item', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestData)
                });
                
                const result = await response.json();
                
                if (!response.ok) {
                    throw new Error(result.error || 'Failed to add items');
                }
                
                // Display results
                displayResults(result);
                
            } catch (error) {
                alert('Error: ' + error.message);
                console.error('Error:', error);
            } finally {
                document.getElementById('loading').classList.remove('show');
                document.getElementById('submitBtn').disabled = false;
            }
        });
        
        function displayResults(result) {
            // Show results section
            document.getElementById('results').classList.add('show');
            
            // Display stats
            const statsHtml = \`
                <div class="stat">
                    <div class="stat-value">\${result.total || 0}</div>
                    <div class="stat-label">Total Orders</div>
                </div>
                <div class="stat">
                    <div class="stat-value" style="color: #28a745">\${result.successful || 0}</div>
                    <div class="stat-label">Successful</div>
                </div>
                <div class="stat">
                    <div class="stat-value" style="color: #ffc107">\${result.skipped || 0}</div>
                    <div class="stat-label">Skipped</div>
                </div>
                <div class="stat">
                    <div class="stat-value" style="color: #dc3545">\${result.failed || 0}</div>
                    <div class="stat-label">Failed</div>
                </div>
            \`;
            document.getElementById('stats').innerHTML = statsHtml;
            
            // Display details
            let detailsHtml = '';
            if (result.details && result.details.length > 0) {
                result.details.forEach(detail => {
                    const statusClass = detail.status === 'error' ? 'error' : 
                                      detail.message?.includes('already exists') ? 'skipped' : '';
                    
                    detailsHtml += \`
                        <div class="result-item \${statusClass}">
                            <strong>Order \${detail.orderNumber}</strong><br>
                            \${detail.status === 'error' ? 
                                \`❌ Error: \${detail.error}\` : 
                                \`✅ \${detail.message || 'Success'}\`
                            }
                            \${detail.itemsCount ? \`<br>Items: \${detail.itemsCount}\` : ''}
                            \${detail.customsCount ? \` | Customs: \${detail.customsCount}\` : ''}
                        </div>
                    \`;
                });
            } else {
                detailsHtml = '<p>No details available</p>';
            }
            
            document.getElementById('resultDetails').innerHTML = detailsHtml;
        }
    </script>
</body>
</html>
  `);
});

/**
 * POST /api/shipstation/orders/add-item - Add item to orders
 */
router.post('/api/shipstation/orders/add-item', async (req, res) => {
  try {
    const { orderNumbers, item, customsOnly } = req.body;
    
    if (!orderNumbers || !Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({ error: 'Order numbers array is required' });
    }
    
    // Initialize ShipStation API
    const shipstation = new ShipStationAPIEnhanced();
    
    // Process based on mode
    let results;
    
    if (customsOnly) {
      // Only update customs declarations
      results = {
        total: orderNumbers.length,
        successful: 0,
        failed: 0,
        details: []
      };
      
      for (const orderNumber of orderNumbers) {
        try {
          const result = await shipstation.updateOrderCustomsDeclarations(orderNumber);
          results.successful++;
          results.details.push({
            orderNumber,
            status: 'success',
            message: result.message,
            customsCount: result.customsCount
          });
        } catch (error) {
          results.failed++;
          results.details.push({
            orderNumber,
            status: 'error',
            error: error.message
          });
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      // Add item to orders
      let itemToAdd = null;
      
      if (item && item.sku && item.name) {
        // Custom item provided
        itemToAdd = {
          lineItemKey: `${item.sku}-${Date.now()}`,
          sku: item.sku,
          name: item.name,
          imageUrl: null,
          weight: {
            value: 0.1,
            units: 'ounces'
          },
          quantity: 1,
          unitPrice: item.price || 0,
          taxAmount: 0,
          shippingAmount: 0,
          warehouseLocation: null,
          options: [],
          productId: null,
          fulfillmentSku: item.sku,
          adjustment: false,
          upc: null
        };
      }
      
      // Use batch function
      results = await shipstation.batchAddItemToOrders(orderNumbers, itemToAdd);
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

/**
 * POST /api/shipstation/orders/load-cusma - Load CUSMA database
 */
router.post('/api/shipstation/orders/load-cusma', async (req, res) => {
  try {
    const { csvPath } = req.body;
    
    if (!csvPath) {
      return res.status(400).json({ error: 'CSV path is required' });
    }
    
    await customsManager.loadCUSMADatabase(csvPath);
    
    res.json({
      success: true,
      message: `Loaded ${customsManager.customsData.size} customs entries`,
      entriesCount: customsManager.customsData.size
    });
    
  } catch (error) {
    console.error('[API] Error loading CUSMA database:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
