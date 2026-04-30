<#
PowerShell helper to start and initialize the project.
Usage:
  .\run_project.ps1                # run core DBs, init DBs, build backend, build frontend
  .\run_project.ps1 -Full         # run full profile (streaming + batch jobs) - may be heavy
  .\run_project.ps1 -FrontendDev  # run frontend dev server
#>
param(
  [switch]$Full,
  [switch]$FrontendDev
)

function Load-EnvFile {
  param([string]$Path = '.env')
  if (-not (Test-Path $Path)) { Write-Host "No $Path found" -ForegroundColor Yellow; return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)\s*$') {
      $name = $matches[1].Trim()
      $value = $matches[2].Trim(' "')
      Set-Item -Path "Env:$name" -Value $value
    }
  }
  Write-Host "Loaded environment variables from $Path"
}

function Exec-Check { param($Cmd) ; Write-Host "==> $Cmd"; iex $Cmd }

# Start
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptRoot
Load-EnvFile -Path "$ScriptRoot\.env"

# Basic checks
try { docker version > $null } catch { Write-Error "Docker not available. Start Docker Desktop." ; exit 1 }

Write-Host "Starting core services: redis, mongodb, cassandra, minio, kafka" -ForegroundColor Cyan
Exec-Check "docker compose up -d redis mongodb cassandra minio kafka"

Write-Host "Waiting for MongoDB to accept connections (timeout 120s)..." -NoNewline
$start = Get-Date
while ((Get-Date) - $start -lt (New-TimeSpan -Seconds 120)) {
  try {
    docker compose exec mongodb mongosh -u $env:MONGO_USER -p $env:MONGO_PASSWORD --authenticationDatabase admin --eval "db.runCommand({connectionStatus:1})" > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host " ok"; break }
  } catch {}
  Write-Host -NoNewline '.' ; Start-Sleep -Seconds 2
}

# Initialize MongoDB collections/indexes by copying script into container and running
Write-Host "Initializing MongoDB collections/indexes..."
$mongoContainerId = (docker compose ps -q mongodb).Trim()
if ($mongoContainerId) {
  Exec-Check ('docker cp "{0}\scripts\init_mongo.js" {1}:/tmp/init_mongo.js' -f $ScriptRoot, $mongoContainerId)
  Exec-Check "docker compose exec mongodb mongosh -u $env:MONGO_USER -p $env:MONGO_PASSWORD --authenticationDatabase admin /tmp/init_mongo.js"
} else { Write-Warning "Could not determine mongodb container id" }

# Apply Cassandra schema
Write-Host "Applying Cassandra schema..."
$cassContainerId = (docker compose ps -q cassandra).Trim()
if ($cassContainerId) {
  Exec-Check ('docker cp "{0}\config\cassandra_schema.cql" {1}:/tmp/schema.cql' -f $ScriptRoot, $cassContainerId)
  Exec-Check "docker compose exec cassandra cqlsh -f /tmp/schema.cql"
} else { Write-Warning "Could not determine cassandra container id" }

# Build and run backend
Write-Host "Building and running backend..."
Exec-Check "docker compose build backend"
Exec-Check "docker compose up -d backend"

# Frontend
if ($FrontendDev) {
  Write-Host "Starting frontend dev server (runs locally on your machine)" -ForegroundColor Cyan
  Push-Location frontend
  Exec-Check "npm install"
  Exec-Check "npm run dev"
  Pop-Location
} else {
  Write-Host "Building frontend (production)" -ForegroundColor Cyan
  Push-Location frontend
  Exec-Check "npm install"
  Exec-Check "npm run build"
  Pop-Location
}

# Optionally start the full profile
if ($Full) {
  Write-Host "Starting full profile (streaming + batch services). This may be resource-heavy." -ForegroundColor Yellow
  Exec-Check "docker compose --profile full up -d --build"
}

Write-Host "All requested steps finished. Check logs if something failed." -ForegroundColor Green
Write-Host "Helpful checks: docker compose ps | docker compose logs -f backend" -ForegroundColor Cyan
Write-Host "Frontend dev: http://localhost:5173   Backend API: http://localhost:8000/docs" -ForegroundColor Cyan
