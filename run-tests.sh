#!/bin/bash

# LSS Test Runner
# Runs integration tests with proper setup and teardown

set -e

echo "🧪 LSS Integration Test Runner"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Docker is running
echo "📦 Checking Docker..."
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker first.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker is running${NC}"

# Stop any running orchestrator
echo ""
echo "🛑 Stopping any running LSS orchestrator..."
npx lss stop 2>/dev/null || true
sleep 2

# Clean up test files
echo "🧹 Cleaning up test files..."
rm -f /tmp/lss-test-*.json 2>/dev/null || true

# Build project
echo ""
echo "🔨 Building project..."
npm run build

# Run tests based on argument
echo ""
echo "🧪 Running tests..."
echo ""

case "$1" in
  "cli")
    echo "Running CLI tests..."
    npm run test:cli
    ;;
  "orchestrator")
    echo "Running Orchestrator API tests..."
    npm run test:orchestrator
    ;;
  "plugin")
    echo "Running Plugin tests..."
    npm run test:plugin
    ;;
  "coverage")
    echo "Running all tests with coverage..."
    npm run test:coverage
    ;;
  "watch")
    echo "Running tests in watch mode..."
    npm run test:watch
    ;;
  *)
    echo "Running all integration tests..."
    npm run test:integration
    ;;
esac

# Cleanup
echo ""
echo "🧹 Cleaning up..."
npx lss stop 2>/dev/null || true
rm -f /tmp/lss-test-*.json 2>/dev/null || true

echo ""
echo -e "${GREEN}✅ Tests completed!${NC}"
