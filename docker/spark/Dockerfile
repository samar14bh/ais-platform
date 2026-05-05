FROM apache/spark:3.5.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends cron \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-spark.txt /tmp/requirements-spark.txt
RUN pip install --no-cache-dir -r /tmp/requirements-spark.txt

# Entrypoint writes core-site.xml from env vars at container startup so the
# Hadoop client inside Spark knows where the HDFS NameNode is.
COPY docker/spark/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Stay as root so the entrypoint can write to $SPARK_HOME/conf.
# The original apache/spark image runs as root by default anyway.
ENTRYPOINT ["/entrypoint.sh"]
