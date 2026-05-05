# AIS Platform — Component Reference

Every source file, its role, inputs, and outputs.

---

## Ingestion

### `ingestion/aisstream_producer.py`

Connects to the AISStream WebSocket (`wss://stream.aisstream.io/v0/stream`),
filters messages by type and bounding box, and publishes each position report as a
JSON string to Kafka topic `ais.raw.positions`.

Retry policy: exponential backoff on Kafka send failures (up to 5 retries).
WebSocket reconnect: automatic on close, every 5 seconds.

**Env vars:** `AISSTREAM_API_KEY`, `KAFKA_BROKER`, `AIS_FILTER_MESSAGE_TYPES`,
`AIS_BOUNDING_BOXES_JSON`

**Output:** Kafka `ais.raw.positions` — one message per AIS position report.

---

## Streaming jobs

All three jobs read from Kafka `ais.raw.positions` with a 10-second
`processingTime` trigger. The JSON schema used to parse messages is declared in
`stream/schema.py`. Shared SparkSession builders are in `stream/stream_utils.py`.

### `stream/job1_positions.py`

Writes each parsed position to two sinks:

- **Redis** `vessel:{mmsi}` — JSON string with latest position, TTL 5 min.
  Also maintains `vessel:active` sorted set (score = epoch ms) for fast
  active-vessel queries.
- **Cassandra** `ais.vessel_positions` — append-only insert, uses the vessel's
  own GPS timestamp (`MetaData.time_utc`) as `recorded_at`, falling back to
  processing time only if absent.

**Env vars:** `CASSANDRA_HOST`, `CASSANDRA_PORT`, `REDIS_HOST`

### `stream/job2_zone_aggregation.py`

Groups each micro-batch by Mediterranean zone (via `shared/zones.py`) and
computes average speed and vessel count per zone. Upserts one document per zone
into MongoDB `ais_db.zone_stats`.

Uses `outputMode("complete")` — the aggregation is over the full current batch,
not an accumulating window, so each trigger replaces the previous zone snapshot.

**Env vars:** `CASSANDRA_HOST`, `MONGO_USER`, `MONGO_PASSWORD`

### `stream/job3_anomalie_detection.py`

Detects two anomaly types per micro-batch and upserts alerts into MongoDB
`ais_db.alerts`:

- `vessel_stopped_at_sea` — speed = 0, nav_status not anchored/moored
- `abnormal_speed` — deviation from vessel profile exceeds 2 standard deviations

Vessel profiles are loaded from MongoDB `ais_db.vessel_profiles` with a 5-minute
in-memory TTL cache (`cachetools.TTLCache`). Alert deduplication uses a stable
`alert_id` = sha256(mmsi + type + 5-min wall-clock bucket).

**Env vars:** `CASSANDRA_HOST`, `MONGO_USER`, `MONGO_PASSWORD`

---

## Batch jobs

All jobs read from Cassandra `ais.vessel_positions` filtered to a single
`BATCH_DATE` (defaults to yesterday). The shared SparkSession builder and
Cassandra reader are in `batch/batch_utils.py`.

Filter is applied on the `date` partition key column directly — the Cassandra
connector pushes this to the storage layer so only the relevant partitions are read.

### `batch/batch_job_d_vessel_profiles.py`

**Run first.** Computes per-vessel speed statistics (mean, std dev, max,
observation count) from the target day's positions. Writes one document per MMSI
to MongoDB `ais_db.vessel_profiles` (upsert).

Used by stream job 3 for abnormal-speed detection.

### `batch/batch_job_a_routes.py`

Extracts common shipping route segments by encoding each position as a geohash
(precision 5, ~5 km), computing consecutive cell transitions per vessel, counting
occurrences, and discarding transitions longer than 200 km (GPS noise filter using
a Haversine UDF). Writes to MongoDB `ais_db.route_segments`.

### `batch/batch_job_b_zone_traffic.py`

Aggregates traffic per zone per hour and per day. Writes to
`ais_db.zone_traffic_hourly` (one doc per zone-hour) and
`ais_db.zone_traffic_daily` (one doc per zone-date, including peak hour).

### `batch/batch_job_c_heatmap.py`

Encodes positions at two geohash precisions (5 = ~5 km, 6 = ~1 km), counts
messages and unique vessels per cell, computes log-normalised intensity (0–1).
Writes to `ais_db.heatmap_tiles_p5` and `ais_db.heatmap_tiles_p6`.

### `batch/run_batch_jobs.sh`

Shell script used by the `spark-batch-scheduler` container cron job. Runs jobs
D → A → B → C in order, passing `BATCH_DATE` to each `spark-submit` invocation.
Logs success/failure for each job.

### `batch/export_cassandra_to_csv.py`

Utility script. Exports `ais.vessel_positions` (full table or a single date if
`EXPORT_DATE` is set) to a single CSV file in `batch/exports/`. Used to produce
`cassandra_vessel_positions_all.csv`. Not part of the normal pipeline.

---

## Backend

### `backend/main.py`

FastAPI application served by Uvicorn on port 8000.

Database clients are cached with `@lru_cache(maxsize=1)` — one MongoClient and
one Cassandra session are reused across all requests.

| Endpoint | Source | Notes |
|---|---|---|
| `GET /api/health` | — | Liveness check |
| `GET /api/live/vessels` | Redis | Removes stale entries (> 10 min) before responding |
| `GET /api/alerts` | MongoDB `alerts` | Sorted by timestamp desc, limit 50 |
| `GET /api/zone-stats` | MongoDB `zone_stats` | Current snapshot per zone |
| `GET /api/zone-traffic/{period}` | MongoDB `zone_traffic_hourly` or `_daily` | `period` = `hourly` or `daily` |
| `GET /api/heatmap` | MongoDB `heatmap_tiles_p5` | All tiles for latest date |
| `GET /api/routes` | MongoDB `route_segments` | All segments for latest date |
| `GET /api/vessels/{mmsi}/trajectory` | Cassandra | Last N positions for the vessel |
| `WS /ws/live-traffic` | Redis | Pushes full vessel list every 1 second |

---

## Frontend

### `frontend/src/App.tsx`

Root component. Owns the WebSocket connection lifecycle, global vessel state,
selected vessel, and view toggle (dashboard vs. traffic insights). Throttles
incoming WebSocket messages to 200 ms to avoid excessive re-renders.

### `frontend/src/api.ts`

Typed fetch wrappers for every REST endpoint. Base URL from
`VITE_API_BASE_URL` env var (default `http://localhost:8000`). WebSocket URL
is derived automatically (`http` → `ws`, `https` → `wss`).

### `frontend/src/types.ts`

TypeScript interfaces matching the backend JSON shapes: `ShipData`, `Alert`,
`ZoneStat`, `HeatmapTile`, `RouteSegment`.

### `frontend/src/components/`

| Component | Purpose |
|---|---|
| `Header.tsx` | Top bar with KPI chips (vessel count, avg speed, feed status) |
| `Sidebar.tsx` | Left panel: vessel search, recent alerts, layer toggles |
| `VesselMap.tsx` | Leaflet map: vessel markers, popups, heatmap overlay, route polylines |
| `VesselDetail.tsx` | Right panel: selected vessel metadata and trajectory trail |
| `TrafficInsightsPage.tsx` | Full-screen analytics view with zone charts and stats tables |
| `ZoneTrafficChart.tsx` | Recharts line/bar charts for zone traffic trends |
| `HeatmapToggle.tsx` | Leaflet.heat integration; toggle from sidebar |
| `RouteFlowLayer.tsx` | Weighted polylines from route_segments data |

---

## Shared utilities

### `shared/zones.py`

Single function `get_zone(lat, lon) -> str` that maps a coordinate to one of the
eight Mediterranean zone names. Used by stream job 2 (as a Python UDF registered
in Spark) and batch job B.

---

## Configuration and infrastructure

### `config/cassandra_schema.cql`

CQL file applied once at setup. Creates the `ais` keyspace
(replication factor 1), the `vessel_positions` table, and the `batch_job_runs`
audit table. Must be applied before any streaming or batch job runs.

### `docker-compose.yml`

Defines all services. Infrastructure services (kafka, cassandra, redis, mongodb,
minio) start unconditionally. Application services (backend, spark-*, stream-*,
ingestion-producer, spark-batch-scheduler) require `--profile full`.

Service health dependencies:
- `stream-job1` waits for `cassandra: service_healthy` and `kafka: service_healthy`
- `stream-job2`, `stream-job3` wait for `kafka: service_healthy` and `mongodb: service_healthy`
- `backend` waits for `redis`, `cassandra`, `mongodb`

### `docker/ingestion/Dockerfile`

Python 3.11-slim image. Installs `requirements-ingestion.txt`. Runs
`python -m ingestion.aisstream_producer`.

### `docker/spark/Dockerfile`

`apache/spark:3.5.0` base. Installs `cron` (for the batch scheduler) and
`requirements-spark.txt`.

### `batch/crontab`

```
0 2 * * *  /opt/spark-jobs/batch/run_batch_jobs.sh
```

Fires `run_batch_jobs.sh` at 02:00 UTC daily. The script runs D → A → B → C in
order. Loaded into the `spark-batch-scheduler` container at startup.

### `scripts/init_mongo.js`

Idempotent MongoDB initialisation. Creates the eight collections in `ais_db` and
their indexes if they do not already exist. Run once after first boot via:

```powershell
$id = (docker compose ps -q mongodb).Trim()
docker cp scripts\init_mongo.js ${id}:/tmp/init_mongo.js
docker compose exec mongodb mongosh "mongodb://admin:admin@localhost:27017/admin?authSource=admin" /tmp/init_mongo.js
```

### `scripts/load_csv_to_cassandra.py`

One-shot loader for `cassandra_vessel_positions_all.csv`. Uses the `cqlsh COPY`
approach inside the Docker container (see START.md section 1.5) because
`cassandra-driver` does not support Python 3.12+.

---

## Requirements files

| File | Used by | Contents |
|---|---|---|
| `requirements-ingestion.txt` | `docker/ingestion/Dockerfile` | kafka-python, websockets, python-dotenv |
| `requirements-spark.txt` | `docker/spark/Dockerfile` | pymongo, redis, geohash2, cachetools, python-dotenv, cassandra-driver |
| `backend/requirements.txt` | `backend/Dockerfile` | fastapi, uvicorn, pymongo, redis, cassandra-driver |
