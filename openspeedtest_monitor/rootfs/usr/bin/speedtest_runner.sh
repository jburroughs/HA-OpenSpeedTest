#!/usr/bin/env bash
# OpenSpeedTest runner — runs tests on schedule, saves results, and pushes
# sensor states to Home Assistant via the Supervisor REST API.

DATA_DIR="/data/speedtest"
CONFIG_FILE="${DATA_DIR}/config.json"
RESULTS_FILE="${DATA_DIR}/results.json"

# HA Supervisor injects SUPERVISOR_TOKEN into the container environment.
# s6 services may run in a clean env, so also try reading from /proc/1/environ.
if [ -z "${SUPERVISOR_TOKEN}" ] && [ -f /proc/1/environ ]; then
    while IFS= read -r -d '' var; do
        case "$var" in
            SUPERVISOR_TOKEN=*) export "$var" ;;
        esac
    done < /proc/1/environ
fi

HA_URL="http://supervisor/core"
TOKEN="${SUPERVISOR_TOKEN}"

log() { echo "[SpeedTest] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ---------------------------------------------------------------
# Push a sensor state to Home Assistant via the REST API
# Usage: ha_set_sensor <entity_id> <state> <unit> <device_class> <friendly_name> <icon>
# ---------------------------------------------------------------
ha_set_sensor() {
    local entity_id="$1"
    local state="$2"
    local unit="$3"
    local device_class="$4"
    local friendly_name="$5"
    local icon="$6"

    local payload
    payload=$(jq -n \
        --arg state "${state}" \
        --arg unit "${unit}" \
        --arg dc "${device_class}" \
        --arg fn "${friendly_name}" \
        --arg icon "${icon}" \
        '{
            state: $state,
            attributes: {
                unit_of_measurement: $unit,
                device_class: $dc,
                friendly_name: $fn,
                icon: $icon,
                state_class: "measurement"
            }
        }')

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${payload}" \
        "${HA_URL}/api/states/${entity_id}")

    if [ "${http_code}" = "200" ] || [ "${http_code}" = "201" ]; then
        log "  ✓ ${entity_id} = ${state}${unit}"
    else
        log "  ✗ Failed to set ${entity_id} (HTTP ${http_code})"
    fi
}

# ---------------------------------------------------------------
# Push all sensors to HA after a successful test
# ---------------------------------------------------------------
push_to_ha() {
    local download="$1"
    local upload="$2"
    local ping="$3"
    local status="$4"

    log "Pushing entities to Home Assistant..."

    if [ "${status}" = "success" ]; then
        ha_set_sensor \
            "sensor.speedtest_download" \
            "${download}" \
            "Mbit/s" \
            "data_rate" \
            "SpeedTest Download" \
            "mdi:download-network"

        ha_set_sensor \
            "sensor.speedtest_upload" \
            "${upload}" \
            "Mbit/s" \
            "data_rate" \
            "SpeedTest Upload" \
            "mdi:upload-network"

        ha_set_sensor \
            "sensor.speedtest_ping" \
            "${ping}" \
            "ms" \
            "duration" \
            "SpeedTest Ping" \
            "mdi:timer-outline"

        ha_set_sensor \
            "sensor.speedtest_status" \
            "OK" \
            "" \
            "" \
            "SpeedTest Status" \
            "mdi:check-circle"
    else
        ha_set_sensor \
            "sensor.speedtest_status" \
            "Error" \
            "" \
            "" \
            "SpeedTest Status" \
            "mdi:alert-circle"
    fi

    # Always update last-run timestamp
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    ha_set_sensor \
        "sensor.speedtest_last_run" \
        "${now}" \
        "" \
        "timestamp" \
        "SpeedTest Last Run" \
        "mdi:clock-outline"
}

# ---------------------------------------------------------------
# Run one speed test cycle
# ---------------------------------------------------------------
run_test() {
    log "Starting speed test..."

    local speedtest_url
    speedtest_url=$(jq -r '.openspeedtest_url' "${CONFIG_FILE}")
    local max_results
    max_results=$(jq -r '.max_results' "${CONFIG_FILE}")

    local result exit_code
    result=$(node /usr/bin/speedtest_worker.js "${speedtest_url}" 2>/dev/null)
    exit_code=$?

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [ $exit_code -ne 0 ] || [ -z "${result}" ]; then
        log "ERROR: Speed test failed"
        local fail_entry
        fail_entry=$(jq -n --arg ts "${timestamp}" \
            '{timestamp:$ts, status:"error", download:null, upload:null, ping:null}')
        local updated
        updated=$(jq --argjson e "${fail_entry}" --argjson max "${max_results}" \
            '. + [$e] | if length > $max then .[-($max):] else . end' "${RESULTS_FILE}")
        echo "${updated}" > "${RESULTS_FILE}"
        push_to_ha "" "" "" "error"
        return 1
    fi

    # Validate JSON
    if ! echo "${result}" | jq -e . >/dev/null 2>&1; then
        log "ERROR: Invalid JSON from worker"
        return 1
    fi

    local download upload ping
    download=$(echo "${result}" | jq -r '.download // "0"')
    upload=$(echo "${result}" | jq -r '.upload // "0"')
    ping=$(echo "${result}" | jq -r '.ping // "0"')

    log "↓ Download: ${download} Mbps  ↑ Upload: ${upload} Mbps  ◉ Ping: ${ping} ms"

    # Save to results file
    local updated
    updated=$(jq --argjson e "${result}" --argjson max "${max_results}" \
        '. + [$e] | if length > $max then .[-($max):] else . end' "${RESULTS_FILE}")
    echo "${updated}" > "${RESULTS_FILE}"

    # Push to Home Assistant
    push_to_ha "${download}" "${upload}" "${ping}" "success"
}

# ---------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------
log "SpeedTest daemon starting..."
log "HA URL: ${HA_URL}"

if [ -z "${TOKEN}" ]; then
    log "WARNING: SUPERVISOR_TOKEN is empty — HA entity updates will fail."
    log "  Check: homeassistant_api must be 'true' in config.yaml"
    log "  /proc/1/environ keys: $(tr '\0' '\n' < /proc/1/environ 2>/dev/null | cut -d= -f1 | tr '\n' ' ')"
else
    log "SUPERVISOR_TOKEN present (${#TOKEN} chars) — HA entity updates enabled"
fi

while true; do
    run_test

    interval=$(jq -r '.test_interval_minutes' "${CONFIG_FILE}")
    log "Next test in ${interval} minutes..."
    sleep $(( interval * 60 ))
done
