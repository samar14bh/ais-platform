import { memo, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchZoneTraffic } from '../api';
import type { ZoneTraffic } from '../api';
import type { ShipData } from '../types';

const resolveZone = (lat: number, lon: number) => {
  if (lat >= 35 && lat <= 42 && lon >= -6 && lon <= 0) return 'gibraltar';
  if (lat >= 36 && lat <= 40 && lon >= 0 && lon <= 5) return 'alboran';
  if (lat >= 37 && lat <= 41 && lon >= 5 && lon <= 12) return 'balearic';
  if (lat >= 36 && lat <= 42 && lon >= 12 && lon <= 20) return 'central';
  if (lat >= 35 && lat <= 40 && lon >= 20 && lon <= 27) return 'eastern';
  if (lat >= 30 && lat <= 36 && lon >= 30 && lon <= 37) return 'levant';
  return 'other';
};

interface ZoneTrafficChartProps {
  zone?: string;
  period?: 'hourly' | 'daily';
  ships?: ShipData[];
  lastUpdate?: string;
}

const zoneLabel = (zone: string) =>
  zone
    .replaceAll('_', ' ')
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const zonePalette: Record<string, string> = {
  gibraltar: 'var(--accent)',
  alboran: 'var(--accent-blue)',
  balearic: 'var(--accent-teal)',
  central: 'var(--accent-warm)',
  eastern: 'var(--accent-purple)',
  levant: 'var(--accent-lime)',
  other: 'var(--text-muted)',
};

type ZoneSeriesPoint = {
  name: string;
  [key: string]: string | number;
};

function formatTimeLabel(item: ZoneTraffic) {
  return item.hour || item.date || 'Live';
}

function ZoneTrafficChartBase({
  zone,
  period = 'hourly',
  ships = [],
  lastUpdate,
}: ZoneTrafficChartProps) {
  const [data, setData] = useState<ZoneTraffic[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadZoneTraffic = async () => {
      setLoading(true);
      setError(null);
      try {
        const traffic = await fetchZoneTraffic(period);
        if (cancelled) return;
        const filtered = zone ? traffic.filter((t) => t.zone === zone) : traffic;
        setData(filtered);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load zone traffic');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadZoneTraffic();
    return () => {
      cancelled = true;
    };
  }, [period, zone]);

  const fallbackZoneData = useMemo<ZoneTraffic[]>(() => {
    if (ships.length === 0) return [];

    return Object.values(
      ships.reduce((acc, ship) => {
        const resolvedZone = resolveZone(ship.lat, ship.lon);
        if (zone && resolvedZone !== zone) return acc;
        if (!acc[resolvedZone]) {
          acc[resolvedZone] = { zone: resolvedZone, vessel_count: 0, avg_speed: 0 };
        }
        acc[resolvedZone].vessel_count += 1;
        acc[resolvedZone].avg_speed += ship.speed || 0;
        return acc;
      }, {} as Record<string, ZoneTraffic>),
    ).map((item) => ({
      ...item,
      avg_speed: item.vessel_count > 0 ? item.avg_speed / item.vessel_count : 0,
      hour: lastUpdate || 'Live',
      message_count: item.vessel_count,
    }));
  }, [ships, zone, lastUpdate]);

  const visibleData = data.length > 0 ? data : fallbackZoneData;
  const isFallback = data.length === 0 && fallbackZoneData.length > 0;

  const zoneNames = useMemo(
    () => Array.from(new Set(visibleData.map((item) => item.zone))).sort(),
    [visibleData],
  );

  const chartData = useMemo<ZoneSeriesPoint[]>(() => {
    const grouped = new Map<string, ZoneSeriesPoint>();

    visibleData.forEach((item) => {
      const timeKey = formatTimeLabel(item);
      if (!grouped.has(timeKey)) {
        grouped.set(timeKey, { name: timeKey });
      }

      const entry = grouped.get(timeKey)!;
      const zoneKey = item.zone;
      entry[`${zoneKey}_vessels`] = item.vessel_count;
      entry[`${zoneKey}_speed`] = item.avg_speed;
      entry[`${zoneKey}_messages`] = item.message_count || 0;
      entry[`${zoneKey}_zone`] = zoneKey;
    });

    return Array.from(grouped.values());
  }, [visibleData]);

  const tooltipFormatter = (value: string | number, name: string) => {
    const [zoneName, metric] = name.split('_');
    if (metric === 'vessels') return [value, `${zoneLabel(zoneName)} vessels`];
    if (metric === 'speed') return [value, `${zoneLabel(zoneName)} avg speed`];
    if (metric === 'messages') return [value, `${zoneLabel(zoneName)} messages`];
    return [value, name];
  };

  const renderZoneLines = () =>
    zoneNames.map((zoneName) => (
      <Line
        key={zoneName}
        type="monotone"
        dataKey={`${zoneName}_vessels`}
        name={`${zoneLabel(zoneName)} vessels`}
        stroke={zonePalette[zoneName] ?? zonePalette.other}
        strokeWidth={2}
        dot={false}
        isAnimationActive={false}
      />
    ));

  if (loading) {
    return (
      <div className="chart-container">
        <p>Loading zone traffic…</p>
      </div>
    );
  }
  if (error && visibleData.length === 0) {
    return (
      <div className="chart-container">
        <p style={{ color: 'var(--danger)' }}>{error}</p>
      </div>
    );
  }
  if (visibleData.length === 0) {
    return (
      <div className="chart-container empty-chart">
        <div className="empty-chart-copy">
          <strong>No zone traffic data yet</strong>
          <p>
            Once the streaming job starts writing to <span>zone_stats</span>, this section will show
            real regional trends. For now, it is waiting for the live feed to populate vessel
            movement.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chart-container">
      {isFallback && (
        <div>
          <span className="chart-badge">Live fallback</span>
        </div>
      )}
      {zone && (
        <div style={{ marginBottom: 8 }}>
          <span className="chart-badge">Zone: {zoneLabel(zone)}</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%" minHeight={340}>
        <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" />
          <XAxis dataKey="name" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
          <YAxis stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={tooltipFormatter}
            contentStyle={{
              backgroundColor: 'var(--tooltip-bg)',
              border: '1px solid var(--tooltip-border)',
            }}
            labelStyle={{ color: 'var(--text-main)' }}
            labelFormatter={(label) => `Time: ${label}`}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {renderZoneLines()}
        </LineChart>
      </ResponsiveContainer>
      <div className="chart-details">
        <span className="chart-detail-label">Zones shown:</span>
        <span className="chart-detail-value">{zoneNames.map(zoneLabel).join(', ')}</span>
      </div>
    </div>
  );
}

export const ZoneTrafficChart = memo(ZoneTrafficChartBase);
