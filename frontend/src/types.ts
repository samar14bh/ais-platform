export interface ShipData {
  id: string;
  mmsi: string;
  ship_name?: string;
  lat: number;
  lon: number;
  speed: number;
  course?: number;
  heading?: number;
  nav_status?: number;
  status: string;
  updated_at?: string;
}

export interface WebSocketMessage {
  timestamp: string;
  total_ships: number;
  average_speed?: number;
  data: ShipData[];
}

export interface AlertData {
  alert_id: string;
  type: string;
  severity: string;
  mmsi: string;
  ship_name?: string;
  timestamp: string;
  resolved: boolean;
}