-- AIS Cassandra schema
-- Run this once before starting Job 1 (or alter if table already exists)
--
-- The `date` partition column is critical for batch jobs:
-- querying by date avoids full table scans and makes batch reads
-- orders of magnitude faster once you have weeks of data.
--
-- Connect: docker exec -it <cassandra_container> cqlsh

CREATE KEYSPACE IF NOT EXISTS ais
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

USE ais;

-- Primary table: full trajectory history
-- Partitioned by (mmsi, date) → all positions for a vessel on a given day
-- are co-located on the same Cassandra node.
-- Clustered by recorded_at descending → latest position is first.
CREATE TABLE IF NOT EXISTS vessel_positions (
    mmsi        int,
    date        date,           -- partition key alongside mmsi
    recorded_at timestamp,
    ship_name   text,
    latitude    double,
    longitude   double,
    speed       double,
    course      double,
    heading     int,
    nav_status  int,
    PRIMARY KEY ((mmsi, date), recorded_at)
) WITH CLUSTERING ORDER BY (recorded_at DESC)
  AND default_time_to_live = 2592000;  -- auto-expire after 30 days (optional)

-- Secondary index for batch jobs that query by date only (all vessels for a day)
-- This is a Cassandra ALLOW FILTERING pattern — use the Spark connector instead
-- which handles partition pruning automatically via spark.cassandra.input.split.size

-- For reference: the Spark read in batch jobs uses pushdown filtering:
--   .filter(to_date(col("recorded_at")) == lit("2024-01-15"))
-- The connector translates this into efficient token range reads.

-- Useful for monitoring
CREATE TABLE IF NOT EXISTS batch_job_runs (
    job_name    text,
    run_date    date,
    started_at  timestamp,
    finished_at timestamp,
    status      text,           -- 'success' | 'failed'
    rows_read   bigint,
    rows_written bigint,
    PRIMARY KEY (job_name, run_date)
) WITH CLUSTERING ORDER BY (run_date DESC);
