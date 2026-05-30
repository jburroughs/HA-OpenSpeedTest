# OpenSpeedTest Monitor — Home Assistant Addon

Run automated internet speed tests against your **self-hosted OpenSpeedTest server** and visualize download, upload, and ping over time — all within Home Assistant.

---

## Features

- **Scheduled tests** — configurable interval (5 min to 24 hours)
- **Rich dashboard** — live charts for throughput and ping history
- **Trend indicators** — delta vs. previous test for each metric
- **Full history table** — inline bar charts, status badges, timestamps
- **Ingress panel** — embedded directly in your Home Assistant sidebar
- **Persistent storage** — results survive addon restarts

---

## Requirements

- A self-hosted [OpenSpeedTest](https://openspeedtest.com/) server reachable from Home Assistant  
  (Docker: `docker run -d -p 3000:3000 openspeedtest/speed-test`)
- Home Assistant OS or Supervised installation

---

## Installation

1. **Add this repository** to Home Assistant:
   - Go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
   - Paste your repository URL

2. **Install** the *OpenSpeedTest Monitor* addon

3. **Configure** (see below), then **Start**

4. Open the **Speed Monitor** panel in your sidebar

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `openspeedtest_url` | `http://192.168.1.100:3000` | Full URL to your OpenSpeedTest server |
| `test_interval_minutes` | `30` | Minutes between tests (5–1440) |
| `max_results` | `500` | Max stored results before oldest are pruned |
| `log_level` | `info` | Log verbosity: `debug`, `info`, `warning`, `error` |

### Example `config.yaml`

```yaml
openspeedtest_url: "http://192.168.1.50:3000"
test_interval_minutes: 60
max_results: 1000
log_level: info
```

---

## How It Works

1. **`speedtest_runner.sh`** — A bash daemon that wakes on schedule and calls the Node.js worker  
2. **`speedtest_worker.js`** — Performs parallel HTTP download/upload measurements + ping against your OpenSpeedTest server and outputs JSON  
3. Results are appended to `/data/speedtest/results.json` (persistent)  
4. **nginx** serves the dashboard and exposes `/api/results` and `/api/config`

---

## Data Storage

Results are stored at `/data/speedtest/results.json` inside the addon's persistent data volume. They survive restarts and updates.

---

## Troubleshooting

- **"Test failed" in history** — Check that `openspeedtest_url` is reachable from within Home Assistant (same network). Try `curl <your_url>` from the HA host.
- **Charts empty** — Wait for the first test cycle to complete (check the addon log).
- **Dashboard not loading** — Ensure the addon is running and ingress is enabled.

---

## Architecture

```
┌─────────────────────────────────────┐
│         Home Assistant Addon        │
│                                     │
│  ┌──────────────┐  ┌─────────────┐  │
│  │  speedtest   │  │    nginx    │  │
│  │   daemon     │  │  :8099      │  │
│  │              │  │             │  │
│  │  every N min │  │  /          → Dashboard UI
│  │  → worker.js │  │  /api/      → JSON data
│  │  → results   │  │             │  │
│  │    .json     │  └─────────────┘  │
│  └──────┬───────┘                   │
│         │ HTTP tests                │
└─────────┼───────────────────────────┘
          ▼
   OpenSpeedTest Server
   (your self-hosted instance)
```
