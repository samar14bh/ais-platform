# AIS Platform — Data Model

## HDFS

### `/ais/vessel_positions/` — Parquet archive

Partitioned by `year=YYYY/month=MM/day=DD/hour=HH`. Written by stream job 4
with a 60-second trigger; one Parquet file per partition per trigger.

**Schema** (matches Cassandra `vessel_positions` plus partition columns):

| Column | Type | Notes |
|---|---|---|
| `mmsi` | int | Vessel identifier |
| `ship_name` | string | May be null |
| `latitude` | double | |
| `longitude` | double | |
| `speed` | double | SOG in knots |
| `course` | double | COG in degrees |
| `heading` | int | True heading |
| `nav_status` | int | ITU-R AIS status code |
| `recorded_at` | timestamp | Vessel GPS time (UTC) |
| `year` | int | Partition column |
| `month` | int | Partition column |
| `day` | int | Partition column |
| `hour` | int | Partition column |

**Compression:** Snappy (Parquet default — splittable, universally supported)

**Reading a single day:**
```python
spark.read.parquet("hdfs://hdfs-namenode:8020/ais/vessel_positions") \
    .filter("year=2026 AND month=4 AND day=28")
```
Spark applies partition pruning — only 24 `hour=` directories are read.

### `/ais/checkpoints/` — Spark streaming checkpoints

```
/ais/checkpoints/
    job1_redis/          # Kafka offsets + state for job 1 → Redis sink
    job1_cassandra/      # Kafka offsets + state for job 1 → Cassandra sink
    job2_zones/          # Kafka offsets + aggregation state for job 2
    job3_anomalies/      # Kafka offsets for job 3
    job4_hdfs_archive/   # Kafka offsets for job 4
```

Checkpoints survive container restarts. On restart, each Spark Streaming job
reads its checkpoint to determine the last committed Kafka offset and resumes
from there — no data loss, no replay from the beginning.

---

## Cassandra

### `ais.vessel_positions`

```cql
CREATE TABLE ais.vessel_positions (
    mmsi        int,
    date        date,
    recorded_at timestamp,
    ship_name   text,
    latitude    double,
    longitude   double,
    speed       double,
    course      double,
    heading     int,
    nav_status  int,
    PRIMARY KEY ((mmsi, date), recorded_at)
) WITH CLUSTERING ORDER BY (recorded_at DESC)
  AND default_time_to_live = 2592000;   -- 30 days
```

- **Partition key `(mmsi, date)`** — all positions for one vessel on one day are
  on the same node. Batch jobs filter on `date =` to trigger partition pruning.
- **Cluster key `recorded_at DESC`** — most recent position first within the
  partition; efficient for trajectory queries.
- **TTL 30 days** — rows auto-expire; no manual cleanup needed.

### `ais.batch_job_runs`

Audit log. One row per batch job execution. Not queried by the frontend.

---

## MongoDB (`ais_db`)

### `zone_stats`

One document per active zone. Overwritten by stream job 2 every 10 seconds.

```json
{
  "zone":         "adriatic",
  "avg_speed":    8.3,
  "vessel_count": 42,
  "timestamp":    "2026-05-05T12:30:00Z"
}
```

Index: `{ zone: 1, recorded_at: -1 }`

---

### `alerts`

One document per alert event. Deduped by `alert_id` (stable 5-min bucket hash).

```json
{
  "alert_id":   "sha256hex",
  "type":       "vessel_stopped_at_sea",
  "severity":   "high",
  "mmsi":       123456789,
  "ship_name":  "VESSEL NAME",
  "latitude":   37.5,
  "longitude":  15.5,
  "speed":      0.0,
  "nav_status": 0,
  "timestamp":  "2026-05-05T12:30:00Z",
  "resolved":   false
}
```

Index: `{ timestamp: -1 }`, `{ mmsi: 1, timestamp: -1 }`

---

### `vessel_profiles`

One document per vessel MMSI. Rewritten by batch job D nightly.

```json
{
  "mmsi":               123456789,
  "ship_name":          "VESSEL NAME",
  "avg_speed":          14.5,
  "speed_std_dev":      3.2,
  "max_speed":          24.1,
  "observation_count":  523,
  "last_seen_date":     "2026-05-04",
  "updated_at":         "2026-05-05T02:03:12Z"
}
```

---

### `route_segments`

One document per unique (cell_from, cell_to, window_date) transition observed
within the 200 km distance filter.

```json
{
  "cell_from":    "u2hp",
  "lat_from":     37.5,
  "lon_from":     15.5,
  "cell_to":      "u2hq",
  "lat_to":       37.6,
  "lon_to":       15.6,
  "count":        127,
  "avg_speed":    8.2,
  "window_date":  "2026-05-04",
  "updated_at":   "2026-05-05T02:15:00Z"
}
```

Index: `{ cell_from: 1, cell_to: 1 }`

---

### `zone_traffic_hourly`

```json
{
  "zone":          "adriatic",
  "hour":          "2026-05-04T14:00:00",
  "vessel_count":  45,
  "avg_speed":     8.3,
  "max_speed":     22.1,
  "message_count": 1250,
  "updated_at":    "2026-05-05T02:20:00Z"
}
```

Index: `{ zone: 1, hour: -1 }`

---

### `zone_traffic_daily`

```json
{
  "zone":         "adriatic",
  "date":         "2026-05-04",
  "vessel_count": 180,
  "avg_speed":    8.1,
  "peak_hour":    14,
  "peak_count":   52,
  "updated_at":   "2026-05-05T02:20:00Z"
}
```

Index: `{ zone: 1, date: -1 }`

---

### `heatmap_tiles_p5` / `heatmap_tiles_p6`

Same schema at two geohash precisions (p5 ≈ 5 km, p6 ≈ 1 km).

```json
{
  "cell":      "u2hp",
  "lat":       37.5,
  "lon":       15.5,
  "count":     1250,
  "vessels":   35,
  "intensity": 0.87,
  "date":      "2026-05-04",
  "updated_at":"2026-05-05T02:30:00Z"
}
```

`intensity` is log-normalised 0.0–1.0 relative to the most active cell that day.
Leaflet.heat accepts it directly as the third element of a `[lat, lon, intensity]`
tuple.

Index: `{ cell: 1, date: -1 }`

---

## Redis

| Key | Type | TTL | Value |
|---|---|---|---|
| `vessel:{mmsi}` | String | 5 min | JSON position snapshot |
| `vessel:active` | Sorted set | none | members = mmsi strings, scores = epoch ms |

**Position snapshot shape** (matches `ShipData` TypeScript interface):

```json
{
  "mmsi":       "123456789",
  "ship_name":  "VESSEL NAME",
  "lat":        37.5,
  "lon":        15.5,
  "speed":      12.5,
  "course":     180.0,
  "heading":    180,
  "nav_status": 0,
  "status":     "Under way using engine",
  "updated_at": "2026-05-05T12:30:00Z"
}
```

`nav_status` integer codes follow the ITU-R AIS standard
(0 = under way, 1 = anchored, 5 = moored, etc.).
