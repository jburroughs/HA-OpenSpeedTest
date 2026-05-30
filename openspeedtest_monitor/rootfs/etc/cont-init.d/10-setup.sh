#!/usr/bin/env bash
set -e

echo "[Setup] Initializing OpenSpeedTest Monitor..."

# Read options
SPEEDTEST_URL=$(bashio::config 'openspeedtest_url')
INTERVAL=$(bashio::config 'test_interval_minutes')
MAX_RESULTS=$(bashio::config 'max_results')

echo "[Setup] OpenSpeedTest Server: ${SPEEDTEST_URL}"
echo "[Setup] Test Interval: ${INTERVAL} minutes"
echo "[Setup] Max stored results: ${MAX_RESULTS}"

# Create data directory
mkdir -p /data/speedtest

# Initialize results file if it doesn't exist
if [ ! -f /data/speedtest/results.json ]; then
    echo "[]" > /data/speedtest/results.json
    echo "[Setup] Created new results database"
fi

# Write runtime config for other services
cat > /data/speedtest/config.json << EOF
{
  "openspeedtest_url": "${SPEEDTEST_URL}",
  "test_interval_minutes": ${INTERVAL},
  "max_results": ${MAX_RESULTS}
}
EOF

echo "[Setup] Configuration written"
echo "[Setup] Setup complete!"
