"""
Batch Job B — Zone Traffic Analysis by Region & Time Period
-----------------------------------------------------------
Reads vessel_positions from Cassandra, applies the same zone
boundaries as Job 2 (streaming), and aggregates traffic metrics
per zone per hour and per day.

This gives you the "étude du trafic par région géographique et
par période" — distinct vessel count, avg speed, busiest hours,
and day-over-day trends per Mediterranean zone.

Output → MongoDB collections:
  - zone_traffic_hourly  (per zone per hour)
  - zone_traffic_daily   (per zone per day — rolled up)

Hourly schema:
  {
    "zone":           str,
    "hour":           str,   # ISO datetime truncated to hour e.g. "2024-01-15T14:00:00"
    "date":           str,   # "2024-01-15"
    "vessel_count":   int,   # distinct MMSIs seen in this zone this hour
    "avg_speed":      float,
    "max_speed":      float,
    "message_count":  int,   # total AIS messages received
    "updated_at":     str
  }

Daily schema (same fields, aggregated over 24h):
  {
    "zone":           str,
    "date":           str,
    "vessel_count":   int,
    "avg_speed":      float,
    "peak_hour":      int,   # hour-of-day with most traffic (0-23)
    "peak_count":     int,
    "updated_at":     str
  }

Run manually:
  docker exec spark-master spark-submit \
    --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
    /opt/spark-jobs/batch/batch_job_b_zone_traffic.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pyspark.sql.functions import (
    avg, col, count, countDistinct, date_trunc, hour,
    max as spark_max, rank, to_date, udf,
)
from pyspark.sql.types import StringType
from pyspark.sql.window import Window

try:
    from batch.batch_utils import build_batch_spark_session, read_vessel_positions_for_date
except ModuleNotFoundError:
    from batch_utils import build_batch_spark_session, read_vessel_positions_for_date

load_dotenv()

# ── Config
CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
MONGO_USER     = os.getenv("MONGO_USER", "admin")
MONGO_PASS     = os.getenv("MONGO_PASSWORD")
MONGO_URI      = f"mongodb://{MONGO_USER}:{MONGO_PASS}@mongodb:27017/?authSource=admin"

TARGET_DATE = os.getenv("BATCH_DATE", (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d"))

print(f"[Job B] Running for date: {TARGET_DATE}")

# Inline zone logic — UDFs are cloudpickled and sent to executor worker
# processes that don't inherit the driver's sys.path.
def _get_zone_inline(lat, lon):
    if lat is None or lon is None:
        return "unknown"
    if 35.0 <= lat <= 42.0 and -6.0 <= lon <= 0.0:
        return "gibraltar"
    if 35.0 <= lat <= 40.0 and 0.0 <= lon <= 5.0:
        return "alboran"
    if 37.0 <= lat <= 44.0 and 5.0 <= lon <= 15.0:
        return "balearic_tyrrhenian"
    if 38.0 <= lat <= 46.0 and 12.0 <= lon <= 22.0:
        return "adriatic"
    if 30.0 <= lat <= 38.0 and 9.0 <= lon <= 16.0:
        return "central_med"
    if 35.0 <= lat <= 42.0 and 19.0 <= lon <= 30.0:
        return "aegean"
    if 30.0 <= lat <= 42.0 and 26.0 <= lon <= 37.0:
        return "eastern_med"
    if 30.0 <= lat <= 48.0 and 27.0 <= lon <= 42.0:
        return "black_sea"
    return "other"

get_zone_udf = udf(_get_zone_inline, StringType())

# ── Spark session 
spark = build_batch_spark_session("AIS_Batch_B_ZoneTraffic", CASSANDRA_HOST)

spark.sparkContext.setLogLevel("WARN")

#  Read from Cassandra
df = read_vessel_positions_for_date(
    spark,
    TARGET_DATE,
    require_speed=True,
)

#  Add zone and hour columns 
df = df \
    .withColumn("zone", get_zone_udf(col("latitude"), col("longitude"))) \
    .withColumn("hour_ts", date_trunc("hour", col("recorded_at"))) \
    .withColumn("hour_of_day", hour(col("recorded_at"))) \
    .filter(col("zone") != "unknown") \
    .cache()

#  Hourly aggregation 
hourly = df.groupBy("zone", "hour_ts").agg(
    countDistinct("mmsi").alias("vessel_count"),
    avg("speed").alias("avg_speed"),
    spark_max("speed").alias("max_speed"),
    count("mmsi").alias("message_count")
)

#  Daily aggregation 
daily = df.groupBy("zone", to_date(col("recorded_at")).alias("date")).agg(
    countDistinct("mmsi").alias("vessel_count"),
    avg("speed").alias("avg_speed"),
    spark_max("speed").alias("max_speed"),
    count("mmsi").alias("message_count")
)

# Peak hour per zone per day (hour_of_day with highest vessel count)
peak_hour_df = df.groupBy("zone", to_date(col("recorded_at")).alias("date"), "hour_of_day").agg(
    countDistinct("mmsi").alias("hcount")
)

# Find the peak hour per (zone, date)
w_peak = Window.partitionBy("zone", "date").orderBy(col("hcount").desc())
peak_hour_top = peak_hour_df \
    .withColumn("rnk", rank().over(w_peak)) \
    .filter(col("rnk") == 1) \
    .drop("rnk") \
    .withColumnRenamed("hcount", "peak_count") \
    .withColumnRenamed("hour_of_day", "peak_hour")

# Join peak hour into daily
daily = daily.join(peak_hour_top, on=["zone", "date"], how="left")

#  Write hourly to MongoDB 
mongo_client = MongoClient(MONGO_URI)
db = mongo_client.ais_db

hourly_rows = hourly.collect()
hourly_ops = []
for row in hourly_rows:
    hour_str = str(row.hour_ts)
    doc = {
        "zone":          row.zone,
        "hour":          hour_str,
        "date":          TARGET_DATE,
        "vessel_count":  int(row.vessel_count),
        "avg_speed":     round(float(row.avg_speed), 2) if row.avg_speed else 0.0,
        "max_speed":     round(float(row.max_speed), 2) if row.max_speed else 0.0,
        "message_count": int(row.message_count),
        "updated_at":    datetime.now(timezone.utc).isoformat(),
    }
    hourly_ops.append(UpdateOne(
        {"zone": row.zone, "hour": hour_str},
        {"$set": doc},
        upsert=True
    ))

if hourly_ops:
    res = db.zone_traffic_hourly.bulk_write(hourly_ops)
    print(f"[Job B] Hourly: {res.upserted_count} new + {res.modified_count} updated")

#  Write daily to MongoDB 
daily_rows = daily.collect()
daily_ops = []
for row in daily_rows:
    doc = {
        "zone":          row.zone,
        "date":          str(row.date),
        "vessel_count":  int(row.vessel_count),
        "avg_speed":     round(float(row.avg_speed), 2) if row.avg_speed else 0.0,
        "max_speed":     round(float(row.max_speed), 2) if row.max_speed else 0.0,
        "message_count": int(row.message_count),
        "peak_hour":     int(row.peak_hour) if row.peak_hour is not None else None,
        "peak_count":    int(row.peak_count) if row.peak_count is not None else None,
        "updated_at":    datetime.now(timezone.utc).isoformat(),
    }
    daily_ops.append(UpdateOne(
        {"zone": row.zone, "date": str(row.date)},
        {"$set": doc},
        upsert=True
    ))

if daily_ops:
    res = db.zone_traffic_daily.bulk_write(daily_ops)
    print(f"[Job B] Daily: {res.upserted_count} new + {res.modified_count} updated")

#  MongoDB indexes 
db.zone_traffic_hourly.create_index([("zone", 1), ("hour", 1)], unique=True, background=True)
db.zone_traffic_hourly.create_index([("date", 1)], background=True)
db.zone_traffic_daily.create_index([("zone", 1), ("date", 1)], unique=True, background=True)
db.zone_traffic_daily.create_index([("vessel_count", -1)], background=True)

df.unpersist()
mongo_client.close()
spark.stop()
print("[Job B] Done.")
