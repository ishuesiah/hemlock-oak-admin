// shipstation-item-builder.js - Safe item builder for ShipStation
// This helper ensures all fields are properly formatted for ShipStation API

/**
 * Build a safe item object for ShipStation that avoids null/undefined issues
 * @param {object} itemConfig - Configuration for the item
 * @returns {object} ShipStation-compatible item object
 */
function buildSafeShipStationItem(itemConfig = {}) {
  const {
    sku = 'LIST-DEF',
    name = 'Complimentary stickers',
    quantity = 1,
    unitPrice = 1.00,
    weight = 0.1,
    weightUnits = 'ounces'
  } = itemConfig;
  
  // Build item with required fields only
  const item = {
    lineItemKey: `${sku}-${Date.now()}`, // Always unique
    sku: sku,
    name: name,
    quantity: parseInt(quantity) || 1,
    unitPrice: parseFloat(unitPrice) || 0,
    taxAmount: 0,
    shippingAmount: 0,
    adjustment: false
  };
  
  // Add weight object if weight is provided
  if (weight && weight > 0) {
    item.weight = {
      value: parseFloat(weight),
      units: weightUnits
    };
  }
  
  // Optional fields - only add if they have values
  // DON'T add: imageUrl, warehouseLocation, productId, upc if they're null
  // ShipStation prefers these fields to be missing rather than null
  
  // Add empty options array (ShipStation expects this)
  item.options = [];
  
  // Set fulfillmentSku same as SKU
  item.fulfillmentSku = sku;
  
  return item;
}

/**
 * Clean up an order payload for ShipStation, removing null/undefined values
 * @param {object} payload - The order payload
 * @returns {object} Cleaned payload
 */
function cleanShipStationPayload(payload) {
  // Function to recursively remove null/undefined values
  function removeNulls(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => removeNulls(item));
    } else if (obj !== null && typeof obj === 'object') {
      return Object.entries(obj).reduce((acc, [key, value]) => {
        if (value !== null && value !== undefined) {
          // Special handling for certain fields
          if (key === 'customsItems' && Array.isArray(value)) {
            // Clean each customs item
            acc[key] = value.map(item => {
              const cleaned = {};
              // Only include non-null fields
              if (item.description) cleaned.description = item.description;
              if (item.quantity) cleaned.quantity = parseInt(item.quantity) || 1;
              if (item.value !== undefined) cleaned.value = parseFloat(item.value) || 0;
              if (item.harmonizedTariffCode) cleaned.harmonizedTariffCode = item.harmonizedTariffCode;
              if (item.countryOfOrigin) cleaned.countryOfOrigin = item.countryOfOrigin;
              // Only include customsItemId if it's a valid positive integer
              if (item.customsItemId && parseInt(item.customsItemId) > 0) {
                cleaned.customsItemId = parseInt(item.customsItemId);
              }
              return cleaned;
            });
          } else {
            acc[key] = removeNulls(value);
          }
        }
        return acc;
      }, {});
    }
    return obj;
  }
  
  return removeNulls(payload);
}

/**
 * Validate that an order payload is safe for ShipStation
 * @param {object} payload - The order payload to validate
 * @returns {object} Validation result with any issues found
 */
function validateShipStationPayload(payload) {
  const issues = [];
  
  // Check for common issues that cause ShipStation API errors
  if (payload.internationalOptions?.customsItems) {
    payload.internationalOptions.customsItems.forEach((item, index) => {
      if (item.customsItemId === null) {
        issues.push(`Customs item ${index} has null customsItemId`);
      }
      if (item.value === null || item.value === undefined) {
        issues.push(`Customs item ${index} has null/undefined value`);
      }
      if (!item.description) {
        issues.push(`Customs item ${index} missing description`);
      }
    });
  }
  
  // Check items array
  if (payload.items) {
    payload.items.forEach((item, index) => {
      if (!item.sku && !item.name) {
        issues.push(`Item ${index} missing both SKU and name`);
      }
      if (item.quantity === null || item.quantity === undefined) {
        issues.push(`Item ${index} has null/undefined quantity`);
      }
    });
  }
  
  return {
    valid: issues.length === 0,
    issues: issues
  };
}

module.exports = {
  buildSafeShipStationItem,
  cleanShipStationPayload,
  validateShipStationPayload
};
