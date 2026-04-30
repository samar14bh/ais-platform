# AIS Platform - Maritime Analytics Stack

End-to-end maritime analytics platform for collecting AIS vessel data, processing it in streaming and batch pipelines, serving analytics-ready datasets, and visualizing real-time vessel tracking and analytics dashboards.

The project ingests live AIS messages from AISStream, publishes them to Kafka, processes them with Spark jobs, stores outputs in Redis/Cassandra/MongoDB, and exposes them via a FastAPI backend with a React frontend for interactive visualization.

## What This Project Does

### Data Ingestion
- **AISStream Producer**: Pulls live AIS messages from AISStream WebSocket and publishes to Kafka topic `ais.raw.positions`.

### Real-Time Streaming Analytics (Spark)
- **Job 1 (Positions)**: Latest vessel position cache in Redis + trajectory history in Cassandra.
  - Redis: Active vessel index (`vessel:active` sorted-set) for O(log n) discovery
  - Cassandra: Partitioned vessel_positions table for full history queries
- **Job 2 (Zone Traffic)**: Zone-based real-time traffic aggregation in MongoDB collection `zone_stats`.
- **Job 3 (Anomaly Detection)**: Real-time alerts for unusual patterns written to MongoDB collection `alerts`.

### Batch Analytics (Spark)
- **Job A (Route Extraction)**: Route segment extraction using geohash transitions → `route_segments` collection
- **Job B (Zone Traffic Stats)**: Hourly and daily zone traffic statistics → `zone_traffic_hourly`, `zone_traffic_daily` collections
- **Job C (Heatmap Tiles)**: Heatmap grid tiles at multiple geohash precisions → `heatmap_tiles_p5`, `heatmap_tiles_p6` collections

### Backend API (FastAPI)
- **REST Endpoints**:
  - `GET /api/live/vessels` - Active vessel snapshots from Redis
  - `GET /api/alerts` - Recent anomaly alerts from MongoDB
  - `GET /api/zone-traffic/{period}` - Zone traffic aggregations
  - `GET /api/heatmap` - Activity heatmap tiles
  - `GET /api/routes` - Common route segments
  - `GET /api/vessels/{mmsi}/trajectory` - Full vessel trajectory history from Cassandra
- **WebSocket Endpoint**:
  - `WS /ws/live-traffic` - Continuous 1-second push of active vessel snapshots for live map updates

### Frontend UI (React + TypeScript + Leaflet)
- **Live Map**: Interactive Leaflet map with real-time vessel markers, position updates via WebSocket
- **Heatmap Layer**: Activity intensity visualization with color-coded circles
- **Route Flow Layer**: Common shipping routes with weighted polylines
- **Zone Traffic Chart**: Time-series analysis of vessel counts and average speeds
- **Vessel Detail Panel**: Single vessel stats, trajectory history, and speed trends
- **Alerts Sidebar**: Real-time anomaly notifications with severity badges
- **Vessel Tracker**: Searchable list of active vessels with click-to-detail interaction

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Ingestion** | Python 3.11, WebSocket, Kafka |
| **Streaming** | Apache Spark 3.5, PySpark Structured Streaming |
| **Databases** | Cassandra, MongoDB, Redis |
| **Storage** | MinIO (S3-compatible) |
| **Backend API** | FastAPI, Uvicorn, WebSockets |
| **Frontend** | React 19, TypeScript 6, Vite, Leaflet 1.9, Recharts 2.12 |
| **Orchestration** | Docker Compose v2 |

## Repository Layout

```
project/
├── ingestion/                # AISStream → Kafka producer service
│   ├── aisstream_producer.py
│   └── __init__.py
├── stream/                   # Spark structured streaming jobs
│   ├── job1_positions.py     # Position cache + trajectory history
│   ├── job2_zone_aggregation.py  # Zone traffic aggregation
│   ├── job3_anomalie_detection.py # Real-time alerts
│   ├── schema.py             # Data schemas
│   └── stream_utils.py       # Shared utilities
├── batch/                    # Spark batch analytics jobs
│   ├── batch_job_a_routes.py # Route segment extraction
│   ├── batch_job_b_zone_traffic.py # Zone traffic stats
│   ├── batch_job_c_heatmap.py # Heatmap tile generation
│   ├── batch_utils.py        # Shared utilities
│   └── crontab               # Batch job schedule
├── backend/                  # FastAPI REST + WebSocket server
│   ├── main.py               # API endpoints and WebSocket
│   └── requirements.txt       # Python dependencies
├── frontend/                 # React analytics UI
│   ├── src/
│   │   ├── App.tsx           # Main application shell
│   │   ├── components/       # Reusable UI components
│   │   ├── api.ts            # Backend data contracts
│   │   └── types.ts          # Shared TypeScript interfaces
│   ├── package.json          # Node.js dependencies
│   └── vite.config.ts        # Vite build configuration
├── shared/                   # Cross-cutting shared logic
│   └── zones.py              # Zone mapping utilities
├── config/                   # Infrastructure configuration
│   └── cassandra_schema.cql  # Cassandra schema definition
├── docker/                   # Container images
│   ├── ingestion/Dockerfile
│   └── spark/Dockerfile
└── docker-compose.yml        # Multi-container orchestration
```

## Data Flow Architecture

```
┌──────────────────┐
│   AISStream      │  Live AIS messages
│   (External)     │
└────────┬─────────┘
         │ WebSocket
         ▼
┌──────────────────┐
│  AISStream       │  Parse, filter, publish
│  Producer       │  to Kafka
└────────┬─────────┘
         │ JSON
         ▼
┌──────────────────┐
│    Kafka Topic   │  ais.raw.positions
│  ais.raw.pos*   │
└────────┬─────────┘
         │
    ┌────┴─────┬──────────┐
    │           │          │
    ▼           ▼          ▼
┌─────────┐ ┌──────────┐ ┌────────────┐
│ Job 1   │ │ Job 2    │ │ Job 3      │
│Position │ │ Zone     │ │ Anomaly    │
│ Cache   │ │ Traffic  │ │ Detection  │
└────┬────┘ └────┬─────┘ └────┬───────┘
     │           │            │
   ┌─┴─────┬─────┴─┐          │
   │       │       │          │
   ▼       ▼       ▼          ▼
┌────────────────────────────────────┐
│ Data Warehouse (MongoDB, Redis)    │
├────────────────────────────────────┤
│ • Redis: vessel:{mmsi} (TTL)       │
│ • Redis: vessel:active (sorted-set)│
│ • Cassandra: vessel_positions      │
│ • MongoDB: zone_stats              │
│ • MongoDB: alerts                  │
└────────┬───────────────────────────┘
         │
         ▼
┌──────────────────────┐
│  FastAPI Backend     │
│  (REST + WebSocket)  │
└─────────┬────────────┘
          │
    ┌─────┴──────────┐
    │                │
    ▼                ▼
┌──────────────┐ ┌────────────────┐
│ REST Routes  │ │ WebSocket Live │
│ Analytics    │ │ Vessel Feed    │
└──────────────┘ └────────────────┘
          │                │
          └────────┬───────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  React Frontend      │
        │  (Analytics UI)      │
        ├──────────────────────┤
        │ • Live Map           │
        │ • Heatmap Overlay    │
        │ • Route Flows        │
        │ • Zone Charts        │
        │ • Vessel Details     │
        │ • Alerts Panel       │
        └──────────────────────┘
```

## Prerequisites

- **Docker Desktop** with Compose v2 (`docker compose` command)
- **Node.js 18+** (for frontend development)
- **AISStream API key** (sign up at https://www.aisstream.io/)
- **RAM**: Minimum 8GB available for Docker containers
- **Disk Space**: Minimum 20GB for database volumes

## Quick Start

### 1. Clone and Setup

```bash
git clone <repo>
cd <project>
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` and provide:

```bash
# Required credentials
MONGO_USER=admin
MONGO_PASSWORD=your_secure_password
MINIO_USER=minioadmin
MINIO_PASSWORD=your_secure_password
AISSTREAM_API_KEY=your_aisstream_api_key_here

# Optional: customize service hosts if needed
CASSANDRA_HOST=cassandra
REDIS_HOST=redis
KAFKA_BROKER=kafka:9092
```

### 3. Start Full Stack

```bash
# Build and start all services (ingestion, streaming, batch, backend, frontend)
docker compose --profile full up -d --build

# Wait 30-60 seconds for services to initialize...

# Check status
docker compose --profile full ps

# Follow logs
docker compose --profile full logs -f
```

### 4. Access Services

- **Frontend**: http://localhost:5173 (React dev server with Vite)
- **Backend API**: http://localhost:8000 (FastAPI)
- **API Documentation**: http://localhost:8000/docs (Swagger UI)
- **MinIO Console**: http://localhost:9001 (object storage, default: minioadmin/minioadmin)

### 5. Verify Data Flow

1. **Check AIS Ingestion**:
   ```bash
   docker compose exec kafka kafka-console-consumer --bootstrap-server localhost:9092 \
     --topic ais.raw.positions --max-messages 5
   ```

2. **Monitor Streaming Jobs**:
   ```bash
   docker compose logs -f stream-job1
   docker compose logs -f stream-job2
   docker compose logs -f stream-job3
   ```

3. **Check Backend Endpoints**:
   ```bash
   # Get active vessels
   curl http://localhost:8000/api/live/vessels | jq .

   # Get alerts
   curl http://localhost:8000/api/alerts | jq .

   # Get zone traffic
   curl http://localhost:8000/api/zone-traffic/hourly | jq .
   ```

4. **Test WebSocket**:
   ```bash
   # Using wscat (npm install -g wscat)
   wscat -c ws://localhost:8000/ws/live-traffic
   ```

5. **View Frontend**:
   - Open http://localhost:5173 in browser
   - Live vessel markers should appear on map
   - Click vessels to see trajectory details
   - Toggle "Heatmap Layer" and "Route Flows" checkboxes in sidebar

## API Documentation

### REST Endpoints

#### GET /api/live/vessels
Returns all currently active vessels from Redis cache.

**Response:**
```json
[
  {
    "id": "123456789",
    "ship_name": "VESSEL_NAME",
    "type": "Cargo",
    "status": "Under Way",
    "latitude": 37.5,
    "longitude": 15.5,
    "speed": 12.5,
    "course": 180,
    "heading": 180,
    "timestamp": "2024-04-18T10:30:00Z"
  }
]
```

#### GET /api/alerts
Returns recent anomaly alerts from MongoDB.

**Query Parameters:**
- `limit` (default: 50): Maximum number of results

**Response:**
```json
[
  {
    "alert_id": "uuid",
    "mmsi": "123456789",
    "ship_name": "VESSEL_NAME",
    "type": "speed_anomaly",
    "severity": "HIGH",
    "description": "Unusual speed pattern detected",
    "timestamp": "2024-04-18T10:30:00Z"
  }
]
```

#### GET /api/zone-traffic/{period}
Returns traffic statistics aggregated by zone.

**Path Parameters:**
- `period`: "hourly" or "daily"

**Query Parameters:**
- `limit` (default: 50): Maximum results

**Response:**
```json
[
  {
    "zone": "ZONE_A",
    "hour": "2024-04-18T10",
    "vessel_count": 45,
    "avg_speed": 8.3,
    "message_count": 120,
    "peak_hour": "2024-04-18T10"
  }
]
```

#### GET /api/heatmap
Returns activity heatmap tiles (grid cells with traffic density).

**Query Parameters:**
- `date` (optional): Filter by date (YYYY-MM-DD)
- `precision` (default: 5): Geohash precision (5 or 6)
- `limit` (default: 5000): Maximum results

**Response:**
```json
[
  {
    "cell": "u2hp",
    "lat": 37.5,
    "lon": 15.5,
    "count": 120,
    "vessels": 15,
    "intensity": 0.85,
    "date": "2024-04-18"
  }
]
```

#### GET /api/routes
Returns common shipping route segments.

**Query Parameters:**
- `date` (optional): Filter by date
- `limit` (default: 1000): Maximum results

**Response:**
```json
[
  {
    "cell_from": "u2hp",
    "cell_to": "u2hq",
    "lat_from": 37.5,
    "lon_from": 15.5,
    "lat_to": 37.6,
    "lon_to": 15.6,
    "count": 50,
    "avg_speed": 8.2
  }
]
```

#### GET /api/vessels/{mmsi}/trajectory
Returns full trajectory history for a specific vessel.

**Path Parameters:**
- `mmsi`: Maritime Mobile Service Identity (vessel identifier)

**Query Parameters:**
- `date` (optional): Filter by date
- `limit` (default: 500): Maximum points returned

**Response:**
```json
[
  {
    "mmsi": "123456789",
    "ship_name": "VESSEL_NAME",
    "recorded_at": "2024-04-18T10:00:00Z",
    "latitude": 37.5,
    "longitude": 15.5,
    "speed": 12.5,
    "course": 180,
    "heading": 180,
    "nav_status": "Under Way"
  }
]
```

### WebSocket Endpoint

#### WS /ws/live-traffic
Establishes a WebSocket connection that continuously pushes vessel snapshots every 1 second.

**Message Format:**
```json
{
  "type": "vessel_update",
  "vessels": [
    {
      "id": "123456789",
      "ship_name": "VESSEL_NAME",
      "latitude": 37.5,
      "longitude": 15.5,
      "speed": 12.5,
      "course": 180,
      "status": "Under Way"
    }
  ]
}
```

## Frontend Configuration

### Development

```bash
cd frontend
npm install
npm run dev      # Start Vite dev server on http://localhost:5173
npm run build    # Production build
npm run lint     # TypeScript and ESLint checks
```

### Environment Variables

Create `frontend/.env.local`:

```
VITE_API_BASE_URL=http://localhost:8000
```

### Build Output

```
frontend/dist/
├── index.html        (45B gzipped)
├── assets/index.css  (8KB gzipped)
└── assets/index.js   (211KB gzipped)
```

## Deployment Scenarios

### Scenario 1: Full Stack (Development/Testing)

```bash
docker compose --profile full up -d --build
```

Starts: Kafka, Cassandra, MongoDB, Redis, MinIO, Ingestion, Spark Jobs 1-3, Batch Jobs A-C, Backend, Frontend

### Scenario 2: Streaming Only (Disable Batch)

```bash
# Remove batch profile; jobs won't run
docker compose --profile full down
docker compose up -d --build
```

Removes daily batch jobs but keeps streaming pipeline running.

### Scenario 3: Analytics Only (No Ingestion)

For testing analytics on pre-existing data in MongoDB/Cassandra:

```bash
docker compose up -d mongodb cassandra redis
# Load your data manually or from backup
docker compose up -d backend
# Frontend queries existing data only
```

## Troubleshooting

### Issue: WebSocket connection refused
**Solution**: Ensure backend is running and frontend VITE_API_BASE_URL matches backend host:port.

### Issue: No vessel markers on map
**Solution**: 
1. Check AISStream producer logs: `docker compose logs ingestion-producer`
2. Verify Kafka has data: `docker compose exec kafka kafka-console-consumer --bootstrap-server kafka:9092 --topic ais.raw.positions --max-messages 5`
3. Check backend logs: `docker compose logs backend`
4. Verify MongoDB/Redis have data: `docker compose exec mongo mongosh -u admin -p <pwd> --authenticationDatabase admin`

### Issue: Heatmap layer not showing
**Solution**: 
1. Verify Job C (heatmap) is running: `docker compose logs batch-job-c`
2. Check MongoDB for heatmap collections: `db.heatmap_tiles_p5.count()`
3. Refresh frontend (Ctrl+R) and toggle heatmap checkbox again

### Issue: Memory issues / OOM kills
**Solution**: Reduce Spark executor memory in docker-compose.yml:
```yaml
environment:
  - SPARK_EXECUTOR_MEMORY=2g
  - SPARK_DRIVER_MEMORY=2g
```

### Issue: Backend can't connect to Cassandra/MongoDB
**Solution**: 
1. Verify container names match environment variables
2. Check network: `docker network inspect <project>_default`
3. Verify credentials in .env match docker-compose.yml

## Performance Tuning

### Redis Active Vessel Index
Job 1 maintains `vessel:active` sorted-set for O(log n) discovery instead of O(n) keyspace scans.

### Cassandra Partitioning
- Partition key: `(mmsi, date)` - allows fast queries by vessel on specific dates
- Clustering: `recorded_at DESC` - most recent positions first

### MongoDB Indexes
Auto-created on zone_stats, alerts, route_segments for fast filtering.

### Frontend Optimization
- Lazy-load analytics components (ZoneTrafficChart, HeatmapToggle)
- Recharts chart memoization to prevent re-renders
- WebSocket 1-second batching instead of per-message updates

## Logs and Monitoring

### View Logs by Service

```bash
docker compose logs -f ingestion-producer      # AIS ingestion
docker compose logs -f stream-job1              # Positions → Redis/Cassandra
docker compose logs -f stream-job2              # Zone traffic aggregation
docker compose logs -f stream-job3              # Anomaly detection
docker compose logs -f batch-job-a              # Route extraction
docker compose logs -f batch-job-b              # Zone stats
docker compose logs -f batch-job-c              # Heatmap tiles
docker compose logs -f backend                  # FastAPI backend
docker compose logs -f frontend                 # React dev server
```

### Container Health Checks

```bash
docker compose ps                               # Show running containers and health status
docker inspect <container-id> | grep -A 10 Health
```

## Cleanup

### Stop Stack (Keep Data)
```bash
docker compose --profile full stop
```

### Stop and Remove Containers (Keep Volumes)
```bash
docker compose --profile full down
```

### Full Cleanup (Remove All Data)
```bash
docker compose --profile full down -v
```

## License

MIT

## Support

For issues or questions:
1. Check logs: `docker compose logs -f`
2. Review API docs: http://localhost:8000/docs
3. Check frontend browser console: Ctrl+Shift+K


## Initialize Cassandra Schema

Apply schema from config/cassandra_schema.cql:

docker exec -i $(docker ps -qf name=cassandra) cqlsh < config/cassandra_schema.cql

If you are on PowerShell and command substitution differs, run cqlsh interactively:

docker exec -it <cassandra_container_name> cqlsh

Then paste the contents of config/cassandra_schema.cql.

## Stream Jobs

- stream/job1_positions.py
	- Source: Kafka ais.raw.positions
	- Sinks: Redis vessel:<mmsi>, Cassandra ais.vessel_positions
	- Trigger: every 10 seconds

- stream/job2_zone_aggregation.py
	- Source: Kafka ais.raw.positions
	- Sink: MongoDB ais_db.zone_stats
	- Trigger: every 10 seconds

- stream/job3_anomalie_detection.py
	- Source: Kafka ais.raw.positions
	- Sink: MongoDB ais_db.alerts
	- Trigger: every 10 seconds

Shared stream logic is centralized in stream/stream_utils.py and stream/schema.py.

## Batch Jobs

- batch/batch_job_a_routes.py
	- Output: MongoDB ais_db.route_segments
- batch/batch_job_b_zone_traffic.py
	- Output: MongoDB ais_db.zone_traffic_hourly and ais_db.zone_traffic_daily
- batch/batch_job_c_heatmap.py
	- Output: MongoDB ais_db.heatmap_tiles_p5 and ais_db.heatmap_tiles_p6

Shared batch logic is centralized in batch/batch_utils.py.

Manual run example:

docker exec -it spark-master spark-submit /opt/spark-jobs/batch/batch_job_b_zone_traffic.py

## Scheduling

Batch schedule is defined in batch/crontab and used by service spark-batch-scheduler.

Current schedule:

- 02:00: Job A
- 02:15: Job B
- 02:30: Job C
- 02:45: Job D entry exists in crontab but corresponding file is not present in batch directory

If you do not have Job D, remove or comment that line in batch/crontab to avoid cron errors.

## Service Endpoints

- Kafka internal listener: kafka:9092
- Kafka external listener: localhost:9094
- Spark Master UI: http://localhost:8080
- MinIO API: http://localhost:9000
- MinIO Console: http://localhost:9001
- MongoDB: localhost:27017
- Cassandra: localhost:9042
- Redis: localhost:16379

## Development Notes

- Core dependency files:
	- requirements-ingestion.txt for ingestion image
	- requirements-spark.txt for spark image jobs
- The root requirements.txt exists but ingestion and spark images are built from their specialized requirement files.

## Troubleshooting

- Kafka connection errors in producer:
	- wait for Kafka healthcheck to pass, then restart ingestion-producer.
- Cassandra write failures in stream job 1:
	- ensure schema is applied and keyspace/table exist.
- Empty analytics outputs:
	- verify AISSTREAM_API_KEY and bounding box filters.
- Cron batch job errors for missing batch_job_d_vessel_profiles.py:
	- remove the Job D line from batch/crontab unless you add that script.

