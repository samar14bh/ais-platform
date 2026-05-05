from cachetools import TTLCache

from pyspark.sql.functions import (
    col, current_timestamp, udf
)
from pymongo import MongoClient
from datetime import datetime, timedelta
import hashlib

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

env = load_stream_env(default_starting_offsets="latest")
KAFKA_BROKER = env["kafka_broker"]
MONGO_URI = env["mongo_uri"]

# ── Spark session ──────────────────────────────
spark = build_stream_spark_session("AIS_Job3_Anomalies")

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
    col("d.MetaData.ShipName").alias("ship_name"),
    col("d.MetaData.latitude").alias("latitude"),
    col("d.MetaData.longitude").alias("longitude"),
    col("d.Message.PositionReport.Sog").alias("speed"),
    col("d.Message.PositionReport.NavigationalStatus").alias("nav_status"),  # added
    current_timestamp().alias("recorded_at")
).filter(col("mmsi").isNotNull())

# ── Cache for vessel profiles ──────────────────
vessel_profiles_cache = TTLCache(maxsize=5000, ttl=300)  # max 5000 vessels, 5min TTL
mongo_client = MongoClient(MONGO_URI)

def get_vessel_profile(mmsi):
    if mmsi in vessel_profiles_cache:
        return vessel_profiles_cache[mmsi]
    
    db = mongo_client.ais_db
    profile = db.vessel_profiles.find_one({"mmsi": mmsi})
    
    if profile:
        vessel_profiles_cache[mmsi] = profile
        return profile
    return None

# ── Anomaly detection ─────────────────────────
ANCHORED_STATUSES = {1, 5}


def _alert_id(mmsi: int, alert_type: str, window_minutes: int = 5) -> str:
    # Bucket time into N-minute windows so the same vessel+type within one
    # window always produces the same id. Upserts on this key are idempotent
    # across batch replays, unlike hashing current_timestamp() per row.
    from datetime import timezone
    bucket = int(datetime.now(timezone.utc).timestamp() // (window_minutes * 60))
    return hashlib.sha256(f"{mmsi}_{alert_type}_{bucket}".encode()).hexdigest()


def detect_anomalies(batch_df, batch_id):
    if batch_df.isEmpty():
        return

    db = mongo_client.ais_db
    alerts = []

    for row in batch_df.collect():
        # Anomaly 1: stopped at sea (speed=0, not anchored/moored)
        if row.speed is not None and row.speed == 0 and row.nav_status not in ANCHORED_STATUSES:
            alerts.append({
                "alert_id":  _alert_id(row.mmsi, "vessel_stopped_at_sea"),
                "type":      "vessel_stopped_at_sea",
                "severity":  "high",
                "mmsi":      row.mmsi,
                "ship_name": row.ship_name,
                "latitude":  row.latitude,
                "longitude": row.longitude,
                "speed":     row.speed,
                "timestamp": str(row.recorded_at),
                "resolved":  False,
            })

        # Anomaly 2: abnormal speed vs historical profile
        profile = get_vessel_profile(row.mmsi)
        if profile and row.speed is not None and row.speed > 5:
            normal_speed = profile.get("avg_speed", 15)
            std_dev = profile.get("speed_std_dev", 5)
            if abs(row.speed - normal_speed) > 2 * std_dev:
                alerts.append({
                    "alert_id":       _alert_id(row.mmsi, "abnormal_speed"),
                    "type":           "abnormal_speed",
                    "severity":       "medium",
                    "mmsi":           row.mmsi,
                    "ship_name":      row.ship_name,
                    "latitude":       row.latitude,
                    "longitude":      row.longitude,
                    "speed":          row.speed,
                    "expected_speed": normal_speed,
                    "timestamp":      str(row.recorded_at),
                    "resolved":       False,
                })

    # Upsert by alert_id — $setOnInsert makes this idempotent across replays
    inserted = 0
    for alert in alerts:
        result = db.alerts.update_one(
            {"alert_id": alert["alert_id"]},
            {"$setOnInsert": alert},
            upsert=True,
        )
        if result.upserted_id:
            inserted += 1

    if inserted:
        print(f"[Anomalies] Batch {batch_id}: inserted {inserted} new alerts")
        
query = parsed.writeStream \
    .foreachBatch(detect_anomalies) \
    .option("checkpointLocation", "/tmp/checkpoints/job3_anomalies") \
    .trigger(processingTime="10 seconds") \
    .start()

print("Job 3 running — Anomaly detection flowing to MongoDB...")
query.awaitTermination()