import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { memo, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { HeatmapToggle } from './HeatmapToggle';
import { RouteFlowLayer } from './RouteFlowLayer';
import type { ShipData } from '../types';

/* -------------------------------------------------------------
 * Icon cache: divIcons keyed by 10° heading buckets so we don't
 * allocate fresh DOM strings every WS tick.
 * ----------------------------------------------------------- */
const SHIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/><path d="M12 10v4"/><path d="M12 2v3"/></svg>`;

const iconCache = new Map<number, L.DivIcon>();

const getShipIcon = (heading: number) => {
  const bucket = Math.round((((heading % 360) + 360) % 360) / 10) * 10;
  const cached = iconCache.get(bucket);
  if (cached) return cached;

  const html = `<div style="transform: rotate(${bucket}deg); width: 30px; height: 30px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.25), rgba(34,211,238,0.25) 40%, rgba(15,23,42,0.95) 75%); border: 1px solid rgba(103,232,249,0.6); box-shadow: 0 0 0 4px rgba(34,211,238,0.1), 0 8px 16px rgba(2,8,23,0.4); display:flex; align-items:center; justify-content:center; color:#e2f5ff;">${SHIP_SVG}</div>`;
  const icon = L.divIcon({
    className: 'custom-ship-icon',
    html,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  iconCache.set(bucket, icon);
  return icon;
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
}

/**
 * Imperative leaflet layer that creates a marker per vessel once and
 * animates each marker between successive positions with rAF + setLatLng.
 * This keeps motion smooth even when WS updates arrive only every few
 * seconds, and avoids the per-tick React reconciliation cost of mounting
 * <Marker /> components for every vessel.
 */
function AnimatedShipLayer({ ships, onSelectVessel }: AnimatedShipLayerProps) {
  const map = useMap();
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const targetsRef = useRef<Map<string, AnimTarget>>(new Map());
  const onSelectRef = useRef(onSelectVessel);

  // Keep latest click handler without re-running the sync effect.
  useEffect(() => {
    onSelectRef.current = onSelectVessel;
  }, [onSelectVessel]);

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
          icon: getShipIcon(heading),
          // Built-in marker drag-to-target pan can interfere; keep default.
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

      // Start the new animation from the marker's CURRENT screen position
      // (which may be mid-interp), so motion is continuous.
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
        marker.setIcon(getShipIcon(heading));
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
  }, [ships, map]);

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
}

function VesselMapBase({
  ships,
  onSelectVessel,
  showHeatmap = false,
  showRoutes = false,
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
        scrollWheelZoom
        zoomControl={false}
        preferCanvas
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="dark-tiles"
          updateWhenIdle
          keepBuffer={2}
        />
        <HeatmapToggle enabled={showHeatmap} onStatusChange={setHeatmapStatus} />
        <RouteFlowLayer enabled={showRoutes} onStatusChange={setRouteStatus} />
        <AnimatedShipLayer ships={ships} onSelectVessel={onSelectVessel} />
      </MapContainer>
    </div>
  );
}

export const VesselMap = memo(VesselMapBase);
