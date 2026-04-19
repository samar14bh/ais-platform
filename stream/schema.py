from pyspark.sql.types import (
    StructType, StructField, StringType, DoubleType, IntegerType
)

metadata_schema = StructType([
    StructField("MMSI",      IntegerType(), True),
    StructField("ShipName",  StringType(),  True),
    StructField("latitude",  DoubleType(),  True),
    StructField("longitude", DoubleType(),  True),
    StructField("time_utc",  StringType(),  True),
])

position_schema = StructType([
    StructField("Sog",                DoubleType(),  True),
    StructField("Cog",                DoubleType(),  True),
    StructField("TrueHeading",        IntegerType(), True),
    StructField("NavigationalStatus", IntegerType(), True),
])

message_schema = StructType([
    StructField("PositionReport", position_schema, True)
])

ais_schema = StructType([
    StructField("MetaData",    metadata_schema, True),
    StructField("Message",     message_schema,  True),
    StructField("MessageType", StringType(),    True),
])
