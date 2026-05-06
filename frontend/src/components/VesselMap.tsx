import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { memo, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { HeatmapToggle } from './HeatmapToggle';
import { RouteFlowLayer } from './RouteFlowLayer';
import type { ShipData } from '../types';

const CARTO_DARK   = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const CARTO_VOYAGER = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

// Ship colors per theme. Dark map → warm amber stands out without blending into
// the cyan UI chrome. Light/Voyager map → deep navy is readable on the beige tiles.
const ICON_COLORS = {
  dark:  { fill: '#f97316', stroke: '#c2410c' },
  light: { fill: '#1e3a8a', stroke: '#1e3a5f' },
} as const;


/* -------------------------------------------------------------
 * Icon cache: divIcons keyed by 10° heading buckets so we don't
 * allocate fresh DOM strings every WS tick.
 * ----------------------------------------------------------- */
// Simple filled arrow — points "up" (north) in SVG space; we rotate by heading.
// Flat shape renders fast: no radial gradient, no glow layers, no shadow.
const makeShipSvg = (size: number, fill: string, stroke: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20"><polygon points="10,1 17,17 10,13 3,17" fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

// Cache keyed by heading-size-theme so swapping themes invalidates entries.
const iconCache = new Map<string, L.DivIcon>();

const getShipIcon = (heading: number, size: number, theme: 'dark' | 'light') => {
  const bucket = Math.round((((heading % 360) + 360) % 360) / 10) * 10;
  const key = `${bucket}-${size}-${theme}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const { fill, stroke } = ICON_COLORS[theme];
  const half = size / 2;
  const html = `<div style="transform:rotate(${bucket}deg);width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;">${makeShipSvg(size, fill, stroke)}</div>`;
  const icon = L.divIcon({
    className: 'custom-ship-icon',
    html,
    iconSize: [size, size],
    iconAnchor: [half, half],
  });
  iconCache.set(key, icon);
  return icon;
};

// Map zoom → icon size in pixels.
const zoomToIconSize = (zoom: number): number => {
  if (zoom <= 5)  return 14;
  if (zoom <= 7)  return 18;
  if (zoom <= 9)  return 22;
  if (zoom <= 11) return 26;
  return 30;
};

const escapeHtml = (value: unknown) => {
  if (value === null || value === undefined) return '—';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const buildPopupHtml = (ship: ShipData) => {
  const speed = typeof ship.speed === 'number' && Number.isFinite(ship.speed) ? ship.speed : 0;
  return `<div style="cursor:pointer"><strong>${escapeHtml(ship.id)}</strong><br/>Type: ${escapeHtml(
    ship.type,
  )}<br/>Speed: ${speed.toFixed(1)} kn<br/>Status: ${escapeHtml(ship.status)}</div>`;
};

/* -------------------------------------------------------------
 * Animation parameters
 * - ANIM_DURATION_MS: how long to interpolate between two WS frames.
 *   Slightly longer than the typical WS interval so motion stays smooth.
 * - TELEPORT_THRESHOLD_DEG: if a vessel jumps more than this, skip
 *   animation (treat as a fresh detection rather than a fast jet).
 * ----------------------------------------------------------- */
const ANIM_DURATION_MS = 1800;
const TELEPORT_THRESHOLD_DEG = 4;

interface AnimTarget {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  startTime: number;
  heading: number;
}

interface AnimatedShipLayerProps {
  ships: ShipData[];
  onSelectVessel?: (mmsi: string) => void;
  theme: 'dark' | 'light';
}

/**
 * Imperative leaflet layer that creates a marker per vessel once and
 * animates each marker between successive positions with rAF + setLatLng.
 * This keeps motion smooth even when WS updates arrive only every few
 * seconds, and avoids the per-tick React reconciliation cost of mounting
 * <Marker /> components for every vessel.
 */
function AnimatedShipLayer({ ships, onSelectVessel, theme }: AnimatedShipLayerProps) {
  const map = useMap();
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const targetsRef = useRef<Map<string, AnimTarget>>(new Map());
  const onSelectRef = useRef(onSelectVessel);
  const [iconSize, setIconSize] = useState(() => zoomToIconSize(map.getZoom()));

  // Keep latest click handler without re-running the sync effect.
  useEffect(() => {
    onSelectRef.current = onSelectVessel;
  }, [onSelectVessel]);

  // Update icon size when the user zooms.
  useEffect(() => {
    const onZoom = () => {
      const newSize = zoomToIconSize(map.getZoom());
      setIconSize((prev) => {
        if (prev === newSize) return prev;
        for (const [id, marker] of markersRef.current) {
          const target = targetsRef.current.get(id);
          marker.setIcon(getShipIcon(target?.heading ?? 0, newSize, theme));
        }
        return newSize;
      });
    };
    map.on('zoomend', onZoom);
    return () => { map.off('zoomend', onZoom); };
  }, [map, theme]);

  // When theme changes, refresh all existing marker icons.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const target = targetsRef.current.get(id);
      marker.setIcon(getShipIcon(target?.heading ?? 0, iconSize, theme));
    }
  }, [theme, iconSize]);

  // Sync markers to the latest ships list (add new, update target, remove gone).
  useEffect(() => {
    const seen = new Set<string>();
    const now = performance.now();

    for (const ship of ships) {
      seen.add(ship.id);
      const heading = ship.heading ?? 0;
      const popupHtml = buildPopupHtml(ship);

      let marker = markersRef.current.get(ship.id);

      if (!marker) {
        marker = L.marker([ship.lat, ship.lon], {
          icon: getShipIcon(heading, iconSize, theme),
        });
        marker.on('click', () => onSelectRef.current?.(ship.id));
        marker.bindPopup(popupHtml);
        marker.addTo(map);
        markersRef.current.set(ship.id, marker);
        targetsRef.current.set(ship.id, {
          fromLat: ship.lat,
          fromLon: ship.lon,
          toLat: ship.lat,
          toLon: ship.lon,
          startTime: now,
          heading,
        });
        continue;
      }

      const current = marker.getLatLng();
      const distance = Math.max(
        Math.abs(current.lat - ship.lat),
        Math.abs(current.lng - ship.lon),
      );
      const teleport = distance > TELEPORT_THRESHOLD_DEG;

      const prevTarget = targetsRef.current.get(ship.id);
      const headingChanged = !prevTarget || prevTarget.heading !== heading;

      targetsRef.current.set(ship.id, {
        fromLat: teleport ? ship.lat : current.lat,
        fromLon: teleport ? ship.lon : current.lng,
        toLat: ship.lat,
        toLon: ship.lon,
        startTime: now,
        heading,
      });

      if (teleport) {
        marker.setLatLng([ship.lat, ship.lon]);
      }
      if (headingChanged) {
        marker.setIcon(getShipIcon(heading, iconSize, theme));
      }
      marker.setPopupContent(popupHtml);
    }

    // Drop markers for vessels that left the live snapshot.
    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
        targetsRef.current.delete(id);
      }
    }
  }, [ships, map, theme, iconSize]);

  // rAF animation loop — runs once for the lifetime of the layer.
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const now = performance.now();
      for (const [id, t] of targetsRef.current) {
        const marker = markersRef.current.get(id);
        if (!marker) continue;

        const elapsed = now - t.startTime;
        if (elapsed >= ANIM_DURATION_MS) {
          // Snap to final position (avoid drift from float interpolation).
          if (
            marker.getLatLng().lat !== t.toLat ||
            marker.getLatLng().lng !== t.toLon
          ) {
            marker.setLatLng([t.toLat, t.toLon]);
          }
          continue;
        }

        const p = elapsed / ANIM_DURATION_MS;
        // ease-out cubic — vessels glide in toward the target nicely.
        const eased = 1 - Math.pow(1 - p, 3);
        const lat = t.fromLat + (t.toLat - t.fromLat) * eased;
        const lon = t.fromLon + (t.toLon - t.fromLon) * eased;
        marker.setLatLng([lat, lon]);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Cleanup markers on unmount.
  useEffect(() => {
    const markers = markersRef.current;
    const targets = targetsRef.current;
    return () => {
      for (const marker of markers.values()) {
        map.removeLayer(marker);
      }
      markers.clear();
      targets.clear();
    };
  }, [map]);

  return null;
}

/* -------------------------------------------------------------
 * Map
 * ----------------------------------------------------------- */
interface VesselMapProps {
  ships: ShipData[];
  onSelectVessel?: (mmsi: string) => void;
  showHeatmap?: boolean;
  showRoutes?: boolean;
  theme?: 'dark' | 'light';
}

function VesselMapBase({
  ships,
  onSelectVessel,
  showHeatmap = false,
  showRoutes = false,
  theme = 'dark',
}: VesselMapProps) {
  const [heatmapStatus, setHeatmapStatus] = useState({
    loading: false,
    empty: false,
    error: null as string | null,
  });
  const [routeStatus, setRouteStatus] = useState({
    loading: false,
    empty: false,
    error: null as string | null,
  });

  const tileUrl = theme === 'light' ? CARTO_VOYAGER : CARTO_DARK;

  return (
    <div className="map-container">
      <div className="map-notices" aria-live="polite">
        {showHeatmap && heatmapStatus.loading && <div className="map-notice">Loading heatmap…</div>}
        {showHeatmap && !heatmapStatus.loading && heatmapStatus.empty && (
          <div className="map-notice">No heatmap data yet.</div>
        )}
        {showHeatmap && heatmapStatus.error && (
          <div className="map-notice error">{heatmapStatus.error}</div>
        )}
        {showRoutes && routeStatus.loading && (
          <div className="map-notice">Loading route flows…</div>
        )}
        {showRoutes && !routeStatus.loading && routeStatus.empty && (
          <div className="map-notice">No route flows yet.</div>
        )}
        {showRoutes && routeStatus.error && (
          <div className="map-notice error">{routeStatus.error}</div>
        )}
      </div>
      <MapContainer
        center={[36.2, 10.5]}
        zoom={6}
        minZoom={4}
        maxBounds={[[-10, -50], [75, 80]]}
        maxBoundsViscosity={1.0}
        scrollWheelZoom
        zoomControl={false}
        preferCanvas
      >
        <TileLayer
          key={tileUrl}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={tileUrl}
          subdomains="abcd"
          maxZoom={19}
          updateWhenIdle
          keepBuffer={2}
        />
        <HeatmapToggle enabled={showHeatmap} onStatusChange={setHeatmapStatus} />
        <RouteFlowLayer enabled={showRoutes} onStatusChange={setRouteStatus} />
        <AnimatedShipLayer ships={ships} onSelectVessel={onSelectVessel} theme={theme} />
      </MapContainer>
    </div>
  );
}

export const VesselMap = memo(VesselMapBase);
