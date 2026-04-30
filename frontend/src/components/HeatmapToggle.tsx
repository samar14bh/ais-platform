import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { fetchHeatmap } from '../api';

interface HeatmapToggleProps {
  enabled?: boolean;
  date?: string;
  precision?: 5 | 6;
  onStatusChange?: (status: {
    loading: boolean;
    empty: boolean;
    error: string | null;
  }) => void;
}

/**
 * Heat palette — cyan (calm) → red (very busy).
 */
const HEAT_STOPS: Array<{ t: number; r: number; g: number; b: number }> = [
  { t: 0.0,  r: 34,  g: 211, b: 238 },  // cyan
  { t: 0.25, r: 56,  g: 189, b: 248 },  // sky blue
  { t: 0.5,  r: 132, g: 204, b: 22  },  // lime
  { t: 0.75, r: 251, g: 191, b: 36  },  // amber
  { t: 1.0,  r: 239, g: 68,  b: 68  },  // red
];

const interpolateHeat = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const a = HEAT_STOPS[i];
    const b = HEAT_STOPS[i + 1];
    if (c >= a.t && c <= b.t) {
      const local = (c - a.t) / (b.t - a.t);
      return {
        r: Math.round(a.r + (b.r - a.r) * local),
        g: Math.round(a.g + (b.g - a.g) * local),
        b: Math.round(a.b + (b.b - a.b) * local),
      };
    }
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1];
  return { r: last.r, g: last.g, b: last.b };
};

/**
 * Geohash cell dimensions in DEGREES (full cell width × height).
 * Backend uses geohash2 → these are the canonical cell sizes:
 *   p5 → 0.0439° × 0.0439°  (≈ 4.89 km × 4.89 km, square)
 *   p6 → 0.0110° × 0.00549° (≈ 1.22 km × 0.61 km, twice as wide as tall)
 *
 * Reference: geohash bit allocation alternates lon/lat. p5 = 25 bits
 * (13 lon + 12 lat) → 360/8192 × 180/4096. p6 = 30 bits (15 + 15) →
 * 360/32768 × 180/32768.
 */
const CELL_DIMS: Record<5 | 6, { lat: number; lon: number }> = {
  5: { lat: 0.0439453125, lon: 0.0439453125 },
  6: { lat: 0.0054931640625, lon: 0.010986328125 },
};

export function HeatmapToggle({
  enabled = false,
  date,
  precision = 5,
  onStatusChange,
}: HeatmapToggleProps) {
  const map = useMap();
  const layerGroupRef = useRef<L.FeatureGroup | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (layerGroupRef.current) {
        map.removeLayer(layerGroupRef.current);
        layerGroupRef.current = null;
      }
      onStatusChange?.({ loading: false, empty: false, error: null });
      return;
    }

    let cancelled = false;
    onStatusChange?.({ loading: true, empty: false, error: null });

    const loadAndRender = async () => {
      try {
        // Try requested precision; if empty AND we asked for p5, try p6.
        // We must remember which precision actually returned data so we
        // size the rectangles correctly.
        let actualPrecision: 5 | 6 = precision;
        let heatmapTiles = await fetchHeatmap(date, precision);
        if (heatmapTiles.length === 0 && precision === 5) {
          heatmapTiles = await fetchHeatmap(date, 6);
          actualPrecision = 6;
        }
        if (cancelled) return;

        if (layerGroupRef.current) {
          map.removeLayer(layerGroupRef.current);
          layerGroupRef.current = null;
        }

        if (heatmapTiles.length === 0) {
          onStatusChange?.({ loading: false, empty: true, error: null });
          return;
        }

        const dims = CELL_DIMS[actualPrecision];
        const halfLat = dims.lat / 2;
        const halfLon = dims.lon / 2;

        const group = L.featureGroup();

        for (const tile of heatmapTiles) {
          const intensity = Math.max(0, Math.min(1, tile.intensity ?? 0));
          if (
            typeof tile.lat !== 'number' ||
            typeof tile.lon !== 'number' ||
            !Number.isFinite(tile.lat) ||
            !Number.isFinite(tile.lon)
          ) {
            continue;
          }

          const { r, g, b } = interpolateHeat(intensity);
          const bounds: L.LatLngBoundsExpression = [
            [tile.lat - halfLat, tile.lon - halfLon],
            [tile.lat + halfLat, tile.lon + halfLon],
          ];

          const rect = L.rectangle(bounds, {
            stroke: false,
            fillColor: `rgb(${r}, ${g}, ${b})`,
            // Faint cells stay subtle; busy cells pop.
            fillOpacity: 0.25 + intensity * 0.55, // 0.25 → 0.80
          });

          rect.bindTooltip(
            `<strong>Activity</strong><br/>` +
              `Intensity: ${(intensity * 100).toFixed(0)}%<br/>` +
              `Vessels: ${tile.vessels ?? 0}<br/>` +
              `Messages: ${tile.count ?? 0}`,
            { sticky: true, direction: 'top' },
          );

          group.addLayer(rect);
        }

        map.addLayer(group);
        layerGroupRef.current = group;
        onStatusChange?.({
          loading: false,
          empty: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load heatmap:', error);
        onStatusChange?.({
          loading: false,
          empty: false,
          error: error instanceof Error ? error.message : 'Failed to load heatmap',
        });
      }
    };

    loadAndRender();

    return () => {
      cancelled = true;
    };
  }, [enabled, date, precision, map, onStatusChange]);

  return null;
}
