#!/bin/bash

# Distro Scout Server Startup Script
# This script ensures the server starts reliably

echo "🚀 Starting Distro Scout Server..."

# Kill any existing server processes
echo "🔄 Checking for existing server processes..."
pkill -f "node.*index.js" 2>/dev/null || true

# Wait a moment for processes to terminate
sleep 1

# Start the server
echo "▶️  Starting server on port 3001..."
cd "$(dirname "$0")"
node server/index.js

echo "✅ Server startup complete"

