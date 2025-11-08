// utils/customs-manager.js - Handles CUSMA database and customs declarations
const fs = require('fs').promises;
const path = require('path');

class CustomsManager {
  constructor() {
    this.customsData = new Map(); // Map of SKU -> customs info
    this.loaded = false;
  }

  /**
   * Load CUSMA database from CSV file
   * The CSV should have columns: SKU, CustomsDescription, CustomsTariffNo, CustomsCountry
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
          tariffNumber: values[2] || '9999999999', // Default HS code if missing
          countryOfOrigin: values[3] || 'CA'
        };
        
        // Store in map using SKU as key
        this.customsData.set(customsInfo.sku.toUpperCase(), customsInfo);
      }
      
      // Add the complimentary stickers item to the database
      this.customsData.set('LIST-DEF', {
        sku: 'LIST-DEF',
        description: 'Paper sticker',
        tariffNumber: '4911998000', // HS code for paper labels/stickers
        countryOfOrigin: 'CA'
      });
      
      this.loaded = true;
      console.log(`[CustomsManager] Loaded ${this.customsData.size} customs entries`);
      
      return true;
    } catch (error) {
      console.error('[CustomsManager] Error loading CUSMA database:', error);
      throw error;
    }
  }

  /**
   * Get customs information for a SKU
   * @param {string} sku - The SKU to look up
   * @returns {object} Customs information object
   */
  getCustomsInfo(sku) {
    if (!this.loaded) {
      console.warn('[CustomsManager] CUSMA database not loaded yet');
      return this.getDefaultCustomsInfo(sku);
    }
    
    // Try exact match first (uppercase)
    const upperSku = sku.toUpperCase();
    if (this.customsData.has(upperSku)) {
      return this.customsData.get(upperSku);
    }
    
    // Try to find partial match (for variants)
    // Remove size/color suffixes and try again
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
   * Create customs items array for ShipStation from order items
   * @param {array} orderItems - Array of order items
   * @returns {array} Array of customs items formatted for ShipStation
   */
  createCustomsItems(orderItems) {
    const customsItems = [];
    
    for (const item of orderItems) {
      const customsInfo = this.getCustomsInfo(item.sku || item.lineItemKey || '');
      
      customsItems.push({
        customsItemId: item.orderItemId || null, // Link to order item if available
        description: customsInfo.description,
        quantity: item.quantity || 1,
        value: item.unitPrice || item.price || 0,
        harmonizedTariffCode: customsInfo.tariffNumber,
        countryOfOrigin: customsInfo.countryOfOrigin
      });
    }
    
    return customsItems;
  }
}

// Export singleton instance
module.exports = new CustomsManager();
