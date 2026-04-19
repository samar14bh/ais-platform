from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, to_date


def build_batch_spark_session(app_name, cassandra_host):
    return SparkSession.builder \
        .appName(app_name) \
        .config(
            "spark.jars.packages",
            "com.datastax.spark:spark-cassandra-connector_2.12:3.5.0"
        ) \
        .config("spark.cassandra.connection.host", cassandra_host) \
        .getOrCreate()


def read_vessel_positions_for_date(
    spark,
    target_date,
    *,
    require_speed=False,
    null_island_delta=0.001,
    enforce_global_bounds=False,
    select_columns=None,
):
    df = spark.read \
        .format("org.apache.spark.sql.cassandra") \
        .option("keyspace", "ais") \
        .option("table", "vessel_positions") \
        .load()

    df = df.filter(to_date(col("recorded_at")) == lit(target_date)) \
           .filter(col("mmsi").isNotNull()) \
           .filter(col("latitude").isNotNull()) \
           .filter(col("longitude").isNotNull()) \
           .filter(~(
               (col("latitude").between(-null_island_delta, null_island_delta)) &
               (col("longitude").between(-null_island_delta, null_island_delta))
           ))

    if require_speed:
        df = df.filter(col("speed").isNotNull())

    if enforce_global_bounds:
        df = df.filter(col("latitude").between(-90, 90)) \
               .filter(col("longitude").between(-180, 180))

    if select_columns:
        df = df.select(*select_columns)

    return df