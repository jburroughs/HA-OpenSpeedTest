#!/usr/bin/env bash
set -e

echo "[Setup] Initializing OpenSpeedTest Monitor..."

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

mkdir -p /data/speedtest

if [ ! -f /data/speedtest/results.json ]; then
    echo "[]" > /data/speedtest/results.json
    echo "[Setup] Created new results database"
fi

cat > /data/speedtest/config.json << EOF
{
  "openspeedtest_url": "${SPEEDTEST_URL}",
  "test_interval_minutes": ${INTERVAL},
  "max_results": ${MAX_RESULTS}
}
EOF

echo "[Setup] Configuration written"

# Connectivity pre-check — useful when openspeedtest_url points to a
# Docker container running on a different host on the network.
# Capped at 3s so this can never meaningfully delay nginx startup.
echo "[Setup] Checking connectivity to ${SPEEDTEST_URL}..."
if curl -s -o /dev/null -m 3 -w "" "${SPEEDTEST_URL}"; then
    echo "[Setup] ✓ Server reachable"
else
    echo "[Setup] ⚠ WARNING: Could not reach ${SPEEDTEST_URL} within 3s"
    echo "[Setup]   If this server is on another machine, verify:"
    echo "[Setup]   - The host/IP and port are correct"
    echo "[Setup]   - The remote Docker container is running"
    echo "[Setup]   - No firewall is blocking the port between hosts"
fi

echo "[Setup] Setup complete!"
