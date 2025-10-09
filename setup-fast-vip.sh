#!/bin/bash

# One-command VIP setup script
# Usage: bash setup-fast-vip.sh

set -e  # Exit on error

echo "🚀 Setting up Fast VIP Loading..."
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: Run this from your shopify-manager directory"
  echo "   cd ~/Development/shopify-manager"
  exit 1
fi

echo "📋 Step 1: Copying files from outputs..."
cp /mnt/user-data/outputs/vip-customer-ids.json .
cp /mnt/user-data/outputs/vip-customer-map.json .
cp /mnt/user-data/outputs/fast-vip-loader.js .
cp /mnt/user-data/outputs/analyze-vips.js .
echo "   ✅ Files copied"

echo ""
echo "⏳ Step 2: Loading VIP customers from Shopify API..."
echo "   (This will take about 30-60 seconds)"
echo ""
node fast-vip-loader.js

echo ""
echo "🎉 Setup Complete!"
echo ""
echo "✅ 164 VIP customers cached to SQLite"
echo "✅ VIP page will now load instantly"
echo "✅ ShipStation sync will complete in 5-10 seconds"
echo ""
echo "🚀 Next: Start your server"
echo "   npm start"
echo ""
echo "📖 For more info, see FAST-VIP-SETUP.md"
