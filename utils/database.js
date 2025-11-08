// utils/database.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDB() {
  db = await open({
    filename: path.join(__dirname, '../vip_cache.db'),
    driver: sqlite3.Database
  });

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      total_spent REAL,
      orders_count INTEGER,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS customer_orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER,
      order_data TEXT,
      unfulfilled INTEGER DEFAULT 0,
      total_price REAL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shipstation_orders (
      order_id INTEGER PRIMARY KEY,
      order_number TEXT,
      order_date TEXT,
      order_status TEXT,
      customer_name TEXT,
      customer_email TEXT,
      order_data TEXT,
      cached_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shipstation_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      sku TEXT,
      name TEXT,
      quantity INTEGER,
      options TEXT,
      FOREIGN KEY(order_id) REFERENCES shipstation_orders(order_id)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_spent ON customers(total_spent);
    CREATE INDEX IF NOT EXISTS idx_customer_orders ON customer_orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_order_status ON shipstation_orders(order_status);
    CREATE INDEX IF NOT EXISTS idx_order_date ON shipstation_orders(order_date);
    CREATE INDEX IF NOT EXISTS idx_item_sku ON shipstation_order_items(sku);
    CREATE INDEX IF NOT EXISTS idx_item_name ON shipstation_order_items(name);
    CREATE INDEX IF NOT EXISTS idx_item_order ON shipstation_order_items(order_id);
  `);
  
  console.log('✅ Database initialized at', path.join(__dirname, '../vip_cache.db'));
  return db;
}

async function getDB() {
  if (!db) {
    await initDB();
  }
  return db;
}

module.exports = { initDB, getDB };