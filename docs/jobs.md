# AIS Platform — Stream & Batch Jobs

This document covers every Spark job in the platform: what it reads, what it
computes, what it writes, and why it is designed the way it is.

---

## Stream Jobs

All four stream jobs share the same Kafka source topic (`ais.raw.positions`) and
run continuously inside Docker containers. They are independent Spark applications
— each runs in local mode with its own JVM, its own Kafka consumer group, and its
own HDFS checkpoint directory.

### Shared input schema

Every stream job parses the same Kafka message format:

```
{
  "MetaData": {
    "MMSI": int,
    "ShipName": str,
    "latitude": float,
    "longitude": float,
    "time_utc": str        // ISO timestamp from AISStream
  },
  "Message": {
    "PositionReport": {
      "Sog": float,        // Speed Over Ground (knots)
      "Cog": float,        // Course Over Ground (degrees)
      "TrueHeading": int,  // 0–359, 511 = unknown
      "NavigationalStatus": int  // ITU-R AIS status code 0–28
    }
  }
}
```

---

### Job 1 — Live positions (`stream/job1_positions.py`)

**What it does:** Consumes every AIS message and writes the raw position to two
sinks: Redis for live state and Cassandra for trajectory history.

**Kafka config:**
- Starting offset: `earliest` — on first start, processes all retained messages
  so Redis is populated immediately rather than waiting for new traffic
- Trigger: `10 seconds`

**Parsing:**
Extracts `mmsi`, `ship_name`, `latitude`, `longitude`, `speed`, `course`,
`heading`, `nav_status`, and `recorded_at` (parsed from `MetaData.time_utc`;
falls back to `current_timestamp()` if the field is missing or unparseable).
Adds a `date` column derived from `recorded_at` — this becomes the Cassandra
partition key.

**Sink 1 — Redis** (checkpoint: `/ais/checkpoints/job1_redis`):
- Key: `vessel:{mmsi}` → JSON snapshot of the vessel's current state
- TTL: 300 seconds (5 minutes). Vessels that stop transmitting expire automatically.
- Sorted set: `vessel:active`, score = `recorded_at` Unix timestamp. The backend
  uses `ZRANGEBYSCORE` to find active vessels by time window in O(log n), then
  pipelines `GET` calls for each key — one round trip to Redis regardless of fleet size.

**Sink 2 — Cassandra** (checkpoint: `/ais/checkpoints/job1_cassandra`):
- Table: `ais.vessel_positions`
- Mode: append
- The `(mmsi, date)` partition key means all positions for one vessel on one day
  are co-located. Trajectory queries (`WHERE mmsi = X AND date = Y`) hit a single
  partition.

**Why both sinks in one job:**
Both sinks write the same parsed record with no transformation difference between
them. Splitting into two jobs would deserialise every Kafka message twice in
separate JVMs, doubling CPU and memory for no benefit.

---

### Job 2 — Zone aggregation (`stream/job2_zone_aggregation.py`)

**What it does:** Groups active vessels by Mediterranean zone and computes
per-zone averages every 10 seconds, writing a live snapshot to MongoDB.

**Kafka config:**
- Starting offset: `latest` — only current traffic matters for zone stats;
  historical catchup would produce stale aggregates
- Trigger: `10 seconds`

**Zone assignment:**
A Python UDF (inlined to avoid cloudpickle import issues) maps each `(latitude,
longitude)` pair to one of 8 zones. Vessels outside all zone boundaries are
assigned `other` and excluded from output.

| Zone | Lat range | Lon range |
|---|---|---|
| `gibraltar` | 35–42°N | 6°W–0° |
| `alboran` | 35–40°N | 0–5°E |
| `balearic_tyrrhenian` | 37–44°N | 5–15°E |
| `adriatic` | 38–46°N | 12–22°E |
| `central_med` | 30–38°N | 9–16°E |
| `aegean` | 35–42°N | 19–30°E |
| `eastern_med` | 30–42°N | 26–37°E |
| `black_sea` | 30–48°N | 27–42°E |

**Aggregation:**
`groupBy(zone)` → `avg(speed)`, `count(mmsi)`. Uses `outputMode("complete")` so
every trigger re-emits all zones — the MongoDB `update_one` upsert overwrites the
previous document for each zone, keeping one live document per zone.

**Why `complete` output mode:**
With `append` mode, a zone with no new traffic in the current 10-second window
would not appear in the output, leaving its MongoDB document stale. `complete`
mode re-emits every zone every trigger, so MongoDB always reflects the current
distribution of traffic across all zones.

**MongoDB output** (checkpoint: `/ais/checkpoints/job2_zones`):
- Collection: `zone_stats`
- One document per zone, upserted on `zone` key
- Fields: `zone`, `avg_speed`, `vessel_count`, `timestamp`

---

### Job 3 — Anomaly detection (`stream/job3_anomalie_detection.py`)

**What it does:** Scans each batch of AIS messages for two anomaly types and
writes alert documents to MongoDB, deduplicated by a stable 5-minute hash.

**Kafka config:**
- Starting offset: `latest`
- Trigger: `10 seconds`

**Anomaly rule 1 — Vessel stopped at sea:**
- Condition: `speed == 0 AND nav_status NOT IN {1, 5}`
- Nav status 1 = at anchor, 5 = moored. A vessel with speed 0 but neither at
  anchor nor moored is potentially in distress, drifting, or has lost propulsion.
- Severity: `high`

**Anomaly rule 2 — Abnormal speed:**
- Condition: `speed > 5 AND abs(speed − avg_speed) > 2 × std_dev`
- Compares each vessel's current speed against its historical behavioural profile
  (from MongoDB `vessel_profiles`, written nightly by batch job D).
- The 2σ threshold catches genuine outliers while tolerating normal speed variance.
- Only fires if `speed > 5` to exclude vessels manoeuvring at low speed near port.
- Severity: `medium`
- If no profile exists for a vessel, this rule is skipped for that vessel (no
  false positives from unknown vessels).

**Profile caching:**
Vessel profiles are fetched from MongoDB and cached in a `TTLCache` (max 5,000
entries, 300-second TTL) to avoid a MongoDB lookup on every single AIS message.
The cache is per-executor process; profiles are refreshed at most every 5 minutes.

**Alert deduplication:**
Alert ID = `SHA256(mmsi + alert_type + 5-minute-bucket)`. This means the same
anomaly condition produces the same alert ID within any 5-minute window —
repeated triggers don't create duplicate alerts. The MongoDB upsert on `alert_id`
enforces this at the storage level.

**Why batch job D must run before stream job 3 is useful:**
On a fresh install, `vessel_profiles` is empty so the abnormal-speed rule never
fires. Running batch job D on historical data populates profiles for all known
vessels, immediately enabling the speed anomaly rule for the live stream.

**MongoDB output** (checkpoint: `/ais/checkpoints/job3_anomalies`):
- Collection: `alerts`
- Upserted on `alert_id`
- Fields: `alert_id`, `type`, `severity`, `mmsi`, `ship_name`, `latitude`,
  `longitude`, `speed`, `timestamp`, `resolved`

---

### Job 4 — HDFS archive (`stream/job4_hdfs_archive.py`)

**What it does:** Archives every AIS position to HDFS as Parquet, partitioned by
time. This is the permanent cold store — data here never expires.

**Kafka config:**
- Starting offset: `earliest` — archives everything retained in Kafka, not just
  new messages
- `failOnDataLoss: false` — if Kafka drops old segments before the job processes
  them, skip rather than crash
- Trigger: `60 seconds` — longer than the other jobs to avoid creating thousands
  of tiny Parquet files (the small-files problem in HDFS)

**Partition columns:**
`year`, `month`, `day`, `hour` — derived from `recorded_at`. Written as
Hive-compatible directory names (`year=2026/month=4/day=28/hour=14/`) so Spark
can apply partition pruning when batch jobs read historical data.

**`coalesce(1)` per partition:**
Each `hour=` directory contains exactly one Parquet file. With a single DataNode,
there is no benefit to multiple files per partition, and one file per hour keeps
the HDFS namespace manageable (24 files/day vs potentially hundreds).

**Why a 60-second trigger:**
A 10-second trigger would create 6 Parquet files per hour per partition — 144
files per day. Over weeks, the HDFS namespace fills with millions of tiny files,
degrading NameNode performance. The 60-second trigger produces one file per hour
per trigger window (coalesced), which is the right granularity for a daily batch
analytics workload.

**HDFS output** (checkpoint: `/ais/checkpoints/job4_hdfs_archive`):
- Path: `hdfs://hdfs-namenode:8020/ais/vessel_positions/`
- Format: Parquet, Snappy compression
- Partitioned by: `year`, `month`, `day`, `hour`

---

## Batch Jobs

Batch jobs run nightly at 02:00 UTC via cron inside the `spark-batch-scheduler`
container. They are executed sequentially by `run_batch_jobs.sh` in a fixed order:
D → A → B → C.

All batch jobs default to processing yesterday's date (`BATCH_DATE` env var).
They all read from Cassandra for recent dates (≤30 days) or HDFS for historical
dates (>30 days) via `batch_utils.read_vessel_positions_auto()`.

### Shared data quality filters

Applied to every batch read before any job-specific logic:

- `mmsi` is not null
- `latitude` and `longitude` are not null
- Not null island: `NOT (lat BETWEEN -0.001 AND 0.001 AND lon BETWEEN -0.001 AND 0.001)`
  — filters GPS hardware returning `(0, 0)` as a default
- Latitude within `[-90, 90]`, longitude within `[-180, 180]`
- Optionally: `speed` is not null (used by jobs B and D)

---

### Job D — Vessel behavioural profiles (`batch/batch_job_d_vessel_profiles.py`)

**Run order: first.** Job 3 (stream) depends on these profiles.

**What it does:** Computes a speed profile for every vessel observed on the target
date and writes it to MongoDB. Stream job 3 uses these profiles to detect
abnormal speed anomalies.

**Additional filter beyond shared quality:** `speed > 0` — stationary readings
(anchored, moored) are excluded so profiles reflect a vessel's actual movement
behaviour, not its idle state.

**Aggregation per MMSI:**
- `last(ship_name, ignoreNulls=True)` — most recent name for the vessel
- `avg(speed)` → `avg_speed`
- `stddev(speed)` → `speed_std_dev` (null-safe: 0.0 if only one observation)
- `max(speed)` → `max_speed`
- `count(speed)` → `observation_count`

**MongoDB output:**
- Collection: `vessel_profiles`
- Upserted on `mmsi`
- Fields: `mmsi`, `ship_name`, `avg_speed`, `speed_std_dev`, `max_speed`,
  `observation_count`, `last_seen_date`, `updated_at`

**Relationship to stream job 3:**
When stream job 3 processes a position report, it looks up the vessel's profile
from `vessel_profiles`. If `abs(current_speed − avg_speed) > 2 × speed_std_dev`,
an alert is raised. The batch job runs nightly so profiles are always based on
recent observed behaviour, not stale data.

---

### Job A — Route segments (`batch/batch_job_a_routes.py`)

**What it does:** Identifies the most common vessel movement corridors by
computing geohash cell-to-cell transitions and counting how often each transition
occurs.

**Geohash precision:** 5 (~4.9 km × 4.9 km cells at the equator). Coarse enough
to capture corridor-level movement, fine enough to distinguish routes near ports.

**Processing pipeline:**

1. Encode each position to a geohash cell
2. For each vessel, order positions by `recorded_at` and extract the previous
   cell using a lag window function
3. Drop rows where the vessel didn't move to a new cell (`prev_cell == cell`)
4. Apply haversine distance filter: `segment_km <= 200`. This removes teleport
   artifacts where a vessel appears to jump across the Mediterranean in one step
   (GPS error, duplicate MMSI, vessel restart)
5. Group by `(prev_cell, cell)` and count transitions; compute average speed
6. Filter: keep only transitions seen at least twice (`count >= 2`) to remove
   one-off crossings that aren't real corridors
7. Decode geohash centroids to get `lat_from/lon_from/lat_to/lon_to` for the
   frontend to draw route arcs

**Why 200 km cutoff:**
The Mediterranean is ~800 km east-west. A 200 km segment is a realistic 4–6 hour
sailing distance. Any apparent jump longer than this is almost certainly a GPS
artifact, an AIS gap, or a duplicate MMSI rather than real movement.

**MongoDB output:**
- Collection: `route_segments`
- Upserted on `(cell_from, cell_to, window_date)`
- Fields: `cell_from`, `cell_to`, `lat_from`, `lon_from`, `lat_to`, `lon_to`,
  `count`, `avg_speed`, `window_date`, `updated_at`

---

### Job B — Zone traffic (`batch/batch_job_b_zone_traffic.py`)

**What it does:** Computes hourly and daily vessel traffic statistics per
Mediterranean zone, including the peak traffic hour for each zone.

**Zone assignment:** Same 8-zone UDF as stream job 2, inlined for the same
cloudpickle reason.

**Hourly aggregation (`zone_traffic_hourly`):**
Groups by `(zone, hour_ts)` where `hour_ts = date_trunc("hour", recorded_at)`.
Per group: `countDistinct(mmsi)` → distinct vessels seen that hour,
`avg(speed)`, `max(speed)`, `count(mmsi)` → total AIS messages.

**Daily aggregation (`zone_traffic_daily`):**
Groups by `(zone, date)`. Same metrics plus peak hour calculation:
- Sub-aggregation: `(zone, date, hour_of_day)` → count distinct MMSIs per hour
- Window rank over `(zone, date)` ordered by count descending → take rank 1
- The result is the hour-of-day (0–23) with the most distinct vessels, and
  how many vessels were in that peak hour

**Why `countDistinct(mmsi)` for vessel count vs `count(mmsi)` for message count:**
A vessel transmits AIS every few seconds. `count(mmsi)` would give the number of
position reports, not the number of distinct vessels — uninformative for "how
busy is this zone." `countDistinct(mmsi)` answers "how many different vessels
were in this zone this hour."

**MongoDB output:**
- Collections: `zone_traffic_hourly`, `zone_traffic_daily`
- Upserted on `(zone, hour)` and `(zone, date)` respectively

---

### Job C — Heatmap tiles (`batch/batch_job_c_heatmap.py`)

**What it does:** Builds a density grid of vessel activity across the
Mediterranean at two geohash precisions, normalised for the frontend heatmap layer.

**Two precision levels:**
- **P5** (~4.9 km cells) — regional overview, loaded by default on the map
- **P6** (~1.2 km cells) — coastal/port detail, loaded when zoomed in

**Per-cell aggregation:**
- `count(mmsi)` → total AIS messages in this cell (activity volume)
- `countDistinct(mmsi)` → distinct vessels (unique traffic)

**Intensity normalisation (log scale):**
```
intensity = log(1 + count) / log(1 + max_count)
```
Raw message counts range from 2 (a vessel passing through once) to 10,000+
(a busy anchorage). A linear scale would make all but the hottest cells invisible.
Log normalisation compresses this range to 0–1 while preserving relative
differences between moderately active and very active cells.

**Bulk write in batches of 1,000:**
Collecting all cells at once and sending 5,000+ MongoDB write operations in a
single list would exhaust driver memory. Batching at 1,000 keeps memory flat
regardless of how many cells exist.

**MongoDB output:**
- Collections: `heatmap_tiles_p5`, `heatmap_tiles_p6`
- Upserted on `(cell, date)`
- Fields: `cell`, `lat`, `lon`, `count`, `vessels`, `intensity`, `date`,
  `updated_at`
- Geospatial index on `(lat, lon)` for bounding-box queries

---

## Execution order and dependencies

```
02:00 UTC  run_batch_jobs.sh
    │
    ├─ Job D (vessel profiles)
    │       ↓ writes vessel_profiles to MongoDB
    │
    ├─ Job A (route segments)   ← no dependency on D
    │
    ├─ Job B (zone traffic)     ← no dependency on D or A
    │
    └─ Job C (heatmap)          ← no dependency on any other batch job
```

Jobs A, B, C are independent of each other but run sequentially to avoid
saturating the Spark driver with three concurrent applications in a
memory-constrained Docker environment. Job D must run first because stream
job 3 starts reading `vessel_profiles` as soon as it processes its next batch —
if D hasn't run yet on a fresh install, abnormal-speed detection is blind.

---

## Utilities

### `stream/stream_utils.py`

Shared helpers for all stream jobs:

- `load_stream_env()` — reads and validates environment variables; returns a dict
  with `kafka_broker`, `mongo_uri`, `hdfs_uri`
- `build_stream_spark_session(app_name)` — creates a SparkSession configured
  with the Kafka connector package and HDFS as the default filesystem
- `read_ais_kafka_stream(spark, broker)` — returns a Kafka `readStream` on
  `ais.raw.positions`
- `parse_ais_payload(df)` — parses the Kafka `value` bytes as JSON against the
  AIS schema; returns a DataFrame with a `d` struct column containing all fields

### `batch/batch_utils.py`

Shared helpers for all batch jobs:

- `read_vessel_positions_for_date(spark, date)` — reads from Cassandra with
  partition key pushdown on `date`
- `read_vessel_positions_from_hdfs(spark, date)` — reads from HDFS Parquet with
  Hive partition pruning on `year/month/day`
- `read_vessel_positions_auto(spark, date, cassandra_ttl_days=30)` — routes to
  Cassandra (recent) or HDFS (historical) automatically; both return identically
  shaped DataFrames so batch job code is source-agnostic
- `_clean_positions(df, ...)` — applies the shared quality filters described above

### `stream/schema.py`

Defines the Spark `StructType` for the AIS JSON payload. Used by `parse_ais_payload()`
to parse Kafka messages with type enforcement rather than inferred schema, which
would require a full scan of the batch to determine types.
