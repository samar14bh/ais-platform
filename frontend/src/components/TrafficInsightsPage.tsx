import { memo, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchHeatmap, fetchZoneTraffic } from '../api';
import type { HeatmapTile, ZoneTraffic } from '../api';
import { ZoneTrafficChart } from './ZoneTrafficChart';
import type { ShipData } from '../types';

interface TrafficInsightsPageProps {
  ships: ShipData[];
  lastUpdate?: string;
}

interface HeatmapStats {
  p5: HeatmapTile[];
  p6: HeatmapTile[];
}

const piePalette = [
  'var(--accent)',
  'var(--accent-blue)',
  'var(--accent-teal)',
  'var(--accent-warm)',
  'var(--accent-purple)',
  'var(--accent-lime)',
];

const zoneLabel = (zone: string) =>
  zone
    .replaceAll('_', ' ')
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const formatPercent = (value: number) => `${value.toFixed(1)}%`;

function buildZoneShareData(rows: ZoneTraffic[]) {
  const total = rows.reduce((sum, row) => sum + (row.vessel_count || 0), 0);
  return rows
    .map((row) => ({
      name: zoneLabel(row.zone),
      value: row.vessel_count,
      percent: total > 0 ? (row.vessel_count / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

function buildHeatmapSummary(tiles: HeatmapTile[]) {
  const cellCount = tiles.length;
  const totalMessages = tiles.reduce((sum, tile) => sum + tile.count, 0);
  const totalVessels = tiles.reduce((sum, tile) => sum + tile.vessels, 0);
  const avgIntensity = cellCount > 0 ? tiles.reduce((sum, tile) => sum + tile.intensity, 0) / cellCount : 0;
  const hottest = tiles[0] ?? null;

  return {
    cellCount,
    totalMessages,
    totalVessels,
    avgIntensity,
    hottest,
  };
}

function TrafficInsightsPageBase({ ships, lastUpdate }: TrafficInsightsPageProps) {
  const [dailyTraffic, setDailyTraffic] = useState<ZoneTraffic[]>([]);
  const [heatmapStats, setHeatmapStats] = useState<HeatmapStats>({ p5: [], p6: [] });
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadStats = async () => {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const [daily, p5, p6] = await Promise.all([
          fetchZoneTraffic('daily'),
          fetchHeatmap(undefined, 5),
          fetchHeatmap(undefined, 6),
        ]);

        if (cancelled) return;

        setDailyTraffic(daily);
        setHeatmapStats({ p5, p6 });
      } catch (error) {
        if (!cancelled) {
          setStatsError(error instanceof Error ? error.message : 'Failed to load traffic insights');
        }
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };

    loadStats();
    return () => {
      cancelled = true;
    };
  }, []);

  const zoneShareData = useMemo(() => buildZoneShareData(dailyTraffic), [dailyTraffic]);
  const heatmapP5Summary = useMemo(() => buildHeatmapSummary(heatmapStats.p5), [heatmapStats.p5]);
  const heatmapP6Summary = useMemo(() => buildHeatmapSummary(heatmapStats.p6), [heatmapStats.p6]);

  return (
    <div className="traffic-insights-page">
      <section className="surface insight-banner">
        <div>
          <span className="eyebrow">Traffic insight</span>
          <h2>Zone traffic collections</h2>
          <p>
            The charts below read from the hourly and daily zone traffic collections and show
            each zone separately so you can compare regional activity at a glance.
          </p>
        </div>
        <div className="insight-banner-meta">
          <span className="chart-badge">Hourly + daily graphs</span>
          <span className="surface-meta">
            {lastUpdate ? `Last live vessel update: ${lastUpdate}` : 'Waiting for live feed…'}
          </span>
          <span className="insight-zones">Zones: Gibraltar, Alboran, Balearic, Central, Eastern, Levant</span>
        </div>
      </section>

      <section className="surface insight-summary">
        <div className="surface-head">
          <div>
            <span className="eyebrow">Daily distribution</span>
            <h2>Zone share</h2>
          </div>
          <span className="surface-meta">Based on zone_traffic_daily vessel counts</span>
        </div>

        {statsLoading && zoneShareData.length === 0 ? (
          <div className="summary-state">Loading insight stats…</div>
        ) : statsError && zoneShareData.length === 0 ? (
          <div className="summary-state error">{statsError}</div>
        ) : zoneShareData.length === 0 ? (
          <div className="summary-state">No daily data yet — run batch jobs first.</div>
        ) : (
          <ResponsiveContainer width="100%" height={zoneShareData.length * 44 + 16}>
            <BarChart
              data={zoneShareData}
              layout="vertical"
              margin={{ top: 0, right: 64, bottom: 0, left: 0 }}
              barCategoryGap="28%"
            >
              <XAxis
                type="number"
                hide
                domain={[0, 'dataMax']}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={130}
                tick={{ fontSize: 13, fill: 'var(--text-main)', fontWeight: 600 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--bg-soft)' }}
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg)',
                  border: '1px solid var(--tooltip-border)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 12,
                }}
                formatter={(value: number, _: string, entry: { payload?: { percent?: number } }) => [
                  `${value} vessels (${formatPercent(entry.payload?.percent ?? 0)})`,
                  'Vessels',
                ]}
              />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                {zoneShareData.map((entry, index) => (
                  <Cell key={entry.name} fill={piePalette[index % piePalette.length]} />
                ))}
                <LabelList
                  dataKey="percent"
                  position="right"
                  formatter={(v: number) => formatPercent(v)}
                  style={{ fontSize: 12, fill: 'var(--text-muted)', fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="surface insight-summary">
        <div className="surface-head">
          <div>
            <span className="eyebrow">Heatmap stats</span>
            <h2>Grid density overview</h2>
          </div>
          <span className="surface-meta">Precision-5 and precision-6 collections</span>
        </div>

        <div className="heatmap-stats-grid">
          <div className="stat-tile">
            <span className="detail-stat-label">P5 cells</span>
            <span className="detail-stat-value">{heatmapP5Summary.cellCount}</span>
          </div>
          <div className="stat-tile">
            <span className="detail-stat-label">P6 cells</span>
            <span className="detail-stat-value">{heatmapP6Summary.cellCount}</span>
          </div>
          <div className="stat-tile">
            <span className="detail-stat-label">Total messages</span>
            <span className="detail-stat-value">
              {heatmapP5Summary.totalMessages + heatmapP6Summary.totalMessages}
            </span>
          </div>
          <div className="stat-tile">
            <span className="detail-stat-label">Total vessels</span>
            <span className="detail-stat-value">
              {heatmapP5Summary.totalVessels + heatmapP6Summary.totalVessels}
            </span>
          </div>
          <div className="stat-tile">
            <span className="detail-stat-label">Avg intensity</span>
            <span className="detail-stat-value">
              {((heatmapP5Summary.avgIntensity + heatmapP6Summary.avgIntensity) / 2).toFixed(2)}
            </span>
          </div>
          <div className="stat-tile">
            <span className="detail-stat-label">Hottest cell</span>
            <span className="detail-stat-value">
              {heatmapP5Summary.hottest?.cell ?? heatmapP6Summary.hottest?.cell ?? '—'}
            </span>
          </div>
        </div>
      </section>

      <div className="insights-grid">
        <section className="surface insight-card">
          <div className="surface-head">
            <div>
              <span className="eyebrow">Hourly collection</span>
              <h2>Zone traffic by hour</h2>
            </div>
            <span className="surface-meta">Collection: zone_traffic_hourly</span>
          </div>
          <ZoneTrafficChart ships={ships} lastUpdate={lastUpdate} period="hourly" />
        </section>

        <section className="surface insight-card">
          <div className="surface-head">
            <div>
              <span className="eyebrow">Daily collection</span>
              <h2>Zone traffic by day</h2>
            </div>
            <span className="surface-meta">Collection: zone_traffic_daily</span>
          </div>
          <ZoneTrafficChart ships={ships} lastUpdate={lastUpdate} period="daily" />
        </section>
      </div>
    </div>
  );
}

export const TrafficInsightsPage = memo(TrafficInsightsPageBase);