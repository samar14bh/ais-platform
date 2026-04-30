import type { AlertData, WebSocketMessage } from './types';

export interface ZoneTraffic {
  zone: string;
  hour?: string;
  date?: string;
  vessel_count: number;
  avg_speed: number;
  max_speed?: number;
  message_count?: number;
  peak_hour?: number;
  peak_count?: number;
}

export interface HeatmapTile {
  cell: string;
  lat: number;
  lon: number;
  count: number;
  vessels: number;
  intensity: number;
  date: string;
}

export interface RouteSegment {
  cell_from: string;
  cell_to: string;
  lat_from: number;
  lon_from: number;
  lat_to: number;
  lon_to: number;
  count: number;
  avg_speed: number;
}

export interface TrajectoryPoint {
  mmsi: number;
  recorded_at: string;
  ship_name: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  heading: number;
  nav_status: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

export const buildApiUrl = (path: string) => new URL(path, API_BASE_URL).toString();

export const buildWsUrl = () => {
  try {
    const url = new URL(API_BASE_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${url.origin}/ws/live-traffic`;
  } catch {
    return 'ws://localhost:8000/ws/live-traffic';
  }
};

export const fetchLiveSnapshot = async (signal?: AbortSignal) => {
  const response = await fetch(buildApiUrl('/api/live/vessels'), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load live vessels: ${response.status}`);
  }

  return response.json() as Promise<WebSocketMessage>;
};

export const fetchRecentAlerts = async (signal?: AbortSignal, limit = 5) => {
  const response = await fetch(buildApiUrl(`/api/alerts?limit=${limit}`), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load alerts: ${response.status}`);
  }

  const payload = await response.json() as { data?: AlertData[] };
  return payload.data ?? [];
};

export const fetchZoneTraffic = async (period: 'hourly' | 'daily', signal?: AbortSignal, limit = 50) => {
  const response = await fetch(buildApiUrl(`/api/zone-traffic/${period}?limit=${limit}`), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load zone traffic: ${response.status}`);
  }

  const payload = await response.json() as { data?: ZoneTraffic[] };
  return payload.data ?? [];
};

export const fetchHeatmap = async (date?: string, precision = 5, signal?: AbortSignal, limit = 5000) => {
  const params = new URLSearchParams({
    precision: String(precision),
    limit: String(limit),
  });
  if (date) params.append('date', date);

  const response = await fetch(buildApiUrl(`/api/heatmap?${params}`), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load heatmap: ${response.status}`);
  }

  const payload = await response.json() as { data?: HeatmapTile[] };
  return payload.data ?? [];
};

export const fetchRoutes = async (date?: string, signal?: AbortSignal, limit = 1000) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (date) params.append('date', date);

  const response = await fetch(buildApiUrl(`/api/routes?${params}`), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load routes: ${response.status}`);
  }

  const payload = await response.json() as { data?: RouteSegment[] };
  return payload.data ?? [];
};

export const fetchVesselTrajectory = async (mmsi: number, date?: string, signal?: AbortSignal, limit = 500) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (date) params.append('date', date);

  const response = await fetch(buildApiUrl(`/api/vessels/${mmsi}/trajectory?${params}`), { signal });
  if (!response.ok) {
    throw new Error(`Failed to load trajectory: ${response.status}`);
  }

  const payload = await response.json() as { data?: TrajectoryPoint[] };
  return payload.data ?? [];
};