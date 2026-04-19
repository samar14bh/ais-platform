import os
import traceback
from pyspark.sql.functions import (
    col, current_timestamp, to_date
)
import redis
import json

try:
    from stream.stream_utils import (
        load_stream_env,
        build_stream_spark_session,
        read_ais_kafka_stream,
        parse_ais_payload,
    )
except ModuleNotFoundError:
    from stream_utils import (
        load_stream_env,
        build_stream_spark_session,
        read_ais_kafka_stream,
        parse_ais_payload,
    )

env = load_stream_env(default_starting_offsets="earliest")
KAFKA_BROKER = env["kafka_broker"]
KAFKA_STARTING_OFFSETS = env["kafka_starting_offsets"]
MONGO_URI = env["mongo_uri"]
REDIS_HOST   = os.getenv("REDIS_HOST", "redis")
CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
CASSANDRA_PORT = os.getenv("CASSANDRA_PORT", "9042")

# ── Spark session ─────────────────────────────────
spark = build_stream_spark_session(
    "AIS_Job1_LivePositions",
    extra_packages=["com.datastax.spark:spark-cassandra-connector_2.12:3.5.0"],
    extra_configs={
        "spark.cassandra.connection.host": CASSANDRA_HOST,
        "spark.mongodb.write.connection.uri": MONGO_URI,
    },
)

spark.sparkContext.setLogLevel("WARN")

# ── Read from Kafka ───────────────────────────────
raw = read_ais_kafka_stream(
    spark,
    KAFKA_BROKER,
    starting_offsets=KAFKA_STARTING_OFFSETS,
    fail_on_data_loss=False,
)

# ── Parse JSON ────────────────────────────────────
parsed = parse_ais_payload(raw).select(
    col("d.MetaData.MMSI").alias("mmsi"),
    col("d.MetaData.ShipName").alias("ship_name"),
    col("d.MetaData.latitude").alias("latitude"),
    col("d.MetaData.longitude").alias("longitude"),
    col("d.Message.PositionReport.Sog").alias("speed"),
    col("d.Message.PositionReport.Cog").alias("course"),
    col("d.Message.PositionReport.TrueHeading").alias("heading"),
    col("d.Message.PositionReport.NavigationalStatus").alias("nav_status"),
    current_timestamp().alias("recorded_at")
).filter(col("mmsi").isNotNull())

# ── Sink 1: Redis (latest position per vessel) ────
redis_client = redis.Redis(host=REDIS_HOST, port=6379, decode_responses=True)

def write_to_redis(batch_df, batch_id):
    if batch_df.isEmpty():
        return
    rows = batch_df.collect()
    for row in rows:
        key = f"vessel:{row.mmsi}"
        value = json.dumps({
            "mmsi":       row.mmsi,
            "ship_name":  row.ship_name,
            "latitude":   row.latitude,
            "longitude":  row.longitude,
            "speed":      row.speed,
            "course":     row.course,
            "heading":    row.heading,
            "nav_status": row.nav_status,
            "updated_at": str(row.recorded_at)
        })
        # overwrite — Redis always holds latest position only
        redis_client.set(key, value, ex=300)  # expires after 5 min if no update
    print(f"[Redis] Batch {batch_id}: updated {len(rows)} vessels")


# ── Sink 2: Cassandra (full trajectory history) ───
def write_to_cassandra(batch_df, batch_id):
    if batch_df.isEmpty():
        return
    try:
        count = batch_df.count()
        batch_df = batch_df.withColumn("date", to_date(col("recorded_at")))
        batch_df.write \
            .format("org.apache.spark.sql.cassandra") \
            .option("spark.cassandra.connection.host", CASSANDRA_HOST) \
            .option("spark.cassandra.connection.port", CASSANDRA_PORT) \
            .option("keyspace", "ais") \
            .option("table", "vessel_positions") \
            .mode("append") \
            .save()
        print(f"[Cassandra] Batch {batch_id}: wrote {count} trajectory records")
    except Exception as e:
        print(f"[Cassandra] Batch {batch_id}: write failed: {e}")
        print(traceback.format_exc())


# ── Start both streams ────────────────────────────
q1 = parsed.writeStream \
    .foreachBatch(write_to_redis) \
    .option("checkpointLocation", "/tmp/checkpoints/redis_v2") \
    .trigger(processingTime="10 seconds") \
    .start()

q2 = parsed.writeStream \
    .foreachBatch(write_to_cassandra) \
    .option("checkpointLocation", "/tmp/checkpoints/cassandra_v2") \
    .trigger(processingTime="10 seconds") \
    .start()

print("Job 1 running — positions flowing to Redis and Cassandra...")
spark.streams.awaitAnyTermination()