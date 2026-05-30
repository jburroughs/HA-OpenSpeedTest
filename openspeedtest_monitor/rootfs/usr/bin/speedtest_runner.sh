#!/usr/bin/env bash
# OpenSpeedTest runner — polls the self-hosted OpenSpeedTest server
# using a headless WebSocket-based approach, then saves results.

DATA_DIR="/data/speedtest"
CONFIG_FILE="${DATA_DIR}/config.json"
RESULTS_FILE="${DATA_DIR}/results.json"

log() { echo "[SpeedTest] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

run_test() {
    log "Starting speed test..."

    SPEEDTEST_URL=$(jq -r '.openspeedtest_url' "${CONFIG_FILE}")
    MAX_RESULTS=$(jq -r '.max_results' "${CONFIG_FILE}")

    # Run test via Node.js worker
    RESULT=$(node /usr/bin/speedtest_worker.js "${SPEEDTEST_URL}" 2>&1)
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
        log "ERROR: Speed test failed: ${RESULT}"
        # Store failure record
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        FAIL_ENTRY="{\"timestamp\":\"${TIMESTAMP}\",\"status\":\"error\",\"error\":\"${RESULT}\",\"download\":null,\"upload\":null,\"ping\":null}"
        UPDATED=$(jq --argjson entry "${FAIL_ENTRY}" --argjson max "${MAX_RESULTS}" \
            '. + [$entry] | if length > $max then .[-($max):] else . end' "${RESULTS_FILE}")
        echo "${UPDATED}" > "${RESULTS_FILE}"
        return 1
    fi

    log "Test complete: ${RESULT}"

    # Parse result and append to JSON
    UPDATED=$(echo "${RESULT}" | jq --argjson max "${MAX_RESULTS}" \
        'if type == "object" then . else error end' 2>/dev/null)

    if [ $? -ne 0 ]; then
        log "ERROR: Invalid JSON from worker: ${RESULT}"
        return 1
    fi

    CURRENT=$(cat "${RESULTS_FILE}")
    NEW_LIST=$(echo "${CURRENT}" | jq --argjson entry "${UPDATED}" --argjson max "${MAX_RESULTS}" \
        '. + [$entry] | if length > $max then .[-($max):] else . end')
    echo "${NEW_LIST}" > "${RESULTS_FILE}"

    DOWNLOAD=$(echo "${UPDATED}" | jq -r '.download // "N/A"')
    UPLOAD=$(echo "${UPDATED}" | jq -r '.upload // "N/A"')
    PING=$(echo "${UPDATED}" | jq -r '.ping // "N/A"')
    log "↓ Download: ${DOWNLOAD} Mbps  ↑ Upload: ${UPLOAD} Mbps  ◉ Ping: ${PING} ms"
}

# Main loop
while true; do
    run_test

    INTERVAL=$(jq -r '.test_interval_minutes' "${CONFIG_FILE}")
    log "Next test in ${INTERVAL} minutes..."
    sleep $(( INTERVAL * 60 ))
done
