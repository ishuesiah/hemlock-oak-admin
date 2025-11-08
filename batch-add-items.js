// batch-add-items.js - Process multiple orders at once
'use strict';

require('dotenv').config();
const { ShipStationAPI } = require('./shipstation-add-item'); // Use the working version!

async function batchAddItems() {
  // YOUR ORDER LIST
  const orderNumbers = [
    '50218',
    '50175',
    '51655',
    '49038',
    '51150',
    '50871',
    '49742',
    '52119',
    '49124',
    '50026',
    '51555',
    '51104'
  ];

  console.log('🎯 BATCH PROCESSING - Adding stickers to orders\n');
  console.log('='.repeat(60));
  console.log(`Processing ${orderNumbers.length} orders...\n`);
  
  // Initialize API
  const api = new ShipStationAPI();
  
  // Load CUSMA database
  const loaded = await api.loadCUSMA('./data/CUSMA.csv');
  console.log(loaded ? '✅ CUSMA database loaded\n' : '⚠️ Using defaults\n');
  
  // Track results
  const results = {
    successful: [],
    skipped: [],
    failed: []
  };
  
  // Process each order
  for (let i = 0; i < orderNumbers.length; i++) {
    const orderNumber = orderNumbers[i];
    console.log(`[${i + 1}/${orderNumbers.length}] Processing order ${orderNumber}...`);
    
    try {
      const result = await api.addItemToOrder(orderNumber);
      
      if (result.message.includes('already exists')) {
        console.log(`  ⏩ SKIPPED - Item already exists\n`);
        results.skipped.push(orderNumber);
      } else {
        console.log(`  ✅ SUCCESS - Added stickers (${result.itemsCount} items, ${result.customsCount} customs)\n`);
        results.successful.push(orderNumber);
      }
      
      // Rate limiting - wait 1 second between orders
      if (i < orderNumbers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.log(`  ❌ FAILED - ${error.message}\n`);
      results.failed.push({
        orderNumber,
        error: error.message
      });
      
      // Continue with next order even if one fails
      continue;
    }
  }
  
  // Print summary
  console.log('='.repeat(60));
  console.log('📊 BATCH PROCESSING COMPLETE\n');
  console.log(`✅ Successful: ${results.successful.length} orders`);
  if (results.successful.length > 0) {
    console.log(`   Orders: ${results.successful.join(', ')}`);
  }
  
  console.log(`\n⏩ Skipped: ${results.skipped.length} orders (already had item)`);
  if (results.skipped.length > 0) {
    console.log(`   Orders: ${results.skipped.join(', ')}`);
  }
  
  console.log(`\n❌ Failed: ${results.failed.length} orders`);
  if (results.failed.length > 0) {
    results.failed.forEach(f => {
      console.log(`   ${f.orderNumber}: ${f.error}`);
    });
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✨ All done!');
}

// Run it!
batchAddItems().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});