from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional

from cassandra.cluster import Cluster
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient, DESCENDING
from redis import Redis
from dotenv import load_dotenv


load_dotenv()

app = FastAPI(title="Maritime Traffic API")
REDIS_ACTIVE_INDEX = "vessel:active"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _mongo_uri() -> str:
    mongo_user = os.getenv("MONGO_USER", "admin")
    mongo_password = os.getenv("MONGO_PASSWORD")
    return f"mongodb://{mongo_user}:{mongo_password}@mongodb:27017/?authSource=admin"


@lru_cache(maxsize=1)
def _redis_client() -> Redis:
    return Redis(
        host=os.getenv("REDIS_HOST", "redis"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        decode_responses=True,
    )


@lru_cache(maxsize=1)
def _mongo_client() -> MongoClient:
    return MongoClient(_mongo_uri())


def _mongo_collection(name: str):
    return _mongo_client().ais_db[name]


@lru_cache(maxsize=1)
def _cassandra_session():
    cluster = Cluster([os.getenv("CASSANDRA_HOST", "cassandra")], port=int(os.getenv("CASSANDRA_PORT", "9042")))
    return cluster.connect("ais")


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _decode_redis_ship(payload: str, key: str) -> dict[str, Any]:
    data = json.loads(payload)
    vessel_id = data.get("mmsi") or key.split(":", 1)[-1]
    latitude = _safe_float(data.get("latitude"))
    longitude = _safe_float(data.get("longitude"))
    speed = _safe_float(data.get("speed"))
    course = _safe_float(data.get("course"))
    heading = _safe_int(data.get("heading"))
    nav_status = _safe_int(data.get("nav_status"))

    status_map = {
        0: "Under way",
        1: "At anchor",
        5: "Moored",
    }

    return {
        "id": str(vessel_id),
        "mmsi": str(vessel_id),
        "ship_name": data.get("ship_name"),
        "lat": latitude,
        "lon": longitude,
        "speed": speed,
        "course": course,
        "heading": heading,
        "nav_status": nav_status,
        "status": data.get("nav_status_label") or status_map.get(nav_status, data.get("nav_status") or "Under way"),
        "updated_at": data.get("updated_at"),
    }


def _get_live_vessels() -> list[dict[str, Any]]:
    client = _redis_client()
    ships: list[dict[str, Any]] = []
    now_ts = datetime.now(timezone.utc).timestamp()
    cutoff = now_ts - 600
    client.zremrangebyscore(REDIS_ACTIVE_INDEX, 0, cutoff)
    keys = client.zrevrangebyscore(REDIS_ACTIVE_INDEX, max=now_ts, min=cutoff)

    if not keys:
        # Sorted set empty — fall back to scanning vessel keys only,
        # but exclude the index key itself.
        keys = [k for k in client.scan_iter(match="vessel:?*") if k != REDIS_ACTIVE_INDEX]

    pipeline = client.pipeline()
    for key in keys:
        pipeline.get(key)
    payloads = pipeline.execute()

    for key, payload in zip(keys, payloads, strict=False):
        if not payload:
            continue
        try:
            ships.append(_decode_redis_ship(payload, key))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    ships.sort(key=lambda ship: ship.get("updated_at") or "", reverse=True)
    return ships


@app.get("/")
def read_root():
    return {"message": "Maritime API is running"}


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/live/vessels")
def get_live_vessels():
    vessels = _get_live_vessels()
    avg_speed = 0.0
    if vessels:
        speeds = [ship["speed"] for ship in vessels if ship.get("speed") is not None]
        avg_speed = sum(speeds) / len(speeds) if speeds else 0.0

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_ships": len(vessels),
        "average_speed": round(avg_speed, 2),
        "data": vessels,
    }


@app.get("/api/alerts")
def get_alerts(limit: int = Query(default=25, ge=1, le=200), resolved: Optional[bool] = None):
    collection = _mongo_collection("alerts")
    query: dict[str, Any] = {}
    if resolved is not None:
        query["resolved"] = resolved

    alerts = list(
        collection.find(query, {"_id": 0}).sort("timestamp", DESCENDING).limit(limit)
    )
    return {"count": len(alerts), "data": alerts}


@app.get("/api/zone-stats")
def get_zone_stats(limit: int = Query(default=20, ge=1, le=500), zone: Optional[str] = None):
    collection = _mongo_collection("zone_stats")
    query: dict[str, Any] = {}
    if zone:
        query["zone"] = zone

    stats = list(
        collection.find(query, {"_id": 0}).sort("timestamp", DESCENDING).limit(limit)
    )
    return {"count": len(stats), "data": stats}


@app.get("/api/zone-traffic/{period}")
def get_zone_traffic(period: str, limit: int = Query(default=50, ge=1, le=500), zone: Optional[str] = None):
    if period == "hourly":
        collection_name = "zone_traffic_hourly"
    elif period == "daily":
        collection_name = "zone_traffic_daily"
    else:
        raise HTTPException(status_code=422, detail="period must be 'hourly' or 'daily'")

    collection = _mongo_collection(collection_name)
    query: dict[str, Any] = {}
    if zone:
        query["zone"] = zone

    items = list(collection.find(query, {"_id": 0}).sort("updated_at", DESCENDING).limit(limit))
    return {"count": len(items), "data": items}


@app.get("/api/heatmap")
def get_heatmap(
    heatmap_date: Optional[str] = Query(default=None, alias="date"),
    precision: int = Query(default=5, ge=5, le=6),
    limit: int = Query(default=5000, ge=1, le=10000),
):
    collection = _mongo_collection(f"heatmap_tiles_p{precision}")
    query: dict[str, Any] = {}
    if heatmap_date:
        query["date"] = heatmap_date

    tiles = list(collection.find(query, {"_id": 0}).sort("intensity", DESCENDING).limit(limit))
    return {"count": len(tiles), "data": tiles}


@app.get("/api/routes")
def get_routes(
    route_date: Optional[str] = Query(default=None, alias="date"),
    limit: int = Query(default=1000, ge=1, le=5000),
):
    collection = _mongo_collection("route_segments")
    query: dict[str, Any] = {}
    if route_date:
        query["window_date"] = route_date

    routes = list(collection.find(query, {"_id": 0}).sort("count", DESCENDING).limit(limit))
    return {"count": len(routes), "data": routes}


@app.get("/api/vessels/{mmsi}/trajectory")
def get_vessel_trajectory(
    mmsi: int,
    trajectory_date: Optional[str] = Query(default=None, alias="date"),
    limit: int = Query(default=500, ge=1, le=2000),
):
    session = _cassandra_session()
    query_date = trajectory_date or datetime.now(timezone.utc).date().isoformat()

    rows = session.execute(
        """
        SELECT mmsi, date, recorded_at, ship_name, latitude, longitude, speed, course, heading, nav_status
        FROM vessel_positions
        WHERE mmsi = %s AND date = %s
        ORDER BY recorded_at DESC
        LIMIT %s
        """,
        (mmsi, query_date, limit),
    )

    trajectory = []
    for row in rows:
        trajectory.append(
            {
                "mmsi": row.mmsi,
                "date": row.date.isoformat() if hasattr(row.date, "isoformat") else str(row.date),
                "recorded_at": row.recorded_at.isoformat() if row.recorded_at else None,
                "ship_name": row.ship_name,
                "latitude": row.latitude,
                "longitude": row.longitude,
                "speed": row.speed,
                "course": row.course,
                "heading": row.heading,
                "nav_status": row.nav_status,
            }
        )

    return {"count": len(trajectory), "data": trajectory}


@app.websocket("/ws/live-traffic")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    loop = asyncio.get_event_loop()
    try:
        while True:
            vessels = await loop.run_in_executor(None, _get_live_vessels)
            speeds = [ship["speed"] for ship in vessels if ship.get("speed") is not None]
            payload = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total_ships": len(vessels),
                "average_speed": round(sum(speeds) / len(speeds), 2) if speeds else 0.0,
                "data": vessels,
            }
            await websocket.send_json(payload)
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
