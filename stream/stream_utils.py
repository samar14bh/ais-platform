import os
from dotenv import load_dotenv
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, from_json

try:
    from stream.schema import ais_schema
except ModuleNotFoundError:
    from schema import ais_schema


def load_stream_env(default_starting_offsets="latest"):
    load_dotenv()

    kafka_broker = os.getenv("KAFKA_BROKER", "kafka:9092")
    kafka_starting_offsets = os.getenv("KAFKA_STARTING_OFFSETS", default_starting_offsets)
    mongo_user = os.getenv("MONGO_USER", "admin")
    mongo_pass = os.getenv("MONGO_PASSWORD")
    mongo_uri = f"mongodb://{mongo_user}:{mongo_pass}@mongodb:27017"

    return {
        "kafka_broker": kafka_broker,
        "kafka_starting_offsets": kafka_starting_offsets,
        "mongo_uri": mongo_uri,
    }


def build_stream_spark_session(app_name, extra_packages=None, extra_configs=None):
    packages = ["org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.0"]
    if extra_packages:
        packages.extend(extra_packages)

    builder = SparkSession.builder \
        .appName(app_name) \
        .config("spark.jars.packages", ",".join(packages))

    if extra_configs:
        for key, value in extra_configs.items():
            builder = builder.config(key, value)

    return builder.getOrCreate()


def read_ais_kafka_stream(
    spark,
    kafka_broker,
    topic="ais.raw.positions",
    starting_offsets="latest",
    fail_on_data_loss=None,
):
    reader = spark.readStream \
        .format("kafka") \
        .option("kafka.bootstrap.servers", kafka_broker) \
        .option("subscribe", topic) \
        .option("startingOffsets", starting_offsets)

    if fail_on_data_loss is not None:
        reader = reader.option("failOnDataLoss", str(fail_on_data_loss).lower())

    return reader.load()


def parse_ais_payload(raw_df):
    return raw_df.select(
        from_json(col("value").cast("string"), ais_schema).alias("d")
    )