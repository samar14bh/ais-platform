import { useEffect, useState } from 'react';
import { Polyline, Tooltip } from 'react-leaflet';
import { fetchRoutes } from '../api';
import type { RouteSegment } from '../api';

interface RouteFlowLayerProps {
  enabled?: boolean;
  date?: string;
  minCount?: number;
  onStatusChange?: (status: {
    loading: boolean;
    empty: boolean;
    error: string | null;
  }) => void;
}

export function RouteFlowLayer({ enabled = false, date, minCount = 1, onStatusChange }: RouteFlowLayerProps) {
  const [routes, setRoutes] = useState<RouteSegment[]>([]);

  useEffect(() => {
    if (!enabled) {
      onStatusChange?.({ loading: false, empty: false, error: null });
      return;
    }

    let cancelled = false;
    onStatusChange?.({ loading: true, empty: false, error: null });

    const loadRoutes = async () => {
      try {
        const routeSegments = await fetchRoutes(date);
        const filtered = routeSegments.filter((r) =>
          r.count >= minCount
          && Number.isFinite(r.lat_from)
          && Number.isFinite(r.lon_from)
          && Number.isFinite(r.lat_to)
          && Number.isFinite(r.lon_to)
          && r.avg_speed !== null
          && Number.isFinite(r.avg_speed)
        );
        if (cancelled) {
          return;
        }

        setRoutes(filtered);
        onStatusChange?.({ loading: false, empty: filtered.length === 0, error: null });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setRoutes([]);
        console.error('Failed to load routes:', error);
        onStatusChange?.({
          loading: false,
          empty: false,
          error: error instanceof Error ? error.message : 'Failed to load route flows',
        });
      }
    };

    loadRoutes();

    return () => {
      cancelled = true;
    };
  }, [enabled, date, minCount, onStatusChange]);

  if (!enabled || routes.length === 0) return null;

  return (
    <>
      {routes.map((route, idx) => {
        const positions: [number, number][] = [
          [route.lat_from, route.lon_from],
          [route.lat_to, route.lon_to],
        ];

        const intensity = Math.min(route.count / 100, 1);
        const weight = 1 + intensity * 3;
        const opacity = 0.5 + intensity * 0.5;

        return (
          <Polyline
            key={`${route.cell_from}-${route.cell_to}-${idx}`}
            positions={positions}
            color="rgba(59, 130, 246, 0.8)"
            weight={weight}
            opacity={opacity}
            dashArray="5, 5"
          >
            <Tooltip sticky>
              Route Segment: {route.count} crossings, avg speed {route.avg_speed ? route.avg_speed.toFixed(1) : 'N/A'} kn
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}
