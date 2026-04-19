# AIS Platform

End-to-end maritime analytics platform for collecting AIS vessel data, processing it in streaming and batch pipelines, and serving analytics-ready datasets.

The project ingests live AIS messages from AISStream, publishes them to Kafka, processes them with Spark jobs, and writes outputs to Redis, Cassandra, and MongoDB.

## What This Project Does

- Ingestion: pulls live AIS messages from AISStream WebSocket and publishes to Kafka topic ais.raw.positions.
- Streaming analytics:
	- Job 1: latest vessel position cache in Redis + trajectory history in Cassandra.
	- Job 2: zone-based real-time traffic aggregation in MongoDB.
	- Job 3: anomaly detection in MongoDB.
- Batch analytics:
	- Job A: route segment extraction using geohash transitions.
	- Job B: hourly and daily zone traffic statistics.
	- Job C: heatmap grid tiles at multiple geohash precisions.

## Tech Stack

- Python 3.11
- Apache Spark 3.5
- Kafka (Confluent image)
- Cassandra
- MongoDB
- Redis
- MinIO
- Docker Compose

## Repository Layout

- ingestion: AISStream producer service.
- stream: Spark structured streaming jobs and shared stream utilities.
- batch: daily Spark batch jobs, cron schedule, and shared batch utilities.
- shared: cross-cutting shared logic (for example zone mapping).
- config: infrastructure configuration including Cassandra schema.
- docker: Dockerfiles for ingestion and spark images.
- frontend: reserved for UI/API consumer apps.

## Data Flow

1. AISStream producer reads live vessel updates and publishes raw JSON to Kafka topic ais.raw.positions.
2. Stream Job 1 consumes Kafka and writes:
	 - Redis keys vessel:<mmsi> for latest position
	 - Cassandra table ais.vessel_positions for full trajectory history
3. Stream Job 2 consumes Kafka, maps positions to Mediterranean zones, and writes rolling zone stats to MongoDB collection zone_stats.
4. Stream Job 3 consumes Kafka and writes anomaly alerts to MongoDB collection alerts.
5. Batch jobs read Cassandra ais.vessel_positions and write derived analytics to MongoDB collections:
	 - route_segments
	 - zone_traffic_hourly
	 - zone_traffic_daily
	 - heatmap_tiles_p5
	 - heatmap_tiles_p6

## Prerequisites

- Docker Desktop with Compose v2
- AISStream API key
- At least 8 GB RAM available for containers recommended

## Configuration

Create a .env file in project root with at least:

MINIO_USER=minio
MINIO_PASSWORD=minio123
MONGO_USER=admin
MONGO_PASSWORD=admin123
AISSTREAM_API_KEY=your_aisstream_api_key

Optional overrides:

- KAFKA_BROKER
- AIS_FILTER_MESSAGE_TYPES (default PositionReport)
- AIS_BOUNDING_BOXES_JSON (default Mediterranean box)
- BATCH_DATE for manual batch runs

## Run With Docker Compose

Start full stack:

docker compose --profile full up -d --build

Check status:

docker compose --profile full ps

Follow logs:

docker compose --profile full logs -f ingestion-producer
docker compose --profile full logs -f stream-job1
docker compose --profile full logs -f stream-job2

Stop stack:

docker compose --profile full down

Stop and remove volumes:

docker compose --profile full down -v

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

