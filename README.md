# AIS Platform Quickstart

This repo is easiest to use in two modes:

- Daily development: start only the shared infrastructure in Docker, run app code locally.
- Demo/full stack: start the producer and Spark jobs in Docker as well.

## Default mode

Start the shared services only:

```powershell
docker compose up -d
```

This starts:
- Kafka
- Cassandra
- MongoDB
- Redis
- MinIO

## Full stack mode

Start everything, including the ingestion producer and Spark jobs:

```powershell
docker compose --profile full up -d --build
```

This also starts:
- ingestion-producer
- spark-master
- spark-worker
- stream-job1
- stream-job2
- spark-batch-scheduler

## Local app development

If you want to debug the producer locally instead of in Docker:

```powershell
$env:KAFKA_BROKER="localhost:9092"
python -m ingestion.aisstream_producer
```

## Kafka topic setup

If the raw topic is missing:

```powershell
docker exec ais-platform-kafka-1 kafka-topics --bootstrap-server localhost:9092 --create --if-not-exists --topic ais.raw.positions --partitions 1 --replication-factor 1
```

## Useful checks

See messages in Kafka:

```powershell
docker exec -it ais-platform-kafka-1 kafka-console-consumer --bootstrap-server localhost:9092 --topic ais.raw.positions --max-messages 5
```

Check Cassandra rows:

```powershell
docker exec -it ais-platform-cassandra-1 cqlsh -e "SELECT COUNT(*) FROM ais.vessel_positions;"
```

## Batch job commands

Run Batch Job A:

```powershell
docker compose exec -e MONGO_USER=admin -e MONGO_PASSWORD=admin1234 spark-master bash -lc "mkdir -p /tmp/.ivy2/cache /tmp/.ivy2/jars && /opt/spark/bin/spark-submit --conf spark.jars.ivy=/tmp/.ivy2 --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 /opt/spark-jobs/batch/batch_job_a_routes.py"
```

Run Batch Job B:

```powershell
docker compose exec -e MONGO_USER=admin -e MONGO_PASSWORD=admin1234 spark-master bash -lc "mkdir -p /tmp/.ivy2/cache /tmp/.ivy2/jars && /opt/spark/bin/spark-submit --conf spark.jars.ivy=/tmp/.ivy2 --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 /opt/spark-jobs/batch/batch_job_b_zone_traffic.py"
```

Run Batch Job C:

```powershell
docker compose exec -e MONGO_USER=admin -e MONGO_PASSWORD=admin1234 spark-master bash -lc "mkdir -p /tmp/.ivy2/cache /tmp/.ivy2/jars && /opt/spark/bin/spark-submit --conf spark.jars.ivy=/tmp/.ivy2 --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 /opt/spark-jobs/batch/batch_job_c_heatmap.py"
```

Show Mongo results for Batch Job A:

```powershell
docker exec -it ais-platform-mongodb-1 mongosh -u admin -p admin1234 --authenticationDatabase admin --eval "db.getSiblingDB('ais_db').route_segments.find().limit(20).pretty()"
```

Show Mongo results for Batch Job B:

```powershell
docker exec -it ais-platform-mongodb-1 mongosh -u admin -p admin1234 --authenticationDatabase admin --eval "db.getSiblingDB('ais_db').zone_traffic_hourly.find().limit(20).pretty()"
```

Show Mongo results for Batch Job C:

```powershell
docker exec -it ais-platform-mongodb-1 mongosh -u admin -p admin1234 --authenticationDatabase admin --eval "db.getSiblingDB('ais_db').heatmap_tiles_p5.find().limit(20).pretty()"
```

## Stream zone aggregation

Start the zone aggregation job with a short command:

```powershell
docker compose --profile full up -d stream-job2
```

View its logs:

```powershell
docker compose logs -f stream-job2
```

## Notes

- `AISSTREAM_API_KEY` must be set in `.env`.
- The default bounding box is the Mediterranean.
- If you want to widen or narrow the AIS stream area, set `AIS_BOUNDING_BOXES_JSON` in `.env`.