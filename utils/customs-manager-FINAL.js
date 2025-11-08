// utils/customs-manager-FINAL.js - Following YOUR existing patterns
const fs = require('fs').promises;
const path = require('path');

class CustomsManager {
  constructor() {
    this.customsData = new Map(); // Map of SKU -> customs info
    this.loaded = false;
  }

  /**
   * Load CUSMA database from CSV file
   */
  async loadCUSMADatabase(csvPath) {
    try {
      console.log('[CustomsManager] Loading CUSMA database from:', csvPath);
      
      // Read the CSV file
      const fileContent = await fs.readFile(csvPath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());
      
      // Skip header row
      const header = lines[0].split(',').map(h => h.trim());
      
      // Parse each line
      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        
        // Create customs info object
        const customsInfo = {
          sku: values[0],
          description: values[1] || 'General merchandise',
          tariffNumber: values[2] || '9999999999',
          countryOfOrigin: values[3] || 'CA'
        };
        
        // Store in map using SKU as key
        this.customsData.set(customsInfo.sku.toUpperCase(), customsInfo);
      }
      
      // Add the complimentary stickers item to the database
      this.customsData.set('LIST-DEF', {
        sku: 'LIST-DEF',
        description: 'Paper stickers (promotional material)',
        tariffNumber: '4821100010',
        countryOfOrigin: 'CA'
      });
      
      this.loaded = true;
      console.log(`[CustomsManager] Loaded ${this.customsData.size} customs entries`);
      
      return true;
    } catch (error) {
      console.error('[CustomsManager] Error loading CUSMA database:', error);
      // Don't throw - allow system to work with defaults
      return false;
    }
  }

  /**
   * Get customs information for a SKU
   */
  getCustomsInfo(sku) {
    if (!this.loaded) {
      console.warn('[CustomsManager] CUSMA database not loaded, using defaults');
      return this.getDefaultCustomsInfo(sku);
    }
    
    // Try exact match first (uppercase)
    const upperSku = sku.toUpperCase();
    if (this.customsData.has(upperSku)) {
      return this.customsData.get(upperSku);
    }
    
    // Try to find partial match (for variants)
    const baseSku = upperSku.split('-').slice(0, -1).join('-');
    if (baseSku && this.customsData.has(baseSku)) {
      return this.customsData.get(baseSku);
    }
    
    // Return default if not found
    console.log(`[CustomsManager] SKU not found in database: ${sku}, using defaults`);
    return this.getDefaultCustomsInfo(sku);
  }

  /**
   * Get default customs info for items not in database
   */
  getDefaultCustomsInfo(sku) {
    // Special handling for known SKUs
    if (sku.toUpperCase() === 'LIST-DEF') {
      return {
        sku: 'LIST-DEF',
        description: 'Paper stickers (promotional material)',
        tariffNumber: '4821100010',
        countryOfOrigin: 'CA'
      };
    }
    
    // Generic defaults based on common patterns
    const upperSku = sku.toUpperCase();
    if (upperSku.includes('PLANNER') || upperSku.includes('DAI') || upperSku.includes('DLP')) {
      return {
        sku,
        description: 'Planner agenda (bound diary)',
        tariffNumber: '4820102010',
        countryOfOrigin: 'CA'
      };
    }
    
    // Ultimate fallback
    return {
      sku,
      description: 'General merchandise',
      tariffNumber: '9999999999',
      countryOfOrigin: 'CA'
    };
  }

  /**
   * Create customs items array for ShipStation - FOLLOWING YOUR PATTERN
   * This matches the style used in your shipstation.js
   */
  createCustomsItems(orderItems) {
    const customsItems = [];
    
    for (const item of orderItems) {
      const customsInfo = this.getCustomsInfo(item.sku || item.lineItemKey || '');
      
      // Build the customs item - following YOUR pattern from shipstation.js
      // Notice we use || operators for defaults, never null
      const customsItem = {
        description: customsInfo.description || 'General merchandise',
        quantity: parseInt(item.quantity) || 1,
        value: parseFloat(item.unitPrice || item.price) || 0,
        harmonizedTariffCode: customsInfo.tariffNumber || '9999999999',
        countryOfOrigin: customsInfo.countryOfOrigin || 'CA'
      };
      
      // CRITICAL: Only add fields that have valid values
      // ShipStation doesn't like null/undefined fields
      
      // Only add customsItemId if it's a valid positive integer
      // This is the KEY fix - we DON'T include it if it's not valid
      if (item.orderItemId) {
        const itemId = parseInt(item.orderItemId);
        if (!isNaN(itemId) && itemId > 0) {
          customsItem.customsItemId = itemId;
        }
      }
      
      customsItems.push(customsItem);
    }
    
    return customsItems;
  }

  /**
   * Sanitize customs items - similar to your sanitizeCustomsItems helper
   * Ensures all values are clean and ShipStation-compatible
   */
  sanitizeCustomsItems(customsItems) {
    return customsItems.map(item => {
      const sanitized = {};
      
      // Required fields with defaults
      sanitized.description = String(item.description || 'General merchandise').trim();
      sanitized.quantity = Math.max(1, parseInt(item.quantity) || 1);
      sanitized.value = Math.max(0, parseFloat(item.value) || 0);
      sanitized.harmonizedTariffCode = String(item.harmonizedTariffCode || '9999999999').trim();
      sanitized.countryOfOrigin = String(item.countryOfOrigin || 'CA').trim().toUpperCase();
      
      // Optional field - only include if valid
      if (item.customsItemId) {
        const id = parseInt(item.customsItemId);
        if (!isNaN(id) && id > 0) {
          sanitized.customsItemId = id;
        }
      }
      
      return sanitized;
    });
  }
}

// Export singleton instance - matching your pattern
module.exports = new CustomsManager();