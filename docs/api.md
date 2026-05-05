# AIS Platform — API Reference

Base URL: `http://localhost:8000`  
Interactive docs: `http://localhost:8000/docs`

---

## REST endpoints

### `GET /api/health`

Liveness check.

```json
{ "status": "ok", "timestamp": "2026-05-05T12:00:00Z" }
```

---

### `GET /api/live/vessels`

Returns all vessels that have sent a position in the last 10 minutes, sourced
from Redis.

```json
{
  "timestamp":    "2026-05-05T12:00:00Z",
  "total_ships":  247,
  "average_speed": 8.3,
  "data": [
    {
      "id":         "123456789",
      "mmsi":       "123456789",
      "ship_name":  "VESSEL NAME",
      "lat":        37.5,
      "lon":        15.5,
      "speed":      12.5,
      "course":     180.0,
      "heading":    180,
      "nav_status": 0,
      "status":     "Under way using engine",
      "updated_at": "2026-05-05T11:59:45Z"
    }
  ]
}
```

---

### `GET /api/alerts`

Recent anomaly alerts, newest first, limit 50. Sourced from MongoDB `alerts`.

```json
[
  {
    "alert_id":  "sha256hex",
    "type":      "vessel_stopped_at_sea",
    "severity":  "high",
    "mmsi":      123456789,
    "ship_name": "VESSEL NAME",
    "latitude":  37.5,
    "longitude": 15.5,
    "timestamp": "2026-05-05T11:58:00Z"
  }
]
```

---

### `GET /api/zone-stats`

Current real-time snapshot per zone. Sourced from MongoDB `zone_stats`.

```json
[
  { "zone": "adriatic",    "avg_speed": 8.3, "vessel_count": 42, "timestamp": "..." },
  { "zone": "aegean",      "avg_speed": 7.1, "vessel_count": 31, "timestamp": "..." }
]
```

---

### `GET /api/zone-traffic/{period}`

Historical zone traffic from batch analytics.  
`period` must be `hourly` or `daily`.

Hourly:
```json
[
  { "zone": "adriatic", "hour": "2026-05-04T14:00:00", "vessel_count": 45, "avg_speed": 8.3, "max_speed": 22.1, "message_count": 1250 }
]
```

Daily:
```json
[
  { "zone": "adriatic", "date": "2026-05-04", "vessel_count": 180, "avg_speed": 8.1, "peak_hour": 14, "peak_count": 52 }
]
```

---

### `GET /api/heatmap`

All heatmap tiles for the most recent batch date (precision 5, ~5 km grid).
Sourced from MongoDB `heatmap_tiles_p5`.

```json
[
  { "cell": "u2hp", "lat": 37.5, "lon": 15.5, "count": 1250, "vessels": 35, "intensity": 0.87 }
]
```

`intensity` is log-normalised 0–1. Pass directly to Leaflet.heat as
`[lat, lon, intensity]`.

---

### `GET /api/routes`

Route segments for the most recent batch date.
Sourced from MongoDB `route_segments`.

```json
[
  { "cell_from": "u2hp", "lat_from": 37.5, "lon_from": 15.5,
    "cell_to":   "u2hq", "lat_to":   37.6, "lon_to":   15.6,
    "count": 127, "avg_speed": 8.2 }
]
```

`count` is the number of vessel transitions on this segment that day. Used as
polyline weight in the frontend.

---

### `GET /api/vessels/{mmsi}/trajectory`

Recent trajectory for a specific vessel. Sourced from Cassandra.

```json
[
  { "mmsi": 123456789, "recorded_at": "2026-05-05T12:00:00Z",
    "latitude": 37.5, "longitude": 15.5, "speed": 12.5 }
]
```

---

## WebSocket

### `WS /ws/live-traffic`

Connect once; the server pushes a full vessel list every 1 second.

Message format is identical to `GET /api/live/vessels`:

```json
{
  "timestamp":    "2026-05-05T12:00:00Z",
  "total_ships":  247,
  "average_speed": 8.3,
  "data": [ ... ]
}
```

The connection is long-lived. The server handles disconnection gracefully.
The frontend auto-reconnects if the connection drops.
