#!/usr/bin/env bash
set -e

echo "[Setup] Initializing OpenSpeedTest Monitor..."

# HA writes addon options to /data/options.json — read with jq (no bashio needed)
OPTIONS="/data/options.json"

if [ ! -f "${OPTIONS}" ]; then
    echo "[Setup] WARNING: /data/options.json not found, using defaults"
    echo '{"openspeedtest_url":"http://192.168.1.100:3000","test_interval_minutes":30,"max_results":500}' > "${OPTIONS}"
fi

SPEEDTEST_URL=$(jq -r '.openspeedtest_url // "http://192.168.1.100:3000"' "${OPTIONS}")
INTERVAL=$(jq -r '.test_interval_minutes // 30' "${OPTIONS}")
MAX_RESULTS=$(jq -r '.max_results // 500' "${OPTIONS}")

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
