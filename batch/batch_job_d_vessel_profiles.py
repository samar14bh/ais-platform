"""
Batch Job D — Vessel Behavioral Profiling
------------------------------------------
Reads vessel_positions from Cassandra for the target date, computes
per-vessel speed statistics, and upserts a behavioral profile into
MongoDB. These profiles are consumed by stream Job 3 (anomaly detection)
to distinguish normal from abnormal speed for each vessel type.

Output → MongoDB collection: vessel_profiles

Schema:
  {
    "mmsi":           int,
    "ship_name":      str,    # most recent name seen
    "avg_speed":      float,  # mean SOG (knots), excluding speed=0
    "speed_std_dev":  float,  # standard deviation of SOG
    "max_speed":      float,
    "observation_count": int, # number of position records used
    "last_seen_date": str,    # ISO date of most recent observation
    "updated_at":     str
  }

Run manually:
  docker exec spark-master spark-submit \
    --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
    /opt/spark-jobs/batch/batch_job_d_vessel_profiles.py
"""

import os
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pyspark.sql.functions import (
    col, avg, stddev, max as spark_max, count, last, lit, to_date
)

try:
    from batch.batch_utils import build_batch_spark_session, read_vessel_positions_for_date
except ModuleNotFoundError:
    from batch_utils import build_batch_spark_session, read_vessel_positions_for_date

load_dotenv()

# ── Config ────────────────────────────────────────────────
CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
MONGO_USER     = os.getenv("MONGO_USER", "admin")
MONGO_PASS     = os.getenv("MONGO_PASSWORD")
MONGO_URI      = f"mongodb://{MONGO_USER}:{MONGO_PASS}@mongodb:27017/?authSource=admin"

TARGET_DATE = os.getenv("BATCH_DATE", (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d"))

print(f"[Job D] Running for date: {TARGET_DATE}")

# ── Spark session ─────────────────────────────────────────
spark = build_batch_spark_session("AIS_Batch_D_VesselProfiles", CASSANDRA_HOST)

spark.sparkContext.setLogLevel("WARN")

# ── Read from Cassandra ───────────────────────────────────
# require_speed=True drops rows where speed is NULL (can't profile them)
df = read_vessel_positions_for_date(
    spark,
    TARGET_DATE,
    require_speed=True,
)

# Exclude speed=0: stationary readings would drag avg_speed to zero and
# produce useless profiles. Job 3 uses these profiles only for moving vessels.
df = df.filter(col("speed") > 0)

total = df.count()
print(f"[Job D] Rows after filtering: {total}")

if total == 0:
    print("[Job D] No data for this date. Exiting.")
    spark.stop()
    exit(0)

# ── Aggregate per vessel ──────────────────────────────────
profiles = df.groupBy("mmsi").agg(
    last("ship_name", ignorenulls=True).alias("ship_name"),
    avg("speed").alias("avg_speed"),
    stddev("speed").alias("speed_std_dev"),
    spark_max("speed").alias("max_speed"),
    count("speed").alias("observation_count"),
)

rows = profiles.collect()
print(f"[Job D] Computed profiles for {len(rows)} vessels")

# ── Write to MongoDB ──────────────────────────────────────
mongo_client = MongoClient(MONGO_URI)
db = mongo_client.ais_db
collection = db.vessel_profiles

ops = []
for row in rows:
    # stddev returns None when there is only one observation
    std = float(row.speed_std_dev) if row.speed_std_dev is not None else 0.0
    doc = {
        "mmsi":              int(row.mmsi),
        "ship_name":         row.ship_name or "",
        "avg_speed":         round(float(row.avg_speed), 2),
        "speed_std_dev":     round(std, 2),
        "max_speed":         round(float(row.max_speed), 2),
        "observation_count": int(row.observation_count),
        "last_seen_date":    TARGET_DATE,
        "updated_at":        datetime.now(timezone.utc).isoformat(),
    }
    ops.append(UpdateOne(
        {"mmsi": int(row.mmsi)},
        {"$set": doc},
        upsert=True
    ))

if ops:
    result = collection.bulk_write(ops)
    print(f"[Job D] Written {result.upserted_count} new + {result.modified_count} updated profiles")
else:
    print("[Job D] No profiles to write.")

# ── MongoDB indexes ───────────────────────────────────────
collection.create_index("mmsi", unique=True, background=True)
collection.create_index([("last_seen_date", -1)], background=True)

mongo_client.close()
spark.stop()
print("[Job D] Done.")
