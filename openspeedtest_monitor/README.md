# OpenSpeedTest Monitor — Home Assistant Addon

Run automated internet speed tests against any reachable **OpenSpeedTest server** — local or running as a Docker container on another machine — and visualize download, upload, and ping over time, with results published as native Home Assistant sensors.

---

## Features

- **Scheduled tests** against a configurable target (local or remote host)
- **6-stream parallel throughput measurement** for more realistic Mbps figures than a single-connection test
- **Native HA sensor entities** updated after every test run
- **Rich inline dashboard** — charts, history table, trend deltas
- **Persistent storage** — results survive addon restarts

---

## Pointing at a remote OpenSpeedTest container

`openspeedtest_url` accepts any reachable host — it doesn't have to run on the same machine as Home Assistant. To target a Docker container running on another system on your network:

```yaml
openspeedtest_url: "http://10.0.0.50:3000"
```

On startup, the addon does a quick reachability check and logs the result, so connectivity problems with a remote host show up immediately in the addon log rather than waiting for the first scheduled test.

**Requirements for a remote target:**
- The remote host/container must be reachable from your HA host (same LAN/VLAN, or routed with no firewall blocking the port)
- The port in `openspeedtest_url` must match what the remote container exposes

---

## A note on `host_network` and ingress

This addon intentionally does **not** set `host_network: true`. While host networking can reduce Docker NAT overhead for raw throughput measurements, it conflicts with how Home Assistant's ingress proxy resolves the addon's internal address — ingress relies on the container having a normal Docker bridge IP. Combining `host_network: true` with `ingress: true` reliably produces `504 Gateway Time-out` errors from the ingress proxy (openresty).

The addon instead relies on its multi-stream worker (6 parallel persistent connections) to get throughput numbers close to real LAN speed even over the standard Docker bridge network — bridge NAT overhead is typically a few percent on a LAN, while a single-connection naive test can undercount by 5-10x due to TCP slow start and lack of parallelism.

If you need to rule out bridge networking as a factor entirely, you can test the OpenSpeedTest server directly from a browser on the HA host's network and compare against the addon's reported numbers.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `openspeedtest_url` | `http://192.168.1.100:3000` | Full URL to your OpenSpeedTest server (local or remote) |
| `test_interval_minutes` | `30` | Minutes between tests (5–1440) |
| `max_results` | `500` | Max stored results before oldest are pruned |
| `log_level` | `info` | Log verbosity |

---

## Home Assistant Entities

| Entity ID | Description |
|-----------|--------------|
| `sensor.openspeedtest_download` | Download speed (Mbit/s) |
| `sensor.openspeedtest_upload` | Upload speed (Mbit/s) |
| `sensor.openspeedtest_ping` | Latency (ms) |
| `sensor.openspeedtest_status` | OK / Error |
| `sensor.openspeedtest_last_run` | Timestamp of last test |

---

## Troubleshooting

- **`504 Gateway Time-out` opening the dashboard** — verify `host_network` is not set in `config.yaml`; it must remain absent/false for ingress to function.
- **"Cannot reach host" errors in logs** — check IP/port, firewall rules between hosts, and that the remote container is actually running.
- **Speeds look lower than a desktop browser test** — some gap vs. bridge-network NAT is expected; if it's large (multiples, not percent), check the addon log for which endpoint paths were detected (`/garbage.php` vs falling back to `/`), since some OpenSpeedTest deployments use different paths than the official Docker image.
