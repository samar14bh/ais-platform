import os
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit


def _hdfs_uri():
    namenode = os.getenv("HDFS_NAMENODE", "hdfs-namenode")
    port = os.getenv("HDFS_PORT", "8020")
    return f"hdfs://{namenode}:{port}"


def build_batch_spark_session(app_name, cassandra_host):
    hdfs = _hdfs_uri()
    return SparkSession.builder \
        .appName(app_name) \
        .config(
            "spark.jars.packages",
            "com.datastax.spark:spark-cassandra-connector_2.12:3.5.0"
        ) \
        .config("spark.cassandra.connection.host", cassandra_host) \
        .config("spark.hadoop.fs.defaultFS", hdfs) \
        .getOrCreate()


def read_vessel_positions_for_date(
    spark,
    target_date,
    *,
    require_speed=False,
    null_island_delta=0.001,
    select_columns=None,
):
    """Read one day of vessel positions from Cassandra (hot path, ≤30 days).

    Filter is on the `date` partition key so the Cassandra connector pushes it
    down to token-range reads — only the relevant partitions are fetched.
    """
    df = spark.read \
        .format("org.apache.spark.sql.cassandra") \
        .option("keyspace", "ais") \
        .option("table", "vessel_positions") \
        .load() \
        .filter(col("date") == lit(target_date))

    return _clean_positions(df, require_speed, null_island_delta, select_columns)


def read_vessel_positions_from_hdfs(
    spark,
    target_date,
    *,
    require_speed=False,
    null_island_delta=0.001,
    select_columns=None,
):
    """Read one day of vessel positions from HDFS (cold path, >30 days or bulk analytics).

    HDFS stores Parquet files partitioned as:
        /ais/vessel_positions/year=YYYY/month=MM/day=DD/

    Spark reads the matching partition directory only — no full scan.
    Use this for historical queries on data that has expired from Cassandra.
    """
    hdfs_uri = _hdfs_uri()
    # Parse the target_date string into components for partition path
    from datetime import datetime
    dt = datetime.strptime(target_date, "%Y-%m-%d")
    # Spark's month()/dayofmonth() write integer partition names without
    # zero-padding (month=4, day=8) — match that exactly here.
    partition_path = (
        f"{hdfs_uri}/ais/vessel_positions"
        f"/year={dt.year}/month={dt.month}/day={dt.day}"
    )

    df = spark.read.parquet(partition_path)

    return _clean_positions(df, require_speed, null_island_delta, select_columns)


def read_vessel_positions_auto(
    spark,
    target_date,
    cassandra_ttl_days=30,
    *,
    require_speed=False,
    null_island_delta=0.001,
    select_columns=None,
):
    """Automatically choose Cassandra (recent) or HDFS (historical).

    Data within the last `cassandra_ttl_days` days is read from Cassandra
    because it is still in the hot store. Older data is read from HDFS.
    Both paths return identically shaped DataFrames so callers are agnostic.
    """
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=cassandra_ttl_days)).date()
    dt = datetime.strptime(target_date, "%Y-%m-%d").date()

    if dt >= cutoff:
        return read_vessel_positions_for_date(
            spark, target_date,
            require_speed=require_speed,
            null_island_delta=null_island_delta,
            select_columns=select_columns,
        )
    else:
        return read_vessel_positions_from_hdfs(
            spark, target_date,
            require_speed=require_speed,
            null_island_delta=null_island_delta,
            select_columns=select_columns,
        )


def _clean_positions(df, require_speed, null_island_delta, select_columns):
    """Shared quality filters applied to both Cassandra and HDFS reads."""
    df = df.filter(col("mmsi").isNotNull()) \
           .filter(col("latitude").isNotNull()) \
           .filter(col("longitude").isNotNull()) \
           .filter(~(
               (col("latitude").between(-null_island_delta, null_island_delta)) &
               (col("longitude").between(-null_island_delta, null_island_delta))
           )) \
           .filter(col("latitude").between(-90.0, 90.0)) \
           .filter(col("longitude").between(-180.0, 180.0))

    if require_speed:
        df = df.filter(col("speed").isNotNull())

    if select_columns:
        df = df.select(*select_columns)

    return df
