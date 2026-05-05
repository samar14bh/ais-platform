# AIS Platform — Architecture

## What it is

OceanWatch is an end-to-end maritime analytics platform. It ingests live vessel
position messages from the [AISStream](https://aisstream.io) WebSocket service,
processes them through two parallel pipelines (real-time streaming and nightly
batch analytics), stores results in three purpose-specific databases, and serves
them to an interactive React dashboard.

The geographic scope is the Mediterranean Sea and connecting waters
(`[[30.0, -6.0], [47.0, 37.0]]`).

---

## Data flow

```
AISStream (external WebSocket)
        │  live JSON frames
        ▼
  ingestion/aisstream_producer.py
        │  publishes to Kafka
        ▼
  Kafka  ais.raw.positions  (7-day retention)
        │
   ┌────┴──────────────────────────────────┐
   │  Real-time path (Spark Streaming)     │
   │                                       │
   │  stream/job1_positions.py             │──▶ Redis  (live cache, 5 min TTL)
   │                                       │──▶ Cassandra  vessel_positions (30-day TTL)
   │  stream/job2_zone_aggregation.py      │──▶ MongoDB  zone_stats
   │  stream/job3_anomalie_detection.py    │──▶ MongoDB  alerts
   └───────────────────────────────────────┘
        │
   ┌────┴──────────────────────────────────┐
   │  Batch path (nightly, 02:00 cron)     │
   │                                       │
   │  batch/batch_job_d_vessel_profiles.py │──▶ MongoDB  vessel_profiles
   │  batch/batch_job_a_routes.py          │──▶ MongoDB  route_segments
   │  batch/batch_job_b_zone_traffic.py    │──▶ MongoDB  zone_traffic_hourly/daily
   │  batch/batch_job_c_heatmap.py         │──▶ MongoDB  heatmap_tiles_p5/p6
   └───────────────────────────────────────┘
        │
   backend/main.py  (FastAPI, port 8000)
        │  REST + WebSocket
        ▼
   frontend/  (React + Vite, port 5173)
```

---

## Technology choices

| Layer | Choice | Why |
|---|---|---|
| **Message transport** | Apache Kafka 7.5 | Durable, replayable buffer between ingestion and processing. Decouples producer speed from consumer speed. TTL-based auto-cleanup. |
| **Stream processing** | Spark Structured Streaming 3.5 | Micro-batch (10 s trigger) with exactly-once semantics via checkpointing. Native Cassandra connector pushes partition filters down to the storage layer. |
| **Batch processing** | PySpark (same cluster) | Reuses the Spark infrastructure; partition-pruned reads from Cassandra avoid full table scans. |
| **Time-series storage** | Apache Cassandra 4.1 | Write-optimised, partition-key model maps exactly to the `(mmsi, date)` query pattern. Built-in TTL eliminates manual data expiry. |
| **Analytics storage** | MongoDB 7 | Schema-flexible for heterogeneous analytics documents. Fast point reads on indexed fields. Upsert semantics simplify idempotent batch writes. |
| **Live cache** | Redis 7 | Sub-millisecond key lookup. Sorted sets give O(log n) active-vessel discovery. TTL auto-expires stale vessels. |
| **API layer** | FastAPI + Uvicorn | Async, minimal overhead. WebSocket support built-in. Auto-generated OpenAPI docs. |
| **Frontend** | React 19 + Vite + Leaflet + Recharts | Component-based UI, hot-module reload in dev. Leaflet for tile-based map; Recharts for time-series charts. |
| **Container orchestration** | Docker Compose v2 | Single-machine local development. `--profile full` selects the complete stack; omitting it runs infrastructure only. |

---

## Databases

### Cassandra — `ais` keyspace

| Table | Partition key | Cluster key | TTL | Purpose |
|---|---|---|---|---|
| `vessel_positions` | `(mmsi, date)` | `recorded_at DESC` | 30 days | Full trajectory history |
| `batch_job_runs` | `job_name` | `run_date DESC` | — | Batch job audit log |

The partition key `(mmsi, date)` means all positions for a given vessel on a given
day are co-located on the same Cassandra node. Spark reads with a `date =` filter
trigger partition pruning — only the required day is fetched, never a full scan.

### MongoDB — `ais_db` database

| Collection | Writer | Reader | Pattern |
|---|---|---|---|
| `zone_stats` | stream job 2 | backend | 1 document per zone, upserted every 10 s |
| `alerts` | stream job 3 | backend | append-only, deduped by `alert_id` |
| `vessel_profiles` | batch job D | stream job 3 | 1 doc per MMSI, updated nightly |
| `route_segments` | batch job A | backend | geohash cell pairs, updated nightly |
| `zone_traffic_hourly` | batch job B | backend | 1 doc per (zone, hour) |
| `zone_traffic_daily` | batch job B | backend | 1 doc per (zone, date) |
| `heatmap_tiles_p5` | batch job C | backend | geohash precision-5 grid |
| `heatmap_tiles_p6` | batch job C | backend | geohash precision-6 grid |

### Redis

| Key pattern | Type | TTL | Content |
|---|---|---|---|
| `vessel:{mmsi}` | String (JSON) | 5 min | Latest position snapshot |
| `vessel:active` | Sorted set | — | All active MMSI scores as timestamps |

The sorted set lets the backend retrieve all vessels active within a time window in
O(log n) without scanning all keys.

---

## Zone definitions

Eight non-overlapping Mediterranean zones are defined in `shared/zones.py` and
used by stream job 2 and all batch jobs:

| Zone | Approximate coverage |
|---|---|
| `gibraltar` | Strait of Gibraltar approach |
| `alboran` | Alboran Sea (westernmost Med) |
| `balearic_tyrrhenian` | Balearic Islands + Tyrrhenian Sea |
| `adriatic` | Full Adriatic Sea |
| `central_med` | Sicily Channel + Central Mediterranean |
| `aegean` | Full Aegean Sea |
| `eastern_med` | Eastern Mediterranean, Cyprus, Lebanon coast |
| `black_sea` | Black Sea |

Vessels outside all zones are classified as `"other"` and excluded from zone
analytics.

---

## Batch job dependency order

```
Job D  (vessel_profiles)   ← must run first
   ├── Job A  (routes)
   ├── Job B  (zone traffic)
   └── Job C  (heatmap)
```

Job D computes per-vessel speed statistics that stream job 3 uses for abnormal-speed
detection. It must complete before the others so that the profiles available in
MongoDB are up to date. Jobs A, B, C have no mutual dependencies.

---

## Anomaly detection logic

Stream job 3 generates two alert types:

**`vessel_stopped_at_sea`** (HIGH)  
Speed = 0 AND nav_status not in {1 anchored, 5 moored}. Requires no vessel profile.

**`abnormal_speed`** (MEDIUM)  
|speed − profile.avg_speed| > 2 × profile.speed_std_dev. Requires job D to have run.

Deduplication: `alert_id = sha256(mmsi + alert_type + 5-min-bucket)`. The same
vessel triggers at most one alert per type per five-minute window regardless of how
many micro-batches process it.

---

## Docker Compose profiles

```
docker compose up -d kafka cassandra redis mongodb
```
Infrastructure only — use this when loading seed data or running batch jobs manually.

```
docker compose --profile full up -d --build
```
Full stack: adds `backend`, `spark-master`, `spark-worker`, `stream-job1`,
`stream-job2`, `stream-job3`, `ingestion-producer`, `spark-batch-scheduler`.

---

## Known limitations

- **MinIO / object storage** — not included in the current stack. Will be added when HDFS integration is introduced.
- **Single-node Cassandra and MongoDB** — no replication, not production-safe.
- **Alert resolution** is manual (direct MongoDB update). No API endpoint to mark
  alerts resolved.
- **Batch cron runs at 02:00** local container time, which is UTC inside Docker.
- `cassandra_vessel_positions_all.csv` is 20 MB of seed data committed to the repo
  for convenience. It should be removed or git-ignored once a live stream has
  accumulated sufficient history.
