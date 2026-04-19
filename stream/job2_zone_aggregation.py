import os
import sys
from pyspark.sql.functions import (
    col, current_timestamp, avg, count, window, udf
)
from pyspark.sql.types import (
    StringType
)
from pymongo import MongoClient

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

try:
    from shared.zones import get_zone
except ModuleNotFoundError:
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))
    from shared.zones import get_zone

env = load_stream_env(default_starting_offsets="latest")
KAFKA_BROKER = env["kafka_broker"]
MONGO_URI = env["mongo_uri"]
mongo_client = MongoClient(MONGO_URI)

get_zone_udf = udf(get_zone, StringType())

# ── Spark session ──────────────────────────────
spark = build_stream_spark_session("AIS_Job2_ZoneAnalytics")

spark.sparkContext.setLogLevel("WARN")

# ── Read from Kafka ────────────────────────────
raw = read_ais_kafka_stream(
    spark,
    KAFKA_BROKER,
    starting_offsets="latest",
)

# ── Parse JSON ─────────────────────────────────
parsed = parse_ais_payload(raw).select(
    col("d.MetaData.MMSI").alias("mmsi"),
    col("d.MetaData.latitude").alias("latitude"),
    col("d.MetaData.longitude").alias("longitude"),
    col("d.Message.PositionReport.Sog").alias("speed"),
    current_timestamp().alias("recorded_at")
).filter(col("mmsi").isNotNull())

# ── Add zone column ────────────────────────────
parsed_with_zone = parsed.withColumn("zone", get_zone_udf(col("latitude"), col("longitude")))

# ── Zone aggregations ──────────────────────────
zone_stats = parsed_with_zone.groupBy(
    window(col("recorded_at"), "10 seconds"),
    col("zone")
).agg(
    avg("speed").alias("avg_speed"),
    count("mmsi").alias("vessel_count")
).filter(col("zone") != "unknown")

# ── Write to MongoDB ───────────────────────────
def write_to_mongodb(batch_df, batch_id):
    if batch_df.isEmpty():
        return
    db = mongo_client.ais_db
    rows = batch_df.collect()
    for row in rows:
        doc = {
            "zone":         row.zone,
            "window_start": str(row.window.start),
            "window_end":   str(row.window.end),
            "avg_speed":    float(row.avg_speed) if row.avg_speed else 0,
            "vessel_count": int(row.vessel_count),
            "timestamp":    str(row.window.end)
        }
        db.zone_stats.update_one(
            {"zone": row.zone, "window_start": str(row.window.start)},  # match key
            {"$set": doc},
            upsert=True
        )
    print(f"[Zone Stats] Batch {batch_id}: wrote {len(rows)} records")

query = zone_stats.writeStream \
    .foreachBatch(write_to_mongodb) \
    .outputMode("update") \
    .option("checkpointLocation", "/tmp/checkpoints/job2_zones") \
    .trigger(processingTime="10 seconds") \
    .start()

print("Job 2 running — Zone analytics flowing to MongoDB...")
query.awaitTermination()