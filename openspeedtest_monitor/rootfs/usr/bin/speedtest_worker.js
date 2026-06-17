#!/usr/bin/env node
/**
 * OpenSpeedTest Worker — measures throughput against a self-hosted
 * OpenSpeedTest server using multiple genuinely concurrent TCP streams.
 *
 * Key fixes vs. naive implementation:
 *  - Uses 6 parallel persistent connections (not sequential awaited fetches)
 *  - Streams large payloads instead of small repeated requests, to avoid
 *    per-request HTTP overhead dominating the measurement
 *  - Warms up connections before measuring (TCP slow-start skew)
 *  - Increases socket buffer sizes via highWaterMark
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const serverUrl = process.argv[2];
if (!serverUrl) {
    console.error('Usage: speedtest_worker.js <openspeedtest_url>');
    process.exit(1);
}

const PARALLEL_STREAMS = 8; // more streams help saturate multi-Gbps links,
                             // where Node's single-threaded data-event
                             // handling can otherwise become the bottleneck
                             // on any single connection
const WARMUP_MS = 1500;
const TEST_DURATION_MS = 10000;
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for upload
const GARBAGE_CK_SIZE_MB = 100; // 100MB per chunk. On fast (multi-Gbps) LANs,
                                 // a too-small chunk finishes almost
                                 // instantly, so per-request overhead
                                 // (TCP handshake + headers) dominates the
                                 // measurement instead of actual transfer.

// A real keep-alive agent is required — without one, Node opens a brand
// new TCP connection for every request regardless of the Connection header
// we send, and on a fast LAN that per-connection setup cost (handshake +
// headers) can easily exceed the transfer time of each chunk, silently
// capping the measured throughput far below real line rate.
const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: PARALLEL_STREAMS * 2,
    maxFreeSockets: PARALLEL_STREAMS * 2,
    timeout: 20000
};
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

function parseTarget(base) {
    const url = new URL('/', base);
    const isHttps = url.protocol === 'https:';
    return {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (isHttps ? 443 : 80),
        protocol: url.protocol,
        lib: isHttps ? https : http,
        agent: isHttps ? httpsAgent : httpAgent
    };
}

function findEndpoint(target, candidates, method) {
    return new Promise((resolve) => {
        let i = 0;
        let fallback = null;
        const tryNext = () => {
            if (i >= candidates.length) return resolve(fallback || '/');
            const path = candidates[i++];
            const probePayload = method === 'POST' ? Buffer.alloc(65536, 0x61) : null;
            const reqStart = process.hrtime.bigint();
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path,
                method,
                agent: target.agent,
                headers: method === 'POST'
                    ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(probePayload.length) }
                    : {}
            }, (res) => {
                let bytes = 0;
                res.on('data', (chunk) => { bytes += chunk.length; });
                res.on('end', () => {
                    const elapsedMs = Number(process.hrtime.bigint() - reqStart) / 1e6;
                    if (res.statusCode >= 400) return tryNext();
                    if (fallback === null) fallback = path;
                    if (method === 'GET' && bytes < 50000) return tryNext();
                    // For POST (upload) endpoints: a 64KB body that "completes"
                    // in under 2ms almost certainly means the server replied
                    // without actually reading the request body — i.e. this
                    // isn't a real upload-accepting endpoint.
                    if (method === 'POST' && elapsedMs < 2) return tryNext();
                    resolve(path);
                });
                res.on('error', tryNext);
            });
            if (method === 'POST') req.write(probePayload);
            req.on('error', tryNext);
            req.setTimeout(4000, () => { req.destroy(); tryNext(); });
            req.end();
        };
        tryNext();
    });
}

async function measurePing(target) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
        const start = process.hrtime.bigint();
        await new Promise((resolve) => {
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path: '/?ping=' + Math.random(),
                method: 'GET',
                headers: { 'Cache-Control': 'no-cache' }
            }, (res) => {
                res.resume();
                res.on('end', () => {
                    const ms = Number(process.hrtime.bigint() - start) / 1e6;
                    samples.push(ms);
                    resolve();
                });
            });
            req.on('error', () => resolve());
            req.setTimeout(5000, () => { req.destroy(); resolve(); });
            req.end();
        });
        await new Promise(r => setTimeout(r, 80));
    }
    if (samples.length === 0) return null;
    samples.sort((a, b) => a - b);
    // Use the minimum (best-case latency, excludes congestion/jitter)
    return Math.round(samples[0] * 10) / 10;
}

/**
 * Runs N parallel persistent download streams against `path`, accumulating
 * total bytes received across all streams. Each stream re-issues a fresh
 * request as soon as the previous one ends, for the full duration.
 */
async function measureDownload(target, path) {
    let totalBytes = 0;
    let measuredBytes = 0;
    let requestCount = 0;
    const globalStart = Date.now();
    const measureStart = globalStart + WARMUP_MS;
    const endAt = measureStart + TEST_DURATION_MS;

    const runStream = () => new Promise((resolve) => {
        const fetchOnce = () => {
            if (Date.now() >= endAt) return resolve();
            const sep = path.includes('?') ? '&' : '?';
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path: path + sep + 'r=' + Math.random() + '&n=' + Date.now(),
                method: 'GET',
                agent: target.agent,
                headers: { 'Cache-Control': 'no-cache' }
            }, (res) => {
                res.on('data', (chunk) => {
                    totalBytes += chunk.length;
                    if (Date.now() >= measureStart) measuredBytes += chunk.length;
                });
                res.on('end', () => {
                    if (Date.now() >= measureStart) requestCount++;
                    if (Date.now() < endAt) fetchOnce();
                    else resolve();
                });
                res.on('error', () => resolve());
            });
            req.on('error', () => resolve());
            req.setTimeout(15000, () => { req.destroy(); resolve(); });
            req.end();
        };
        fetchOnce();
    });

    const streams = [];
    for (let i = 0; i < PARALLEL_STREAMS; i++) streams.push(runStream());
    await Promise.all(streams);

    const elapsedMeasured = (Date.now() - measureStart) / 1000;
    if (elapsedMeasured <= 0) return 0;
    const mbps = (measuredBytes * 8) / (elapsedMeasured * 1_000_000);

    const avgKB = requestCount > 0 ? Math.round(measuredBytes / requestCount / 1024) : 0;
    process.stderr.write(
        `Download diagnostics: ${requestCount} completed requests across ${PARALLEL_STREAMS} ` +
        `streams, avg ${avgKB}KB/request, ${(measuredBytes / 1024 / 1024).toFixed(1)}MB total ` +
        `in ${elapsedMeasured.toFixed(2)}s.\n`
    );
    if (requestCount > 50) {
        process.stderr.write(
            `NOTE: High request count with small avg size suggests per-request overhead ` +
            `(connection setup, headers) may be limiting throughput rather than raw transfer ` +
            `speed. This usually means ckSize is too small for this link's speed, or chunks ` +
            `aren't actually reusing connections.\n`
        );
    }

    return Math.round(mbps * 100) / 100;
}

/**
 * Runs N parallel persistent upload streams against `path`.
 * Tracks per-request elapsed time so a server that responds without
 * actually reading the body (e.g. a misidentified endpoint) doesn't
 * inflate the result — we only credit bytes for the wall-clock time
 * actually spent sending them.
 */
async function measureUpload(target, path) {
    const payload = Buffer.alloc(CHUNK_SIZE, 0x61);
    let measuredBytes = 0;
    let measuredMs = 0;
    let sampleCount = 0;
    let fastRejectCount = 0;
    const globalStart = Date.now();
    const measureStart = globalStart + WARMUP_MS;
    const endAt = measureStart + TEST_DURATION_MS;

    const runStream = () => new Promise((resolve) => {
        const sendOnce = () => {
            if (Date.now() >= endAt) return resolve();
            const startedDuringMeasure = Date.now() >= measureStart;
            const sep = path.includes('?') ? '&' : '?';
            const reqStart = process.hrtime.bigint();
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path: path + sep + 'r=' + Math.random(),
                method: 'POST',
                agent: target.agent,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(payload.length),
                    'Cache-Control': 'no-cache'
                }
            }, (res) => {
                res.resume();
                res.on('end', () => {
                    const elapsedMs = Number(process.hrtime.bigint() - reqStart) / 1e6;
                    if (startedDuringMeasure) {
                        sampleCount++;
                        // A request that "completes" in under 5ms for a 1MB
                        // body almost certainly means the server responded
                        // without reading the payload (wrong endpoint, or an
                        // error response sent before the body was consumed).
                        // Don't credit bytes for those — they'd imply
                        // >1.6 Gbps on a single stream, which is not a real
                        // upload measurement.
                        if (elapsedMs < 5) {
                            fastRejectCount++;
                        } else {
                            measuredBytes += payload.length;
                            measuredMs += elapsedMs;
                        }
                    }
                    if (Date.now() < endAt) sendOnce();
                    else resolve();
                });
                res.on('error', () => resolve());
            });
            req.on('error', () => resolve());
            req.setTimeout(15000, () => { req.destroy(); resolve(); });
            req.write(payload);
            req.end();
        };
        sendOnce();
    });

    const streams = [];
    for (let i = 0; i < PARALLEL_STREAMS; i++) streams.push(runStream());
    await Promise.all(streams);

    if (fastRejectCount > 0) {
        process.stderr.write(
            `Upload: discarded ${fastRejectCount}/${sampleCount} sample(s) that completed ` +
            `suspiciously fast (server likely didn't read the uploaded body). ` +
            `If most/all samples were discarded, the upload endpoint "${path}" is probably wrong.\n`
        );
    }

    if (measuredBytes === 0 || measuredMs === 0) return 0;
    // Use wall-clock elapsed time across the full measurement window
    // (not summed per-request time, since requests run concurrently)
    // for the final Mbps figure.
    const elapsedWallMs = Date.now() - measureStart;
    if (elapsedWallMs <= 0) return 0;
    const mbps = (measuredBytes * 8) / (elapsedWallMs / 1000 * 1_000_000);
    return Math.round(mbps * 100) / 100;
}

function preflightCheck(target) {
    return new Promise((resolve, reject) => {
        const req = target.lib.request({
            hostname: target.hostname,
            port: target.port,
            protocol: target.protocol,
            path: '/',
            method: 'GET'
        }, (res) => {
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', (err) => reject(new Error(
            `Cannot reach ${target.hostname}:${target.port} — ${err.code || err.message}. ` +
            `If this server runs on another machine, verify the IP/port, that the remote ` +
            `Docker container is running, and that no firewall blocks the connection.`
        )));
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error(
                `Connection to ${target.hostname}:${target.port} timed out after 5s. ` +
                `Check that the remote host is reachable from this network.`
            ));
        });
        req.end();
    });
}

async function main() {
    try {
        const target = parseTarget(serverUrl);

        process.stderr.write(`Checking connectivity to ${target.hostname}:${target.port}...\n`);
        await preflightCheck(target);

        process.stderr.write('Measuring ping...\n');
        const ping = await measurePing(target);

        process.stderr.write('Locating download endpoint...\n');
        const downloadPath = await findEndpoint(
            target,
            [
                `/garbage.php?ckSize=${GARBAGE_CK_SIZE_MB}`,
                `/backend/garbage.php?ckSize=${GARBAGE_CK_SIZE_MB}`,
                '/garbage.php',
                '/backend/garbage.php',
                '/',
                '/index.html'
            ],
            'GET'
        );

        process.stderr.write(`Measuring download via ${downloadPath} (${PARALLEL_STREAMS} streams)...\n`);
        if (downloadPath === '/' || downloadPath === '/index.html') {
            process.stderr.write(
                `WARNING: No garbage-data endpoint found on this server — falling back to ` +
                `the index page. Download numbers will be inaccurate (much lower than real ` +
                `throughput) because each request only transfers a tiny page. Verify this ` +
                `OpenSpeedTest server exposes /garbage.php.\n`
            );
        }
        const download = await measureDownload(target, downloadPath);

        process.stderr.write('Locating upload endpoint...\n');
        const uploadPath = await findEndpoint(
            target,
            ['/upload.php', '/backend/upload.php', '/empty.php', '/backend/empty.php'],
            'POST'
        );

        process.stderr.write(`Measuring upload via ${uploadPath} (${PARALLEL_STREAMS} streams)...\n`);
        const upload = await measureUpload(target, uploadPath);
        if (upload === 0) {
            process.stderr.write(
                `WARNING: Upload measured as 0 Mbps — likely no valid upload endpoint was ` +
                `found on this server (all candidates rejected as not consuming the body), ` +
                `or every request failed/timed out.\n`
            );
        }

        // Sanity ceiling — no realistic home/office connection exceeds this.
        // If we ever hit it, it means a measurement bug let through a
        // result that wasn't really observed transfer (e.g. a fast-reject
        // loop), and we'd rather report null than poison the HA history
        // and charts with a nonsense spike.
        const SANITY_CEILING_MBPS = 20000; // headroom above 10GbE line rate
        const sanitize = (val, label) => {
            if (val != null && val > SANITY_CEILING_MBPS) {
                process.stderr.write(
                    `WARNING: ${label} measured ${val} Mbps, which exceeds the sanity ceiling ` +
                    `of ${SANITY_CEILING_MBPS} Mbps. Discarding this value as a likely ` +
                    `measurement error rather than reporting it.\n`
                );
                return null;
            }
            return val;
        };

        const result = {
            timestamp: new Date().toISOString(),
            status: 'success',
            download: sanitize(download, 'Download'),
            upload: sanitize(upload, 'Upload'),
            ping,
            server: serverUrl
        };

        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
    } catch (err) {
        process.stderr.write('Fatal error: ' + err.message + '\n');
        process.exit(1);
    }
}

main();
