#!/usr/bin/env pwsh
<#
.SYNOPSIS
Run batch jobs with proper environment variables loaded from .env
.PARAMETER Date
Target batch date (format: YYYY-MM-DD). Defaults to today.
#>
param(
    [string]$Date = (Get-Date -Format "yyyy-MM-dd")
)

# Load .env file
$envFile = "$PSScriptRoot\.env"
if (Test-Path $envFile) {
    Write-Host "Loading environment from .env..." -ForegroundColor Cyan
    $envVars = @{}
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*?)\s*$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim(' "')
            $envVars[$name] = $value
        }
    }
} else {
    Write-Host "ERROR: .env file not found at $envFile" -ForegroundColor Red
    exit 1
}

$mongoUser = $envVars['MONGO_USER']
$mongoPass = $envVars['MONGO_PASSWORD']
$cassandraHost = $envVars['CASSANDRA_HOST']

if (-not $mongoUser -or -not $mongoPass) {
    Write-Host "ERROR: MONGO_USER or MONGO_PASSWORD not set in .env" -ForegroundColor Red
    exit 1
}

Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  BATCH JOBS RUNNER" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Target date:  $Date"
Write-Host "MongoDB user: $mongoUser"
Write-Host "Cassandra:    $cassandraHost"
Write-Host ""

$cmd = @(
    'docker', 'compose', 'exec',
    '-e', "BATCH_DATE=$Date",
    '-e', "MONGO_USER=$mongoUser",
    '-e', "MONGO_PASSWORD=$mongoPass",
    '-e', "CASSANDRA_HOST=$cassandraHost",
    'spark-master',
    'bash', '/opt/spark-jobs/batch/run_batch_jobs.sh'
)

Write-Host "Running: $($cmd -join ' ')" -ForegroundColor Gray
Write-Host ""

& $cmd

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✓ Batch jobs completed successfully!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "✗ Batch jobs failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit 1
}
