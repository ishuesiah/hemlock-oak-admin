// test-order-item-adder.js - Test script for the order item adder functionality
// Run this with: node test-order-item-adder.js

const dotenv = require('dotenv');
dotenv.config();

// You can test with the enhanced API directly
const { ShipStationAPIEnhanced } = require('./shipstation-api-enhanced');
const customsManager = require('./utils/customs-manager');

/**
 * Test adding an item to a single order
 */
async function testSingleOrder() {
  console.log('\n=== Testing Single Order Item Addition ===\n');
  
  try {
    // Initialize the customs manager with your CUSMA database
    await customsManager.loadCUSMADatabase('./data/CUSMA.csv');
    console.log('✅ CUSMA database loaded successfully');
    
    // Initialize ShipStation API
    const shipstation = new ShipStationAPIEnhanced();
    
    // Test order number - CHANGE THIS to a real order number from your ShipStation
    const testOrderNumber = 'HO-TEST-001';  // ⚠️ CHANGE THIS TO A REAL ORDER NUMBER
    
    console.log(`\nAttempting to add item to order: ${testOrderNumber}`);
    
    // Add the default sticker item
    const result = await shipstation.addItemToOrder(testOrderNumber);
    
    if (result.success) {
      console.log('✅ Successfully added item to order!');
      console.log(`   - Items in order: ${result.itemsCount}`);
      console.log(`   - Customs declarations: ${result.customsCount}`);
      console.log(`   - Message: ${result.message}`);
    } else {
      console.log('⚠️ Item addition completed with message:', result.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response?.data) {
      console.error('   ShipStation API Error:', error.response.data);
    }
  }
}

/**
 * Test batch processing multiple orders
 */
async function testBatchOrders() {
  console.log('\n=== Testing Batch Order Processing ===\n');
  
  try {
    // Initialize the customs manager
    await customsManager.loadCUSMADatabase('./data/CUSMA.csv');
    console.log('✅ CUSMA database loaded successfully');
    
    // Initialize ShipStation API
    const shipstation = new ShipStationAPIEnhanced();
    
    // Test order numbers - CHANGE THESE to real order numbers
    const testOrderNumbers = [
      'HO-TEST-001',  // ⚠️ CHANGE THESE TO REAL ORDER NUMBERS
      'HO-TEST-002',
      'HO-TEST-003'
    ];
    
    console.log(`\nProcessing ${testOrderNumbers.length} orders...`);
    
    // Process batch
    const results = await shipstation.batchAddItemToOrders(testOrderNumbers);
    
    console.log('\n📊 Batch Results:');
    console.log(`   Total orders: ${results.total}`);
    console.log(`   ✅ Successful: ${results.successful}`);
    console.log(`   ⚠️ Skipped: ${results.skipped}`);
    console.log(`   ❌ Failed: ${results.failed}`);
    
    // Show details for each order
    console.log('\n📋 Order Details:');
    results.details.forEach(detail => {
      const icon = detail.status === 'error' ? '❌' : 
                   detail.message?.includes('already exists') ? '⚠️' : '✅';
      console.log(`   ${icon} ${detail.orderNumber}: ${detail.message || detail.error}`);
    });
    
  } catch (error) {
    console.error('❌ Batch test failed:', error.message);
  }
}

/**
 * Test customs info lookup
 */
async function testCustomsLookup() {
  console.log('\n=== Testing CUSMA Database Lookup ===\n');
  
  try {
    // Load the database
    await customsManager.loadCUSMADatabase('./data/CUSMA.csv');
    console.log(`✅ Loaded ${customsManager.customsData.size} customs entries\n`);
    
    // Test some SKU lookups
    const testSkus = [
      'LIST-DEF',           // The sticker item
      '2025Q4-DAI-AUT',    // Should be in your CUSMA file
      'UNKNOWN-SKU-123',   // Won't be found, will use defaults
      '25-DLP-AUT-IM'      // Should be in your CUSMA file
    ];
    
    console.log('Testing SKU lookups:');
    testSkus.forEach(sku => {
      const customsInfo = customsManager.getCustomsInfo(sku);
      console.log(`\n   SKU: ${sku}`);
      console.log(`   Description: ${customsInfo.description}`);
      console.log(`   HS Code: ${customsInfo.tariffNumber}`);
      console.log(`   Country: ${customsInfo.countryOfOrigin}`);
    });
    
  } catch (error) {
    console.error('❌ Customs lookup test failed:', error.message);
  }
}

/**
 * Test updating only customs declarations (without adding item)
 */
async function testCustomsOnlyUpdate() {
  console.log('\n=== Testing Customs-Only Update ===\n');
  
  try {
    // Initialize
    await customsManager.loadCUSMADatabase('./data/CUSMA.csv');
    const shipstation = new ShipStationAPIEnhanced();
    
    // Test order number - CHANGE THIS
    const testOrderNumber = 'HO-TEST-001';  // ⚠️ CHANGE THIS TO A REAL ORDER NUMBER
    
    console.log(`Updating customs declarations for order: ${testOrderNumber}`);
    
    const result = await shipstation.updateOrderCustomsDeclarations(testOrderNumber);
    
    if (result.success) {
      console.log('✅ Successfully updated customs declarations!');
      console.log(`   - Customs items created: ${result.customsCount}`);
      console.log(`   - Message: ${result.message}`);
    }
    
  } catch (error) {
    console.error('❌ Customs update failed:', error.message);
  }
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log('🧪 ShipStation Order Item Adder - Test Suite');
  console.log('============================================\n');
  
  // Check for required environment variables
  if (!process.env.SHIPSTATION_API_KEY || !process.env.SHIPSTATION_API_SECRET) {
    console.error('❌ Missing ShipStation credentials in .env file!');
    console.error('   Please set SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET');
    process.exit(1);
  }
  
  console.log('✅ ShipStation credentials found in .env\n');
  
  // Run tests based on command line argument
  const testToRun = process.argv[2];
  
  switch(testToRun) {
    case 'single':
      await testSingleOrder();
      break;
    case 'batch':
      await testBatchOrders();
      break;
    case 'customs':
      await testCustomsLookup();
      break;
    case 'update':
      await testCustomsOnlyUpdate();
      break;
    case 'all':
      await testCustomsLookup();
      await testSingleOrder();
      await testCustomsOnlyUpdate();
      await testBatchOrders();
      break;
    default:
      console.log('Usage: node test-order-item-adder.js [test]');
      console.log('\nAvailable tests:');
      console.log('  single  - Test adding item to single order');
      console.log('  batch   - Test batch processing multiple orders');
      console.log('  customs - Test CUSMA database lookups');
      console.log('  update  - Test updating only customs declarations');
      console.log('  all     - Run all tests\n');
      console.log('Example: node test-order-item-adder.js single');
      break;
  }
  
  console.log('\n============================================');
  console.log('🏁 Test suite completed\n');
}

// Run the tests
runAllTests().catch(error => {
  console.error('\n💥 Unexpected error:', error);
  process.exit(1);
});

/**
 * IMPORTANT NOTES:
 * 
 * 1. Before running tests, make sure to:
 *    - Set up your .env file with ShipStation API credentials
 *    - Copy your CUSMA.csv file to ./data/CUSMA.csv
 *    - Replace test order numbers with real ones from your ShipStation
 * 
 * 2. Start with the 'customs' test to verify database loading:
 *    node test-order-item-adder.js customs
 * 
 * 3. Then test with a single order:
 *    node test-order-item-adder.js single
 * 
 * 4. If successful, test batch processing:
 *    node test-order-item-adder.js batch
 * 
 * 5. To run all tests:
 *    node test-order-item-adder.js all
 */
