// test-order-46993.js - Quick test for the specific order that was failing
const dotenv = require('dotenv');
dotenv.config();

// Use the FINAL versions
const { ShipStationAPIEnhanced } = require('./shipstation-api-enhanced-FINAL');
const customsManager = require('./utils/customs-manager-FINAL');

async function testOrder46993() {
  console.log('🔧 Testing fix for Order 46993\n');
  console.log('=' .repeat(60));
  
  try {
    // Load CUSMA database
    const loaded = await customsManager.loadCUSMADatabase('./data/CUSMA.csv');
    if (!loaded) {
      console.log('⚠️ CUSMA database not found, but continuing with defaults...');
    }
    
    // Initialize API
    const shipstation = new ShipStationAPIEnhanced();
    
    // Test with order 46993
    console.log('\n📦 Adding item to order 46993...\n');
    
    const result = await shipstation.addItemToOrder('46993');
    
    if (result.success) {
      console.log('✅ SUCCESS! Item added to order 46993');
      console.log(`   Items: ${result.itemsCount}`);
      console.log(`   Customs: ${result.customsCount}`);
      console.log(`   Message: ${result.message}`);
    } else {
      console.log('⚠️ Result:', result.message);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response?.data) {
      console.error('\n📋 API Response:', JSON.stringify(error.response.data, null, 2));
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Test complete!');
}

// Run the test
testOrder46993();