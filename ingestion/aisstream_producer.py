import asyncio
import websockets
import json
import os
import logging
from kafka import KafkaProducer
from kafka.errors import NoBrokersAvailable
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

API_KEY      = os.getenv("AISSTREAM_API_KEY")
KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")
KAFKA_TOPIC  = "ais.raw.positions"
FILTER_MESSAGE_TYPES = [
    t.strip() for t in os.getenv("AIS_FILTER_MESSAGE_TYPES", "PositionReport").split(",") if t.strip()
]

# This covers the Mediterranean Sea
DEFAULT_BOUNDING_BOXES = [[[30.0, -6.0], [47.0, 37.0]]]
try:
    BOUNDING_BOXES = json.loads(os.getenv("AIS_BOUNDING_BOXES_JSON", json.dumps(DEFAULT_BOUNDING_BOXES)))
except json.JSONDecodeError:
    logger.warning("Invalid AIS_BOUNDING_BOXES_JSON value. Falling back to default Mediterranean box.")
    BOUNDING_BOXES = DEFAULT_BOUNDING_BOXES

def create_producer():
    while True:
        try:
            logger.info(f"Connecting to Kafka at {KAFKA_BROKER}...")
            return KafkaProducer(
                bootstrap_servers=KAFKA_BROKER,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                acks="all",              # wait for broker confirmation
                retries=5,                # retry on failure
            )
        except NoBrokersAvailable:
            logger.warning("Kafka not ready yet. Retrying in 3s...")
            import time
            time.sleep(3)

async def connect_and_stream(producer):
    url = "wss://stream.aisstream.io/v0/stream"

    logger.info("Connecting to AISStream...")
    async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:

        subscribe_msg = {
            "APIKey": API_KEY,
            "BoundingBoxes": BOUNDING_BOXES,
        }
        if FILTER_MESSAGE_TYPES:
            subscribe_msg["FilterMessageTypes"] = FILTER_MESSAGE_TYPES

        await ws.send(json.dumps(subscribe_msg))
        logger.info(f"Subscribed. Waiting for messages... filters={FILTER_MESSAGE_TYPES or 'none'}")

        while True:
            try:
                raw_msg = await asyncio.wait_for(ws.recv(), timeout=45)
                msg = json.loads(raw_msg)

                # Extract useful metadata for logging
                meta     = msg.get("MetaData", {})
                mmsi     = meta.get("MMSI", "unknown")
                ship_name = meta.get("ShipName", "unknown").strip()

                # Send to Kafka
                producer.send(KAFKA_TOPIC, value=msg)

                logger.info(f"→ Kafka | MMSI: {mmsi} | Ship: {ship_name}")

            except asyncio.TimeoutError:
                logger.warning("No AIS messages received in the last 45s. Still connected...")
                continue

            except websockets.exceptions.ConnectionClosed as e:
                
                logger.warning(f"AIS websocket closed: {e}. Reconnecting...")
                raise

            except Exception as e:
                logger.error(f"Error processing message: {e}")
                continue

async def main():
    if not API_KEY:
        raise RuntimeError("AISSTREAM_API_KEY is missing")

    producer = create_producer()
    try:
        # Auto-reconnect loop
        while True:
            try:
                await connect_and_stream(producer)
            except websockets.exceptions.ConnectionClosed:
                logger.warning("WebSocket closed. Reconnecting in 5s...")
                await asyncio.sleep(5)
            except Exception as e:
                logger.error(f"Unexpected error: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)
    finally:
        producer.close()

if __name__ == "__main__":
    asyncio.run(main())