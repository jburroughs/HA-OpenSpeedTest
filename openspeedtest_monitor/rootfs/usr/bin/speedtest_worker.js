#!/usr/bin/env node
/**
 * OpenSpeedTest Worker
 * Performs a speed test against a self-hosted OpenSpeedTest server.
 * OpenSpeedTest exposes a simple HTTP-based test endpoint.
 *
 * Download: repeatedly fetch a large chunk from the server and measure throughput.
 * Upload:   repeatedly POST data to the server and measure throughput.
 * Ping:     measure HTTP round-trip latency.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const serverUrl = process.argv[2];
if (!serverUrl) {
    console.error('Usage: speedtest_worker.js <openspeedtest_url>');
    process.exit(1);
}

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const lib = options.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let data = Buffer.alloc(0);
            res.on('data', chunk => { data = Buffer.concat([data, chunk]); });
            res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('Request timeout')); });
        if (postData) req.write(postData);
        req.end();
    });
}

async function measurePing(base) {
    const url = new URL('/', base);
    const samples = [];
    for (let i = 0; i < 5; i++) {
        const start = Date.now();
        try {
            await makeRequest({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: '/',
                method: 'GET',
                protocol: url.protocol,
                headers: { 'Cache-Control': 'no-cache' }
            });
            samples.push(Date.now() - start);
        } catch (e) { /* skip failed ping */ }
        await new Promise(r => setTimeout(r, 100));
    }
    if (samples.length === 0) return null;
    return Math.min(...samples);
}

async function measureDownload(base, durationMs = 8000) {
    const url = new URL('/', base);
    const hostname = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const protocol = url.protocol;

    // OpenSpeedTest serves a garbage endpoint — fall back to downloading index repeatedly
    const paths = ['/garbage.php', '/backend/garbage.php', '/'];
    let testPath = '/';
    for (const p of paths) {
        try {
            const r = await makeRequest({ hostname, port, path: p, method: 'GET', protocol });
            if (r.statusCode < 400) { testPath = p; break; }
        } catch(_) {}
    }

    let totalBytes = 0;
    const start = Date.now();
    const promises = [];

    const fetchChunk = () => new Promise((resolve) => {
        const lib = protocol === 'https:' ? https : http;
        const options = {
            hostname, port, protocol,
            path: testPath + '?r=' + Math.random(),
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
        };
        const req = lib.request(options, (res) => {
            let bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; totalBytes += chunk.length; });
            res.on('end', () => resolve(bytes));
        });
        req.on('error', () => resolve(0));
        req.setTimeout(10000, () => { req.destroy(); resolve(0); });
        req.end();
    });

    // Parallel connections for accurate throughput measurement
    const runParallel = async () => {
        while (Date.now() - start < durationMs) {
            await fetchChunk();
        }
    };

    await Promise.all([runParallel(), runParallel(), runParallel()]);

    const elapsed = (Date.now() - start) / 1000;
    const mbps = (totalBytes * 8) / (elapsed * 1_000_000);
    return Math.round(mbps * 100) / 100;
}

async function measureUpload(base, durationMs = 8000) {
    const url = new URL('/', base);
    const hostname = url.hostname;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const protocol = url.protocol;

    const uploadPaths = ['/upload.php', '/backend/upload.php', '/empty.php', '/'];
    let testPath = '/';
    for (const p of uploadPaths) {
        try {
            const r = await makeRequest({
                hostname, port, path: p, method: 'POST', protocol,
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' }
            }, Buffer.alloc(0));
            if (r.statusCode < 500) { testPath = p; break; }
        } catch(_) {}
    }

    const chunkSize = 1024 * 256; // 256 KB per chunk
    const payload = Buffer.alloc(chunkSize, 'x');
    let totalBytes = 0;
    const start = Date.now();

    const uploadChunk = () => new Promise((resolve) => {
        const lib = protocol === 'https:' ? https : http;
        const options = {
            hostname, port, protocol,
            path: testPath + '?r=' + Math.random(),
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(chunkSize),
                'Cache-Control': 'no-cache'
            }
        };
        const req = lib.request(options, (res) => {
            res.resume();
            res.on('end', () => { totalBytes += chunkSize; resolve(); });
        });
        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(payload);
        req.end();
    });

    const runParallel = async () => {
        while (Date.now() - start < durationMs) {
            await uploadChunk();
        }
    };

    await Promise.all([runParallel(), runParallel()]);

    const elapsed = (Date.now() - start) / 1000;
    const mbps = (totalBytes * 8) / (elapsed * 1_000_000);
    return Math.round(mbps * 100) / 100;
}

async function main() {
    try {
        process.stderr.write('Measuring ping...\n');
        const ping = await measurePing(serverUrl);

        process.stderr.write('Measuring download...\n');
        const download = await measureDownload(serverUrl);

        process.stderr.write('Measuring upload...\n');
        const upload = await measureUpload(serverUrl);

        const result = {
            timestamp: new Date().toISOString(),
            status: 'success',
            download: download,
            upload: upload,
            ping: ping,
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
