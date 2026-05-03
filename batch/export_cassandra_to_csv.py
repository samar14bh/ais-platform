"""
Export vessel_positions from Cassandra to a single CSV file.

By default this exports the full ais.vessel_positions table. If EXPORT_DATE is
set to YYYY-MM-DD, the script exports only that Cassandra partition date.

Output is written under /opt/spark-jobs/batch/exports so it is visible on the
host through the mounted batch/ directory.
"""

import os
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv
from pyspark.sql.functions import col, lit


if "/opt/spark-jobs" not in sys.path:
    sys.path.insert(0, "/opt/spark-jobs")

try:
    from batch.batch_utils import build_batch_spark_session
except ModuleNotFoundError:
    from batch_utils import build_batch_spark_session


load_dotenv()

CASSANDRA_HOST = os.getenv("CASSANDRA_HOST", "cassandra")
EXPORT_DATE = os.getenv("EXPORT_DATE", "").strip()
OUTPUT_DIR = Path(os.getenv("CSV_OUTPUT_DIR", "/opt/spark-jobs/batch/exports"))

spark = build_batch_spark_session("AIS_Cassandra_To_CSV", CASSANDRA_HOST)
spark.sparkContext.setLogLevel("WARN")

print("[CSV Export] Reading ais.vessel_positions from Cassandra...")

df = spark.read.format("org.apache.spark.sql.cassandra") \
    .option("keyspace", "ais") \
    .option("table", "vessel_positions") \
    .load()

if EXPORT_DATE:
    df = df.filter(col("date") == lit(EXPORT_DATE))
    output_stem = f"cassandra_vessel_positions_{EXPORT_DATE}"
else:
    output_stem = "cassandra_vessel_positions_all"

df = df.select(
    "mmsi",
    "date",
    "recorded_at",
    "ship_name",
    "latitude",
    "longitude",
    "speed",
    "course",
    "heading",
    "nav_status",
)

row_count = df.count()
print(f"[CSV Export] Rows to export: {row_count}")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
temp_dir = OUTPUT_DIR / f"{output_stem}_tmp"
final_csv = OUTPUT_DIR / f"{output_stem}.csv"

if temp_dir.exists():
    shutil.rmtree(temp_dir)
if final_csv.exists():
    final_csv.unlink()

df.coalesce(1).write.mode("overwrite").option("header", "true").csv(str(temp_dir))

part_files = sorted(temp_dir.glob("part-*.csv"))
if not part_files:
    raise FileNotFoundError(f"No CSV part file was created in {temp_dir}")

shutil.move(str(part_files[0]), str(final_csv))
shutil.rmtree(temp_dir)

print(f"[CSV Export] Wrote {final_csv}")

spark.stop()