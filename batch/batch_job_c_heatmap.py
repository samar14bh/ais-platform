"""
Batch Job C — Maritime Activity Heatmap Grid Tiles
---------------------------------------------------
Reads vessel_positions from Cassandra, snaps every position to
a geohash grid cell (precision 5 ≈ 5km × 5km), counts AIS
messages and distinct vessels per cell, and normalises the
counts into a 0–1 intensity score for direct use by Leaflet
or deck.gl heatmap layers.

Also produces a higher-resolution grid (precision 6 ≈ 1km)
for zoomed-in views.

Output → MongoDB collections:
  - heatmap_tiles_p5  (precision-5 — overview/regional zoom)
  - heatmap_tiles_p6  (precision-6 — port/coastal detail zoom)

Schema (both collections):
  {
    "cell":        str,   # geohash string
    "lat":         float, # cell center latitude
    "lon":         float, # cell center longitude
    "count":       int,   # total AIS position messages in cell
    "vessels":     int,   # distinct MMSIs seen in cell
    "intensity":   float, # normalised 0.0–1.0 (log scale)
    "date":        str,   # "2024-01-15"
    "updated_at":  str
  }

Front-end usage example (Leaflet.heat):
  fetch('/api/heatmap?date=2024-01-15&precision=5')
    .then(r => r.json())
    .then(tiles => {
      const points = tiles.map(t => [t.lat, t.lon, t.intensity]);
      L.heatLayer(points, { radius: 25 }).addTo(map);
    });

Run manually:
  docker exec spark-master spark-submit \
    --packages com.datastax.spark:spark-cassandra-connector_2.12:3.5.0 \
    /opt/spark-jobs/batch/batch_job_c_heatmap.py
"""

import os
import math
from datetime import datetime, timedelta, timezone

import geohash2  # pip install geohash2
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pyspark.sql.functions import (
    col, udf, countDistinct, count
)
from pyspark.sql.types import StringType

try:
    from batch.batch_utils import build_batch_spark_session, read_vessel_positions_for_date
except ModuleNotFoundError:
    from batch_utils import build_batch_spark_session, read_vessel_positions_for_date

load_dotenv()

#  Config 
CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
MONGO_USER     = os.getenv("MONGO_USER", "admin")
MONGO_PASS     = os.getenv("MONGO_PASSWORD")
MONGO_URI      = f"mongodb://{MONGO_USER}:{MONGO_PASS}@mongodb:27017"

TARGET_DATE = os.getenv("BATCH_DATE", (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d"))

# Geohash precision levels to generate
PRECISIONS = {
    "p5": 5,   # ~5km cells — regional overview
    "p6": 6,   # ~1km cells — coastal/port detail
}

print(f"[Job C] Running for date: {TARGET_DATE}")

#  Spark session 
spark = build_batch_spark_session("AIS_Batch_C_Heatmap", CASSANDRA_HOST)

spark.sparkContext.setLogLevel("WARN")

# ── Read from Cassandra 
df = read_vessel_positions_for_date(
    spark,
    TARGET_DATE,
    enforce_global_bounds=True,
    select_columns=["mmsi", "latitude", "longitude"],
)

total = df.count()
print(f"[Job C] Total positions to process: {total}")

if total == 0:
    print("[Job C] No data for this date. Exiting.")
    spark.stop()
    exit(0)

# Cache since we'll use it twice (precision 5 and 6)
df.cache()

mongo_client = MongoClient(MONGO_URI)
db = mongo_client.ais_db

# ── Process each precision level 
for label, precision in PRECISIONS.items():
    print(f"[Job C] Processing precision {precision} ({label})...")

    # UDF scoped per precision (avoids closure capture issues)
    def make_geohash_udf(p):
        def encode(lat, lon):
            if lat is None or lon is None:
                return None
            try:
                return geohash2.encode(lat, lon, precision=p)
            except Exception:
                return None
        return udf(encode, StringType())

    geohash_udf = make_geohash_udf(precision)

    # Add cell column and aggregate
    tiled = df.withColumn("cell", geohash_udf(col("latitude"), col("longitude"))) \
              .filter(col("cell").isNotNull()) \
              .groupBy("cell") \
              .agg(
                  count("mmsi").alias("count"),
                  countDistinct("mmsi").alias("vessels")
              )

    rows = tiled.collect()
    print(f"[Job C] {label}: {len(rows)} non-empty cells")

    if not rows:
        continue

    #  Normalise intensity on log scale ─
    # log scale compresses the huge range between ports (10k msgs)
    # and open sea (2 msgs) into a useful 0–1 gradient.
    max_count = max(r["count"] for r in rows)
    log_max   = math.log1p(max_count)  # log1p = log(1 + x), safe at 0

    ops = []
    for row in rows:
        # Decode cell center for map rendering
        try:
            center_lat, center_lon, _, _ = geohash2.decode_exactly(row["cell"])
        except Exception:
            continue

        intensity = math.log1p(row["count"]) / log_max if log_max > 0 else 0.0

        doc = {
            "cell":       row["cell"],
            "lat":        round(float(center_lat), 6),
            "lon":        round(float(center_lon), 6),
            "count":      int(row["count"]),
            "vessels":    int(row["vessels"]),
            "intensity":  round(intensity, 4),
            "date":       TARGET_DATE,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        ops.append(UpdateOne(
            {"cell": row["cell"], "date": TARGET_DATE},
            {"$set": doc},
            upsert=True
        ))

    # Bulk write in batches of 1000 to avoid memory pressure
    collection_name = f"heatmap_tiles_{label}"
    collection = db[collection_name]
    batch_size = 1000
    total_upserted = 0
    total_modified = 0

    for i in range(0, len(ops), batch_size):
        batch = ops[i:i + batch_size]
        result = collection.bulk_write(batch)
        total_upserted += result.upserted_count
        total_modified  += result.modified_count

    print(f"[Job C] {label}: {total_upserted} new + {total_modified} updated tiles")

    # ── Indexes 
    collection.create_index([("cell", 1), ("date", 1)], unique=True, background=True)
    collection.create_index([("date", 1), ("intensity", -1)], background=True)
    # Geospatial index for bounding box queries from the API
    collection.create_index([("lat", 1), ("lon", 1)], background=True)

df.unpersist()
mongo_client.close()
spark.stop()
print("[Job C] Done.")
