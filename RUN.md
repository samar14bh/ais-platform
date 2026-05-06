# AIS Platform — Daily Startup

Assumes first-time setup is already done (schema applied, CSV loaded, MongoDB initialized).

---

## 1. Start all services

```powershell
docker compose --profile full up -d
```

> Add `--build` only if you changed backend, Spark, or ingestion code since last run.

---

## 2. Start the frontend

In a separate terminal:

```powershell
cd frontend
npm run dev
```

Open http://localhost:5173.

---

## 3. Check everything is up

```powershell
docker compose --profile full ps
```

All services should show `running` or `healthy`. The stream jobs take ~30 seconds to start processing after Kafka becomes healthy.

Quick sanity checks:

```powershell
# Backend alive
Invoke-WebRequest http://localhost:8000/api/health | Select-Object -Expand Content

# Live vessels in Redis (should grow after ~30s)
docker exec redis redis-cli DBSIZE

# Zone stats updating in MongoDB
docker exec mongodb mongosh -u admin -p yourpassword --authenticationDatabase admin --eval "db.getSiblingDB('ais_db').zone_stats.countDocuments()"
```

---

## 4. Stop

```powershell
docker compose --profile full down
```

Data is preserved in Docker volumes. Nothing needs to be re-seeded on next start.
