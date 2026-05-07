# AIS Platform — Storage Guide

Five storage systems are in use. Each was chosen for a specific access pattern.
This document explains what each one stores, why it was chosen, what it is **not**
used for, and what would break if you removed it.

---

## Redis

**Role: live vessel state cache**

Redis holds the current position of every active vessel as a single JSON key
(`vessel:{mmsi}`). A sorted set (`vessel:active`) acts as an index — scores are
Unix timestamps so the backend can find all vessels active in the last 10 minutes
with a single `ZRANGEBYSCORE` call, then pipeline-fetch their payloads in one
round trip.

**Why Redis and not Cassandra for this?**
The live map WebSocket pushes an update every second. Cassandra is optimised for
high-throughput sequential writes and range reads, not for "give me the current
state of 500 arbitrary keys right now." Redis does that in < 1 ms. Cassandra
would take 5–50 ms for the same scatter-gather read at this cardinality.

**TTL:** Each vessel key expires after 5 minutes of inactivity. The sorted set is
pruned by the backend on every read. No manual cleanup needed.

**Not used for:** historical data, analytics, persistence across restarts. If the
Redis container restarts, the live vessel cache rebuilds within seconds as new
AIS messages arrive.

**What breaks without it:** the live map goes dark. The `/api/live/vessels`
endpoint and the WebSocket both read exclusively from Redis.

---

## Cassandra

**Role: hot trajectory store (last 30 days)**

Cassandra stores every individual AIS position report received from the stream.
The primary key `(mmsi, date)` co-locates all positions for one vessel on one day
on the same node, making trajectory queries (`WHERE mmsi = X AND date = Y`) a
single-partition read regardless of how many rows exist.

**Why Cassandra and not MongoDB or PostgreSQL for this?**
Stream job 1 writes thousands of rows per minute continuously — one row per AIS
message received. Cassandra is purpose-built for this: append-only time-series
writes with no read-before-write, linear horizontal scale, and a configurable TTL
that auto-expires rows without a background job. MongoDB would work but has
higher write overhead for raw time-series at this volume. A relational database
would require index maintenance on every insert.

**TTL:** 30 days. Rows auto-expire; the table never grows unboundedly.

**Not used for:** aggregated analytics (that's MongoDB), current vessel state
(that's Redis), or data older than 30 days (that's HDFS).

**What breaks without it:** vessel trajectory in the detail panel disappears.
Batch jobs A, B, C, D have no source data to read.

---

## HDFS

**Role: permanent archive + Spark checkpoint store**

HDFS stores two things:

1. **Parquet archive** — stream job 4 writes every AIS position to HDFS as
   Parquet, partitioned by `year/month/day/hour`. This is the permanent cold
   store. Once data ages out of Cassandra's 30-day TTL, HDFS is the only place
   it exists. Batch jobs can read from HDFS via `read_vessel_positions_from_hdfs()`
   for historical analysis beyond 30 days.

2. **Spark streaming checkpoints** — each stream job writes its Kafka offset
   and state to HDFS. On container restart, the job reads its checkpoint and
   resumes from the last committed offset. Without this, every restart would
   replay Kafka from the beginning (or miss data depending on offset config).

**Why HDFS and not S3/object storage?**
This is a self-hosted platform with no cloud dependency. HDFS runs in Docker
alongside everything else. The access pattern (sequential Parquet writes, batch
Parquet reads) is exactly what HDFS was designed for.

**Not used for:** live queries (too high latency for real-time), small random
reads, anything requiring sub-second response time.

**What breaks without it:** stream jobs lose checkpoint durability (restart =
potential duplicate or lost data). Historical batch analysis beyond 30 days
becomes impossible. Job 4 has no sink to write to.

---

## MongoDB

**Role: analytics results store**

MongoDB stores the output of every batch and stream analytics job — zone stats,
anomaly alerts, vessel profiles, route segments, heatmap tiles, and zone traffic
aggregates. All of these are written by Spark jobs or stream jobs and read by the
backend API.

**Why MongoDB and not Cassandra for analytics?**
Analytics documents are heterogeneous — a zone traffic document looks nothing
like a heatmap tile or an anomaly alert. MongoDB's schema-flexible collections
map naturally to this. Each collection has a different shape, different indexes,
and different query patterns. Storing all of this in Cassandra would require
designing a wide table per collection, which is awkward and inflexible.
Additionally, batch jobs use `bulk_write` with upsert semantics — MongoDB handles
this cleanly; Cassandra's `INSERT` is effectively an upsert already but lacks
the fine-grained conditional update operators (`$set`, `$inc`) that some jobs use.

**Not used for:** raw time-series positions (that's Cassandra), live state (that's
Redis), binary/file storage.

**What breaks without it:** the entire analytics layer disappears — zone stats,
alerts, heatmap, route flows, and traffic insights all read from MongoDB.

---

## Kafka

**Role: ingestion bus and stream job input**

Kafka sits between the AIS ingestion producer and the four Spark stream jobs.
The producer publishes one message per AIS position report to the
`ais.raw.positions` topic. Each stream job is an independent consumer that reads
from the same topic at its own pace and offset.

**Why Kafka and not direct socket / HTTP push?**
Decoupling. Without Kafka, the ingestion producer would need to write directly
to Cassandra, Redis, MongoDB, and HDFS simultaneously — any downstream slowness
or restart would cause data loss. Kafka absorbs bursts, allows each consumer to
process at its own rate, and retains messages so a restarted stream job can
catch up from its last committed offset (stored in HDFS checkpoints).

**Not used for:** persistent storage (messages are retained for the broker's
configured retention period, not indefinitely), queries, or serving the API.

**What breaks without it:** all four stream jobs have no input. The ingestion
producer has nowhere to publish. The entire real-time pipeline stops.

---

## Summary

| Storage | Holds | Written by | Read by | Survives restart? |
|---|---|---|---|---|
| **Redis** | Current vessel positions | Stream job 1 | Backend API, WebSocket | No — rebuilds in seconds |
| **Cassandra** | Raw AIS positions (30 days) | Stream job 1 | Backend API (trajectory), batch jobs | Yes — persistent volume |
| **HDFS** | Parquet archive + checkpoints | Stream job 4 + all stream jobs | Batch jobs (historical), stream jobs (resume) | Yes — persistent volume |
| **MongoDB** | All analytics outputs | Stream jobs 2, 3 + batch jobs A–D | Backend API (all analytics endpoints) | Yes — persistent volume |
| **Kafka** | In-flight AIS messages | Ingestion producer | Stream jobs 1–4 | Partial — broker log on volume, offsets in HDFS |
