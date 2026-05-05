#!/bin/bash
# Generate Hadoop core-site.xml from env vars so Spark's Hadoop client
# knows where the HDFS NameNode is. This runs as root before dropping to
# the spark user, so it can write into $SPARK_HOME/conf/.
#
# HDFS_NAMENODE and HDFS_PORT are injected by docker-compose.

HDFS_NAMENODE=${HDFS_NAMENODE:-hdfs-namenode}
HDFS_PORT=${HDFS_PORT:-8020}
CONF_DIR="${SPARK_HOME:-/opt/spark}/conf"

mkdir -p "$CONF_DIR"

cat > "$CONF_DIR/core-site.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="configuration.xsl"?>
<configuration>
  <property>
    <name>fs.defaultFS</name>
    <value>hdfs://${HDFS_NAMENODE}:${HDFS_PORT}</value>
  </property>
  <property>
    <name>dfs.client.use.datanode.hostname</name>
    <value>true</value>
  </property>
</configuration>
EOF

echo "[entrypoint] Wrote core-site.xml: hdfs://${HDFS_NAMENODE}:${HDFS_PORT}"

# Hand off to whatever command docker-compose specified
exec "$@"
