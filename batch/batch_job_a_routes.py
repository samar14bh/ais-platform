"""
Reads vessel_positions from Cassandra, reconstructs per-vessel
trajectories, builds ordered (cell_from → cell_to) segments
snapped to a geohash grid, then counts how often each segment
appears across all vessels and time.

Output → MongoDB collection: route_segments
Schema:
  {
    "cell_from":   str,   # geohash precision-5 of segment start
    "cell_to":     str,   # geohash precision-5 of segment end
    "lat_from":    float, # center lat of cell_from
    "lon_from":    float, # center lon of cell_from
    "lat_to":      float, # center lat of cell_to
    "lon_to":      float, # center lon of cell_to
    "count":       int,   # how many vessel-segments crossed this pair
    "avg_speed":   float, # mean speed on this segment
    "window_date": str,   # ISO date this batch covers
    "updated_at":  str
  }

"""

import os
from datetime import datetime, timedelta, timezone

import geohash2  
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pyspark.sql.functions import (
    col, lag, udf
)
from pyspark.sql.types import StringType, DoubleType, StructType, StructField
from pyspark.sql.window import Window

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

# Process yesterday by default (pass DATE env to override)
TARGET_DATE = os.getenv("BATCH_DATE", (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d"))

GEOHASH_PRECISION = 5        # 5km × 5km cells 
MAX_SEGMENT_KM    = 200      # drop jumps longer than this (GPS noise / vessel off-grid)
NULL_ISLAND_DELTA = 0.001    

print(f"[Job A] Running for date: {TARGET_DATE}")

# ── Spark session ─────────────────────────────────────────
spark = build_batch_spark_session("AIS_Batch_A_Routes", CASSANDRA_HOST)

spark.sparkContext.setLogLevel("WARN")

def encode_geohash(lat, lon):
    if lat is None or lon is None:
        return None
    try:
        return geohash2.encode(lat, lon, precision=GEOHASH_PRECISION)
    except Exception:
        return None

def geohash_center(gh):
    """Return center lat, lon of a geohash cell as a struct."""
    if gh is None:
        return None
    try:
        lat, lon, _, _ = geohash2.decode_exactly(gh)
        return (float(lat), float(lon))
    except Exception:
        return None

center_schema = StructType([
    StructField("lat", DoubleType(), True),
    StructField("lon", DoubleType(), True),
])

encode_geohash_udf = udf(encode_geohash, StringType())
geohash_center_udf = udf(geohash_center, center_schema)

# ── Read from Cassandra 
# Filter to target date and drop noise
df = read_vessel_positions_for_date(
    spark,
    TARGET_DATE,
    null_island_delta=NULL_ISLAND_DELTA,
    enforce_global_bounds=True,
)

print(f"[Job A] Rows after filtering: {df.count()}")

# ── Add geohash cell per position 
df = df.withColumn("cell", encode_geohash_udf(col("latitude"), col("longitude")))

# ── Build consecutive segments per vessel 
w = Window.partitionBy("mmsi").orderBy("recorded_at")

segments = df \
    .withColumn("prev_cell", lag("cell").over(w)) \
    .withColumn("prev_lat",  lag("latitude").over(w)) \
    .withColumn("prev_lon",  lag("longitude").over(w)) \
    .filter(col("prev_cell").isNotNull()) \
    .filter(col("prev_cell") != col("cell"))  # skip stationary vessels

route_counts = segments.groupBy("prev_cell", "cell") \
    .agg(
        {"prev_cell": "count", "speed": "avg"}
    ) \
    .withColumnRenamed("count(prev_cell)", "count") \
    .withColumnRenamed("avg(speed)", "avg_speed") \
    .withColumnRenamed("prev_cell", "cell_from") \
    .withColumnRenamed("cell", "cell_to") \
    .filter(col("count") >= 2)   # skip one-off crossings

# Decode geohash centers for map rendering 
route_counts = route_counts \
    .withColumn("center_from", geohash_center_udf(col("cell_from"))) \
    .withColumn("center_to",   geohash_center_udf(col("cell_to"))) \
    .withColumn("lat_from", col("center_from.lat")) \
    .withColumn("lon_from", col("center_from.lon")) \
    .withColumn("lat_to",   col("center_to.lat")) \
    .withColumn("lon_to",   col("center_to.lon")) \
    .drop("center_from", "center_to")

# Write to MongoDB 
rows = route_counts.collect()

mongo_client = MongoClient(MONGO_URI)
db = mongo_client.ais_db
collection = db.route_segments

ops = []
for row in rows:
    doc = {
        "cell_from":   row.cell_from,
        "cell_to":     row.cell_to,
        "lat_from":    float(row.lat_from) if row.lat_from else None,
        "lon_from":    float(row.lon_from) if row.lon_from else None,
        "lat_to":      float(row.lat_to) if row.lat_to else None,
        "lon_to":      float(row.lon_to) if row.lon_to else None,
        "count":       int(row["count"]),
        "avg_speed":   round(float(row.avg_speed), 2) if row.avg_speed else None,
        "window_date": TARGET_DATE,
        "updated_at":  datetime.now(timezone.utc).isoformat(),
    }
    ops.append(UpdateOne(
        {"cell_from": row.cell_from, "cell_to": row.cell_to, "window_date": TARGET_DATE},
        {"$set": doc},
        upsert=True
    ))

if ops:
    result = collection.bulk_write(ops)
    print(f"[Job A] Written {result.upserted_count} new + {result.modified_count} updated route segments")
else:
    print("[Job A] No route segments to write.")

#  MongoDB index (idempotent) 
collection.create_index([("cell_from", 1), ("cell_to", 1), ("window_date", 1)], unique=True, background=True)
collection.create_index([("count", -1)], background=True)
collection.create_index([("window_date", 1)], background=True)

mongo_client.close()
spark.stop()
print("[Job A] Done.")
