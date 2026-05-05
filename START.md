# AIS Platform — Start & Test Guide

This document is the single reference for bringing the full system up from zero,
loading historical data, running batch analytics, and verifying that every layer
is working correctly.

---

## Prerequisites

Before you start, make sure you have:

- **Docker Desktop** running with at least **8 GB RAM** allocated to containers
  (Settings → Resources → Memory). Spark needs headroom.
- **Node.js 18+** installed locally (for the frontend dev server).
- **Python 3.9+** installed locally (only needed to run the CSV loader script).
- An **AISStream API key** — free registration at https://aisstream.io. Required
  only if you want live vessel data. The system works without it using the CSV data.

---

## Part 1 — First-time setup

### 1.1 — Create your environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in the required values:

```
MONGO_USER=admin
MONGO_PASSWORD=yourpassword

MINIO_USER=minioadmin
MINIO_PASSWORD=yourpassword

AISSTREAM_API_KEY=your_key_here
```

Everything else in `.env` can stay at its default. The `BATCH_DATE` variable can
be left blank — all batch jobs default to processing yesterday's date.

---

### 1.2 — Start core infrastructure

Start the databases and Kafka first, without Spark or ingestion. This lets you
apply schemas before any application code runs.

```powershell
docker compose up -d kafka cassandra redis mongodb
```

Check that all four are running:

```powershell
docker compose ps
```

Expected output: kafka, cassandra, redis, mongodb all showing `running` or
`healthy`. Cassandra takes 60–90 seconds on first boot.

Wait until Cassandra is fully ready before continuing:

```powershell
docker compose ps cassandra
```

Keep running this until the `STATUS` column shows `healthy`. Do not proceed until
it does — Cassandra's native transport isn't accepting connections until then.

---

### 1.3 — Apply the Cassandra schema

```powershell
$id = (docker compose ps -q cassandra).Trim()
docker cp config\cassandra_schema.cql ${id}:/tmp/schema.cql
docker compose exec cassandra cqlsh -f /tmp/schema.cql
```

Verify the tables were created:

```powershell
docker compose exec cassandra cqlsh -e "USE ais; DESCRIBE TABLES;"
```

Expected output:
```
vessel_positions  batch_job_runs
```

---

### 1.4 — Initialize MongoDB collections and indexes

```powershell
$id = (docker compose ps -q mongodb).Trim()
docker cp scripts\init_mongo.js ${id}:/tmp/init_mongo.js
docker compose exec mongodb mongosh -u $env:MONGO_USER -p $env:MONGO_PASSWORD --authenticationDatabase admin /tmp/init_mongo.js
```

Expected output ends with:
```
MongoDB initialization completed.
```

---

### 1.5 — Load the historical CSV data into Cassandra

The file `cassandra_vessel_positions_all.csv` contains 243,330 real AIS position
records (3,863 vessels, dates 2026-04-28, 2026-04-29, 2026-04-30). Loading it
gives the batch jobs real data to process immediately without waiting for the live
stream to accumulate data.

Copy the file into the Cassandra container and use `cqlsh COPY` to bulk-load it:

```powershell
$id = (docker compose ps -q cassandra).Trim()
docker cp cassandra_vessel_positions_all.csv ${id}:/tmp/vessel_positions.csv
docker compose exec cassandra cqlsh -e "COPY ais.vessel_positions (mmsi, date, recorded_at, ship_name, latitude, longitude, speed, course, heading, nav_status) FROM '/tmp/vessel_positions.csv' WITH HEADER=TRUE AND DATETIMEFORMAT='%Y-%m-%dT%H:%M:%S.%fZ' AND NUMPROCESSES=4;"
```

This takes about 10 seconds. Expected final line:

```
243330 rows imported from 1 files in 0 day, 0 hour, 0 minute, and 10.195 seconds (0 skipped).
```

Verify the data is in Cassandra:

```powershell
docker compose exec cassandra cqlsh -e "SELECT COUNT(*) FROM ais.vessel_positions WHERE mmsi = 224181370 AND date = '2026-04-29';"
```

Expected: `358` (the largest single partition in the seed dataset).

---

## Part 2 — Start the application services

### 2.1 — Build and start everything

```powershell
docker compose --profile full up -d --build
```

This builds and starts:

| Service | What it does |
|---|---|
| `backend` | FastAPI server on port 8000 |
| `spark-master` | Spark cluster master on port 8080 |
| `spark-worker` | Spark worker node |
| `stream-job1` | Spark streaming: Kafka → Redis + Cassandra |
| `stream-job2` | Spark streaming: Kafka → MongoDB zone stats |
| `stream-job3` | Spark streaming: Kafka → MongoDB anomaly alerts |
| `ingestion-producer` | AISStream WebSocket → Kafka |
| `spark-batch-scheduler` | Cron scheduler for nightly batch jobs |

**First run note:** stream-job1, stream-job2, and stream-job3 each download ~200 MB
of Spark/Kafka Maven JARs on first startup. This takes 3–8 minutes depending on
your connection. After the first run they are cached.

Check that everything started:

```powershell
docker compose --profile full ps
```

All services should show `running` or `Up`. Stream jobs showing `healthy` means
they are processing data.

---

### 2.2 — Start the frontend

The frontend runs locally against the backend API.

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

If you see the OceanWatch dashboard but the map is empty and "Feed: Offline" is
shown, the backend is not reachable yet. Give it 30 seconds and refresh.

---

## Part 3 — Verify each layer is working

Run these checks in order after starting everything.

### 3.1 — Kafka is receiving AIS messages

```powershell
docker exec kafka bash -lc "kafka-console-consumer --bootstrap-server kafka:9092 --topic ais.raw.positions --from-beginning --max-messages 3 --timeout-ms 20000"
```

Expected: 3 JSON blobs printed, each containing `MetaData` and
`Message.PositionReport` fields. If this times out, check the ingestion-producer
logs (see section 4).

---

### 3.2 — Stream job 1: Redis has live vessel positions

```powershell
docker exec redis redis-cli KEYS "vessel:*"
```

Expected: a list of keys like `vessel:123456789`. Should appear within 30 seconds
of Kafka receiving its first message.

Read one vessel's current state:

```powershell
docker exec redis redis-cli GET "vessel:240735100"
```

Expected: a JSON string with `mmsi`, `ship_name`, `latitude`, `longitude`, `speed`,
`heading`, `updated_at`.

Count active vessels:

```powershell
docker exec redis redis-cli DBSIZE
```

---

### 3.3 — Stream job 1: Cassandra is receiving trajectory records

```powershell
docker compose exec cassandra cqlsh -e "SELECT COUNT(*) FROM ais.vessel_positions;"
```

After loading the CSV this should be 243330. After the streaming jobs run for a
few minutes it should be higher.

Check that today's date is present in the partitions:

```powershell
docker compose exec cassandra cqlsh -e "SELECT DISTINCT mmsi, date FROM ais.vessel_positions LIMIT 20;"
```

---

### 3.4 — Stream job 2: MongoDB has zone stats

```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "printjson(db.getSiblingDB('ais_db').zone_stats.find({},{_id:0}).toArray())"
```

Expected: documents like:
```json
{ "zone": "adriatic", "avg_speed": 5.2, "vessel_count": 14, "timestamp": "2026-..." }
```

One document per Mediterranean zone that has active traffic. Updates every
10 seconds while the stream is running.

---

### 3.5 — Stream job 3: MongoDB has anomaly alerts

```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "printjson(db.getSiblingDB('ais_db').alerts.find({},{_id:0}).sort({timestamp:-1}).limit(5).toArray())"
```

Expected: documents with `type: "vessel_stopped_at_sea"` or `type: "abnormal_speed"`,
`severity`, `mmsi`, `ship_name`, `latitude`, `longitude`. May be empty for the
first few minutes while the stream processes its initial batches. The
`vessel_stopped_at_sea` type is the most common and does not require vessel profiles.

---

### 3.6 — Backend API is responding

Health check:

```powershell
Invoke-WebRequest http://localhost:8000/api/health | Select-Object -Expand Content
```

Expected:
```json
{"status":"ok","timestamp":"2026-..."}
```

Live vessels endpoint:

```powershell
Invoke-WebRequest http://localhost:8000/api/live/vessels | Select-Object -Expand Content
```

Expected: `{"timestamp":"...","total_ships":N,"average_speed":X.X,"data":[...]}`

Full interactive API docs: http://localhost:8000/docs

---

### 3.7 — Frontend map is showing vessels

Open http://localhost:5173.

- The topbar should show `Feed: Live` (green) and a vessel count > 0.
- Ship icons should appear on the Mediterranean map.
- Clicking a ship opens the vessel detail panel.
- The sidebar "Recent alerts" panel should show alerts within a few minutes.

---

## Part 4 — Run the batch jobs manually

The batch jobs run automatically every night at 02:00–02:45 via the scheduler.
For testing, run them manually now against the CSV data (2026-04-30 has the most
records).

All commands run inside the spark-master container.

### 4.1 — Job D: Vessel behavioral profiles (run first)

Job 3 (anomaly detection) depends on these profiles. Run this before the others.

```powershell
docker exec -e BATCH_DATE=2026-04-30 spark-master bash -lc "
  spark-submit \
  --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
  --conf spark.jars.ivy=/tmp/.ivy2 \
  --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs \
  /opt/spark-jobs/batch/batch_job_d_vessel_profiles.py
"
```

Expected final lines:
```
[Job D] Computed profiles for N vessels
[Job D] Written N new + 0 updated profiles
[Job D] Done.
```

Verify:
```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "printjson(db.getSiblingDB('ais_db').vessel_profiles.findOne({},{_id:0}))"
```

Expected: a document with `mmsi`, `avg_speed`, `speed_std_dev`, `max_speed`,
`observation_count`.

---

### 4.2 — Job A: Route segments

```powershell
docker exec -e BATCH_DATE=2026-04-30 spark-master bash -lc "
  spark-submit \
  --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
  --conf spark.jars.ivy=/tmp/.ivy2 \
  --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs \
  /opt/spark-jobs/batch/batch_job_a_routes.py
"
```

Expected:
```
[Job A] Written N new + 0 updated route segments
[Job A] Done.
```

Verify:
```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "db.getSiblingDB('ais_db').route_segments.countDocuments()"
```

---

### 4.3 — Job B: Zone traffic

```powershell
docker exec -e BATCH_DATE=2026-04-30 spark-master bash -lc "
  spark-submit \
  --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
  --conf spark.jars.ivy=/tmp/.ivy2 \
  --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs \
  /opt/spark-jobs/batch/batch_job_b_zone_traffic.py
"
```

Expected:
```
[Job B] Hourly: N new + 0 updated
[Job B] Daily: N new + 0 updated
[Job B] Done.
```

Verify zone names are real Mediterranean zones (not just "other"):
```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "printjson(db.getSiblingDB('ais_db').zone_traffic_daily.find({},{_id:0,zone:1,vessel_count:1}).sort({vessel_count:-1}).toArray())"
```

Expected zones: `adriatic`, `aegean`, `eastern_med`, `balearic_tyrrhenian`, etc.

---

### 4.4 — Job C: Heatmap

```powershell
docker exec -e BATCH_DATE=2026-04-30 spark-master bash -lc "
  spark-submit \
  --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
  --conf spark.jars.ivy=/tmp/.ivy2 \
  --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs \
  /opt/spark-jobs/batch/batch_job_c_heatmap.py
"
```

Expected:
```
[Job C] p5: N non-empty cells
[Job C] p6: N non-empty cells
[Job C] Done.
```

Verify the top-intensity cells are near ports (lat/lon should point to coastal
Mediterranean areas):
```powershell
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "printjson(db.getSiblingDB('ais_db').heatmap_tiles_p5.find({},{_id:0,lat:1,lon:1,intensity:1,vessels:1}).sort({intensity:-1}).limit(5).toArray())"
```

---

### 4.5 — Run all three dates at once

```powershell
foreach ($date in @("2026-04-28","2026-04-29","2026-04-30")) {
    docker exec -e BATCH_DATE=$date spark-master bash -lc "
      spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_d_vessel_profiles.py &&
      spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_a_routes.py &&
      spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_b_zone_traffic.py &&
      spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_c_heatmap.py
    "
}
```

---

## Part 5 — Verify the frontend with real data

After the batch jobs complete, the following features should be populated:

**Heatmap layer:**  
Toggle "Heatmap layer" in the left sidebar. A heat overlay should appear on the
map showing vessel density across the Mediterranean. High-intensity areas will be
near major ports (Barcelona, Marseille, Genoa, Piraeus, Istanbul, Alexandria).

**Route flows layer:**  
Toggle "Route flows" in the left sidebar. Directional arcs should appear connecting
geohash cells that vessels frequently transit between.

**Traffic Insights page:**  
Click "Traffic insights" in the topbar. The page shows zone traffic charts and
daily statistics from the batch jobs.

**Vessel detail:**  
Click any ship icon on the map. A panel opens showing the vessel's recent
trajectory (pulled from Cassandra) as a trail on the map.

**Alerts panel:**  
The sidebar shows recent anomaly alerts. These come from stream job 3 and appear
in real time as the live stream runs.

---

## Part 6 — Reading logs

When something doesn't work, check the logs of the relevant service.

```powershell
# Live AIS ingestion
docker compose --profile full logs -f ingestion-producer

# Stream job 1 (Redis + Cassandra writes)
docker compose --profile full logs -f stream-job1

# Stream job 2 (zone stats)
docker compose --profile full logs -f stream-job2

# Stream job 3 (anomaly detection)
docker compose --profile full logs -f stream-job3

# FastAPI backend
docker compose --profile full logs -f backend

# All services together
docker compose --profile full logs -f
```

---

## Part 7 — Common problems

**Cassandra healthcheck fails / stream-job1 won't start**  
Cassandra takes 90+ seconds on first boot. Run `docker compose ps cassandra` and
wait until STATUS shows `healthy`. Do not restart containers while it is starting.

**Stream jobs exit immediately after "Downloading JARs"**  
The first Maven JAR download can fail if your network has a timeout. Run:
```powershell
docker compose --profile full restart stream-job1
```
The cached JARs will be reused if the download completed partially.

**`Authentication failed` errors in stream job logs**  
Your `MONGO_PASSWORD` in `.env` contains special characters that Docker is not
escaping correctly. Wrap the password in single quotes in `.env`:
```
MONGO_PASSWORD='my$password!'
```

**Ingestion producer logs show "Subscribed" but no messages arrive**  
The AISStream API key is invalid or the bounding box has no traffic. Verify your
key at https://aisstream.io. The default bounding box covers the full Mediterranean
and always has traffic during daylight hours.

**`ModuleNotFoundError: No module named 'shared'` in batch job logs**  
The `shared/` volume is not mounted. This is fixed in the current `docker-compose.yml`.
If you see this, run:
```powershell
docker compose --profile full down
docker compose --profile full up -d --build
```

**Batch job exits with `No data for this date`**  
The `BATCH_DATE` date has no records in Cassandra. Use one of the three dates from
the CSV: `2026-04-28`, `2026-04-29`, or `2026-04-30`.

**Frontend shows "Feed: Offline"**  
The backend container is not running or is still starting. Check:
```powershell
docker compose --profile full logs backend
```
It should print `Uvicorn running on http://0.0.0.0:8000`.

---

## Part 8 — Service endpoints reference

| Service | URL | Purpose |
|---|---|---|
| Frontend | http://localhost:5173 | OceanWatch live dashboard |
| Backend API | http://localhost:8000 | REST + WebSocket |
| API docs (Swagger) | http://localhost:8000/docs | Interactive endpoint explorer |
| Spark Master UI | http://localhost:8080 | Running Spark jobs and workers |
| Redis | localhost:16379 | Live vessel state cache |
| Cassandra | localhost:9042 | Trajectory time-series |
| MongoDB | localhost:27017 | Analytics and alerts |
| Kafka external | localhost:9094 | Consume topics from host machine |

---

## Part 9 — Stop and clean up

**Stop everything but keep all data:**
```powershell
docker compose --profile full down
```

**Stop everything and delete all stored data (full reset):**
```powershell
docker compose --profile full down -v
```

After a full reset you must repeat the steps in Part 1 (schema, MongoDB init,
CSV load) before the system has any data again.

---

## Quick reference — full startup sequence

```powershell
# 1. Create env file and fill in credentials
Copy-Item .env.example .env

# 2. Start databases
docker compose up -d kafka cassandra redis mongodb

# 3. Wait for Cassandra to be healthy, then apply schema
$id = (docker compose ps -q cassandra).Trim()
docker cp config\cassandra_schema.cql ${id}:/tmp/schema.cql
docker compose exec cassandra cqlsh -f /tmp/schema.cql

# 4. Initialize MongoDB
$id = (docker compose ps -q mongodb).Trim()
docker cp scripts\init_mongo.js ${id}:/tmp/init_mongo.js
docker compose exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin /tmp/init_mongo.js

# 5. Load historical data
$id = (docker compose ps -q cassandra).Trim()
docker cp cassandra_vessel_positions_all.csv ${id}:/tmp/vessel_positions.csv
docker compose exec cassandra cqlsh -e "COPY ais.vessel_positions (mmsi, date, recorded_at, ship_name, latitude, longitude, speed, course, heading, nav_status) FROM '/tmp/vessel_positions.csv' WITH HEADER=TRUE AND DATETIMEFORMAT='%Y-%m-%dT%H:%M:%S.%fZ' AND NUMPROCESSES=4;"

# 6. Start all application services
docker compose --profile full up -d --build

# 7. Start frontend dev server
cd frontend && npm install && npm run dev

# 8. Run batch jobs on all three CSV dates
foreach ($d in @("2026-04-28","2026-04-29","2026-04-30")) {
    docker exec -e BATCH_DATE=$d spark-master bash -lc "spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_d_vessel_profiles.py"
    docker exec -e BATCH_DATE=$d spark-master bash -lc "spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_b_zone_traffic.py"
    docker exec -e BATCH_DATE=$d spark-master bash -lc "spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_c_heatmap.py"
    docker exec -e BATCH_DATE=$d spark-master bash -lc "spark-submit --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 --conf spark.jars.ivy=/tmp/.ivy2 --conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs /opt/spark-jobs/batch/batch_job_a_routes.py"
}

# 9. Open the dashboard
# http://localhost:5173
```
