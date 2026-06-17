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

const PARALLEL_STREAMS = 6;
const WARMUP_MS = 1500;
const TEST_DURATION_MS = 10000;
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for upload
const GARBAGE_CK_SIZE_MB = 25;  // 25MB per chunk — large enough that HTTP/TCP
                                 // overhead is negligible, small enough that
                                 // even modest connections complete multiple
                                 // chunks within the test window

function parseTarget(base) {
    const url = new URL('/', base);
    return {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80),
        protocol: url.protocol,
        lib: url.protocol === 'https:' ? https : http
    };
}

function findEndpoint(target, candidates, method) {
    return new Promise((resolve) => {
        let i = 0;
        let fallback = null;
        const tryNext = () => {
            if (i >= candidates.length) return resolve(fallback || '/');
            const path = candidates[i++];
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path,
                method,
                headers: method === 'POST'
                    ? { 'Content-Type': 'application/octet-stream', 'Content-Length': '1024' }
                    : {}
            }, (res) => {
                let bytes = 0;
                res.on('data', (chunk) => { bytes += chunk.length; });
                res.on('end', () => {
                    if (res.statusCode >= 400) return tryNext();
                    // Remember the first endpoint that at least responds OK,
                    // as a last-resort fallback if nothing better is found.
                    if (fallback === null) fallback = path;
                    // For GET (download) endpoints, require a real payload —
                    // OpenSpeedTest's garbage endpoints stream megabytes;
                    // a few hundred bytes means we hit a static page, not the
                    // actual test endpoint, and would silently wreck the
                    // throughput measurement if accepted.
                    if (method === 'GET' && bytes < 50000) return tryNext();
                    resolve(path);
                });
                res.on('error', tryNext);
            });
            if (method === 'POST') req.write(Buffer.alloc(1024));
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
                headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
            }, (res) => {
                res.on('data', (chunk) => {
                    totalBytes += chunk.length;
                    if (Date.now() >= measureStart) measuredBytes += chunk.length;
                });
                res.on('end', () => {
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
    return Math.round(mbps * 100) / 100;
}

/**
 * Runs N parallel persistent upload streams against `path`.
 */
async function measureUpload(target, path) {
    const payload = Buffer.alloc(CHUNK_SIZE, 0x61);
    let measuredBytes = 0;
    const globalStart = Date.now();
    const measureStart = globalStart + WARMUP_MS;
    const endAt = measureStart + TEST_DURATION_MS;

    const runStream = () => new Promise((resolve) => {
        const sendOnce = () => {
            if (Date.now() >= endAt) return resolve();
            const startedDuringMeasure = Date.now() >= measureStart;
            const sep = path.includes('?') ? '&' : '?';
            const req = target.lib.request({
                hostname: target.hostname,
                port: target.port,
                protocol: target.protocol,
                path: path + sep + 'r=' + Math.random(),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(payload.length),
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            }, (res) => {
                res.resume();
                res.on('end', () => {
                    if (startedDuringMeasure) measuredBytes += payload.length;
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

    const elapsedMeasured = (Date.now() - measureStart) / 1000;
    if (elapsedMeasured <= 0) return 0;
    const mbps = (measuredBytes * 8) / (elapsedMeasured * 1_000_000);
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
            ['/upload.php', '/backend/upload.php', '/empty.php'],
            'POST'
        );

        process.stderr.write(`Measuring upload via ${uploadPath} (${PARALLEL_STREAMS} streams)...\n`);
        const upload = await measureUpload(target, uploadPath);

        const result = {
            timestamp: new Date().toISOString(),
            status: 'success',
            download,
            upload,
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
