"""
Stream Job 4 — Raw AIS Archival to HDFS
-----------------------------------------
Reads every AIS message from Kafka and archives it to HDFS as Parquet,
partitioned by year/month/day/hour.

Role in the architecture
------------------------
Jobs 1–3 serve the real-time and short-term analytics paths. Their outputs
have retention limits (Redis: 5 min TTL, Cassandra: 30 days TTL). Job 4 is
the permanent record — it writes everything to HDFS and nothing ever expires.

HDFS layout
-----------
  /ais/vessel_positions/
      year=2026/month=04/day=28/hour=13/
          part-00000-<uuid>.snappy.parquet
          ...
      year=2026/month=04/day=28/hour=14/
          ...

Batch jobs read from Cassandra for the current 30-day window (fast, hot path).
For dates older than the Cassandra TTL, batch_utils.read_vessel_positions_from_hdfs()
reads from the HDFS partitions above (cold path). Both return the same schema.

Design choices
--------------
- Raw Kafka `value` is parsed into columns rather than stored as a JSON blob.
  Storing structured Parquet is 5-10x smaller than raw JSON and lets Spark
  apply column pruning and predicate pushdown on future reads.
- 60-second trigger: archival is latency-insensitive. Longer batches mean
  fewer, larger Parquet files in HDFS — avoids the small-files problem that
  degrades NameNode memory and split planning on reads.
- Snappy compression: good compression ratio, splittable by Spark, fast enough
  for the write path. LZ4 would be faster but Snappy is the Parquet default
  and universally supported.
- coalesce(1) per partition: with a single DataNode, writing multiple part
  files per partition provides no parallelism benefit and creates unnecessary
  NameNode metadata. coalesce(1) keeps one file per (date, hour) partition.
- checkpointLocation on HDFS: survives container restarts; Spark resumes from
  the last committed Kafka offset rather than replaying from the beginning.
"""

import os

from pyspark.sql.functions import (
    col, to_timestamp, coalesce, current_timestamp,
    year, month, dayofmonth, hour,
)

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
KAFKA_BROKER          = env["kafka_broker"]
HDFS_URI              = env["hdfs_uri"]

HDFS_OUTPUT_PATH      = f"{HDFS_URI}/ais/vessel_positions"
CHECKPOINT_PATH       = f"{HDFS_URI}/ais/checkpoints/job4_hdfs_archive"

# ── Spark session ──────────────────────────────────────────────────────────
spark = build_stream_spark_session("AIS_Job4_HDFSArchive")
spark.sparkContext.setLogLevel("WARN")

# ── Read from Kafka ────────────────────────────────────────────────────────
# fail_on_data_loss=False: if a container was down and Kafka already trimmed
# old offsets, skip the lost messages and continue from what's available.
raw = read_ais_kafka_stream(
    spark,
    KAFKA_BROKER,
    starting_offsets="earliest",
    fail_on_data_loss=False,
)

# ── Parse into structured columns ──────────────────────────────────────────
# Use the vessel's own GPS timestamp (time_utc) as the event time so that
# partition paths reflect when the vessel sent the message, not when Spark
# processed it. This ensures re-runs and restarts land data in the correct
# year/month/day/hour partition.
parsed = parse_ais_payload(raw).select(
    col("d.MetaData.MMSI").alias("mmsi"),
    col("d.MetaData.ShipName").alias("ship_name"),
    col("d.MetaData.latitude").alias("latitude"),
    col("d.MetaData.longitude").alias("longitude"),
    col("d.Message.PositionReport.Sog").alias("speed"),
    col("d.Message.PositionReport.Cog").alias("course"),
    col("d.Message.PositionReport.TrueHeading").alias("heading"),
    col("d.Message.PositionReport.NavigationalStatus").alias("nav_status"),
    coalesce(
        to_timestamp(col("d.MetaData.time_utc")),
        current_timestamp(),
    ).alias("recorded_at"),
).filter(col("mmsi").isNotNull())

# ── Add partition columns derived from event time ──────────────────────────
# Hive-style partitioning (year=, month=, day=, hour=) is understood natively
# by Spark, Hive, Presto, and Trino. Partition pruning on reads is automatic.
partitioned = parsed \
    .withColumn("year",  year(col("recorded_at"))) \
    .withColumn("month", month(col("recorded_at"))) \
    .withColumn("day",   dayofmonth(col("recorded_at"))) \
    .withColumn("hour",  hour(col("recorded_at")))


# ── Write to HDFS ──────────────────────────────────────────────────────────
def write_to_hdfs(batch_df, batch_id):
    if batch_df.isEmpty():
        return

    count = batch_df.count()

    # coalesce(1) per partition key: with a single DataNode there is no
    # advantage to multiple part files, and fewer files means less NameNode
    # memory pressure and faster split planning on subsequent reads.
    batch_df \
        .coalesce(1) \
        .write \
        .mode("append") \
        .partitionBy("year", "month", "day", "hour") \
        .parquet(HDFS_OUTPUT_PATH)

    print(f"[HDFS Archive] Batch {batch_id}: wrote {count} rows to {HDFS_OUTPUT_PATH}")


query = partitioned.writeStream \
    .foreachBatch(write_to_hdfs) \
    .option("checkpointLocation", CHECKPOINT_PATH) \
    .trigger(processingTime="60 seconds") \
    .start()

print(f"Job 4 running — AIS stream archiving to HDFS at {HDFS_OUTPUT_PATH}")
query.awaitTermination()
