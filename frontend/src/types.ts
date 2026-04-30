export interface ShipData {
  id: string;
  lat: number;
  lon: number;
  type: string;
  speed: number;
  status: string;
  heading?: number;
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