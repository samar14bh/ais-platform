#!/bin/bash
set -e  # Exit on first error

# Get target date from env or use yesterday
TARGET_DATE=${BATCH_DATE:-$(date -u +%Y-%m-%d)}

echo "════════════════════════════════════════"
echo "    BATCH JOBS RUNNER"
echo "════════════════════════════════════════"
echo "Target date: $TARGET_DATE"
echo "Cassandra:  ${CASSANDRA_HOST:-cassandra}"
echo "MongoDB:    ${MONGO_USER}@mongodb:27017"
echo ""

# Validate env variables
if [ -z "$MONGO_USER" ] || [ -z "$MONGO_PASSWORD" ]; then
    echo "ERROR: MONGO_USER or MONGO_PASSWORD not set"
    exit 1
fi

# Create cache directories
mkdir -p /tmp/.ivy2/cache /tmp/.ivy2/jars

SPARK_SUBMIT="/opt/spark/bin/spark-submit"
PACKAGES="com.datastax.spark:spark-cassandra-connector_2.12:3.5.0"
IVY_CONF="--conf spark.jars.ivy=/tmp/.ivy2"
# Set PYTHONPATH via Spark driver environment config
PYTHONPATH_CONF="--conf spark.driverEnv.PYTHONPATH=/opt/spark-jobs:/opt/spark-jobs/batch:/opt/spark-jobs/stream"

echo "Starting Spark jobs..."
echo ""

# Job D: Vessel behavioral profiles — must run first, stream job 3 depends on these
echo "┌─ Job D: Vessel Behavioral Profiling"
echo "│  Reads: Cassandra → vessel_positions"
echo "│  Writes: MongoDB → vessel_profiles"
$SPARK_SUBMIT $IVY_CONF $PYTHONPATH_CONF --packages "$PACKAGES" /opt/spark-jobs/batch/batch_job_d_vessel_profiles.py
if [ $? -eq 0 ]; then
    echo "└─ ✓ Job D completed"
else
    echo "└─ ✗ Job D failed"
    exit 1
fi

echo ""

# Job A: Route segments
echo "┌─ Job A: Route Segments Analysis"
echo "│  Reads: Cassandra → vessel_positions"
echo "│  Writes: MongoDB → route_segments"
$SPARK_SUBMIT $IVY_CONF $PYTHONPATH_CONF --packages "$PACKAGES" /opt/spark-jobs/batch/batch_job_a_routes.py
if [ $? -eq 0 ]; then
    echo "└─ ✓ Job A completed"
else
    echo "└─ ✗ Job A failed"
    exit 1
fi

echo ""

# Job B: Zone traffic
echo "┌─ Job B: Zone Traffic Analysis"
echo "│  Reads: Cassandra → vessel_positions"
echo "│  Writes: MongoDB → zone_traffic_hourly, zone_traffic_daily"
$SPARK_SUBMIT $IVY_CONF $PYTHONPATH_CONF --packages "$PACKAGES" /opt/spark-jobs/batch/batch_job_b_zone_traffic.py
if [ $? -eq 0 ]; then
    echo "└─ ✓ Job B completed"
else
    echo "└─ ✗ Job B failed"
    exit 1
fi

echo ""

# Job C: Heatmap
echo "┌─ Job C: Heatmap Analysis"
echo "│  Reads: Cassandra → vessel_positions"
echo "│  Writes: MongoDB → heatmap_tiles_p5, heatmap_tiles_p6"
$SPARK_SUBMIT $IVY_CONF $PYTHONPATH_CONF --packages "$PACKAGES" /opt/spark-jobs/batch/batch_job_c_heatmap.py
if [ $? -eq 0 ]; then
    echo "└─ ✓ Job C completed"
else
    echo "└─ ✗ Job C failed"
    exit 1
fi

echo ""
echo "════════════════════════════════════════"
echo "✓ All batch jobs completed successfully!"
echo "════════════════════════════════════════"
