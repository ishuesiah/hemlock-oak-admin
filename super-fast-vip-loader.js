// super-fast-vip-loader.js - TRULY FAST VIP Loading with Unfulfilled Orders
const axios = require('axios');
const { saveVIPCustomers } = require('./utils/vip-cache');
const { initDB } = require('./utils/database');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class ShopifyGraphQL {
  constructor() {
    this.store = process.env.SHOPIFY_STORE;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = '2024-01';
    
    this.client = axios.create({
      baseURL: `https://${this.store}/admin/api/${this.apiVersion}/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    });
    
    this.lastRequestTime = 0;
    this.minRequestInterval = 100;
  }
  
  async rateLimit() {
    const now = Date.now();
    const gap = now - this.lastRequestTime;
    if (gap < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - gap));
    }
    this.lastRequestTime = Date.now();
  }
  
  /**
   * Fetch multiple customers by IDs using GraphQL
   */
  async getCustomersByIds(customerIds) {
    await this.rateLimit();
    
    const gids = customerIds.map(id => `gid://shopify/Customer/${id}`);
    
    const query = `
      query getCustomers($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Customer {
            id
            legacyResourceId
            email
            firstName
            lastName
            createdAt
            tags
            note
            verifiedEmail
            state
            amountSpent {
              amount
            }
            numberOfOrders
          }
        }
      }
    `;
    
    try {
      const response = await this.client.post('', {
        query,
        variables: { ids: gids }
      });
      
      if (response.data.errors) {
        throw new Error(JSON.stringify(response.data.errors));
      }
      
      return response.data.data.nodes.filter(node => node !== null);
    } catch (error) {
      console.error('GraphQL error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetch unfulfilled orders for a customer
   */
  async getUnfulfilledOrders(customerId) {
    await this.rateLimit();
    
    const query = `
      query getUnfulfilledOrders($customerId: ID!, $query: String!) {
        orders(first: 50, query: $query) {
          edges {
            node {
              id
              legacyResourceId
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                }
              }
              displayFinancialStatus
              displayFulfillmentStatus
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                  }
                }
              }
              shippingAddress {
                city
                provinceCode
                countryCode
              }
            }
          }
        }
      }
    `;
    
    try {
      // Query for unfulfilled orders for this customer
      const searchQuery = `customer_id:${customerId} AND fulfillment_status:unfulfilled`;
      
      const response = await this.client.post('', {
        query,
        variables: { 
          customerId: `gid://shopify/Customer/${customerId}`,
          query: searchQuery
        }
      });
      
      if (response.data.errors) {
        console.error('Order fetch error:', response.data.errors);
        return [];
      }
      
      const edges = response.data.data?.orders?.edges || [];
      return edges.map(edge => {
        const order = edge.node;
        return {
          id: order.legacyResourceId,
          name: order.name,
          created_at: order.createdAt,
          total_price: order.totalPriceSet.shopMoney.amount,
          financial_status: order.displayFinancialStatus?.toLowerCase() || 'unknown',
          fulfillment_status: 'unfulfilled',
          line_items: order.lineItems.edges.map(li => ({
            id: li.node.id,
            name: li.node.name,
            quantity: li.node.quantity
          })),
          shipping_address: order.shippingAddress ? {
            city: order.shippingAddress.city,
            province: order.shippingAddress.provinceCode,
            country: order.shippingAddress.countryCode
          } : null
        };
      });
    } catch (error) {
      console.error('Error fetching unfulfilled orders:', error.message);
      return [];
    }
  }
}

async function superFastVIPLoad() {
  console.log('⚡ SUPER FAST VIP Loader - Using GraphQL API\n');
  
  await initDB();
  
  const vipIdsPath = path.join(__dirname, 'vip-customer-ids.json');
  const vipMapPath = path.join(__dirname, 'vip-customer-map.json');
  
  if (!fs.existsSync(vipIdsPath)) {
    console.error('❌ vip-customer-ids.json not found!');
    console.error('   Run: node analyze-vips.js first');
    process.exit(1);
  }
  
  const vipIds = JSON.parse(fs.readFileSync(vipIdsPath, 'utf8'));
  const vipMap = JSON.parse(fs.readFileSync(vipMapPath, 'utf8'));
  
  console.log(`📋 Loaded ${vipIds.length} VIP customer IDs from export`);
  console.log('⚡ Fetching customer details and unfulfilled orders using GraphQL...\n');
  
  const graphql = new ShopifyGraphQL();
  const startTime = Date.now();
  
  const customers = [];
  const batchSize = 50;
  const totalBatches = Math.ceil(vipIds.length / batchSize);
  
  for (let i = 0; i < vipIds.length; i += batchSize) {
    const batch = vipIds.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    
    console.log(`   Batch ${batchNum}/${totalBatches}: Fetching ${batch.length} customers...`);
    
    const batchCustomers = await graphql.getCustomersByIds(batch);
    
    // Fetch unfulfilled orders for each customer
    for (const customer of batchCustomers) {
      const customerId = customer.legacyResourceId;
      const vipData = vipMap[customerId];
      
      console.log(`      Fetching unfulfilled orders for customer ${customerId}...`);
      const unfulfilledOrders = await graphql.getUnfulfilledOrders(customerId);
      
      const unfulfilledValue = unfulfilledOrders.reduce((sum, order) => 
        sum + parseFloat(order.total_price || 0), 0
      );
      
      const transformed = {
        id: customerId,
        email: customer.email,
        first_name: customer.firstName,
        last_name: customer.lastName,
        created_at: customer.createdAt,
        tags: customer.tags.join(','),
        note: customer.note || '',
        verified_email: customer.verifiedEmail,
        state: customer.state.toLowerCase(),
        total_spent: vipData ? vipData.total_spent : parseFloat(customer.amountSpent.amount),
        orders_count: vipData ? vipData.orders_count : customer.numberOfOrders,
        unfulfilled_orders: unfulfilledOrders,
        unfulfilled_count: unfulfilledOrders.length,
        unfulfilled_value: unfulfilledValue
      };
      
      customers.push(transformed);
    }
    
    console.log(`      ✅ Fetched ${batchCustomers.length} customers with order data`);
  }
  
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ Fetched ${customers.length} VIP customers in ${elapsed} seconds`);
  console.log(`   That's ${Math.round(customers.length / elapsed)} customers per second! ⚡`);
  
  // Save to cache
  console.log('💾 Saving to SQLite cache...');
  await saveVIPCustomers(customers);
  
  console.log('\n🎉 Done! VIP cache is ready.');
  console.log(`   - ${customers.length} VIP customers cached`);
  console.log(`   - Total time: ${elapsed} seconds`);
  console.log(`   - Future loads will be instant from cache\n`);
  
  // Stats
  const totalSpent = customers.reduce((sum, c) => sum + parseFloat(c.total_spent || 0), 0);
  const avgSpent = totalSpent / customers.length;
  const totalUnfulfilled = customers.reduce((sum, c) => sum + c.unfulfilled_count, 0);
  const totalUnfulfilledValue = customers.reduce((sum, c) => sum + c.unfulfilled_value, 0);
  
  console.log('📊 Summary:');
  console.log(`   Total VIP spend: $${totalSpent.toFixed(2)}`);
  console.log(`   Average spend: $${avgSpent.toFixed(2)}`);
  console.log(`   Unfulfilled orders: ${totalUnfulfilled}`);
  console.log(`   Unfulfilled value: $${totalUnfulfilledValue.toFixed(2)}`);
  console.log(`   Ready for ShipStation sync!\n`);
}

// Run it
superFastVIPLoad().catch(error => {
  console.error('\n❌ Error:', error.message);
  console.error('Full error:', error);
  process.exit(1);
});