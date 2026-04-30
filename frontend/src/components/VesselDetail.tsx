import { memo, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { X } from 'lucide-react';
import { fetchVesselTrajectory } from '../api';
import type { TrajectoryPoint } from '../api';
import type { ShipData } from '../types';

interface VesselDetailProps {
  mmsi?: string | null;
  liveShip?: ShipData | null;
  onClose?: () => void;
}

function VesselDetailBase({ mmsi, liveShip, onClose }: VesselDetailProps) {
  const [trajectory, setTrajectory] = useState<TrajectoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mmsi) return;

    let active = true;
    const abortController = new AbortController();

    const loadTrajectory = async () => {
      setLoading(true);
      setError(null);
      try {
        const points = await fetchVesselTrajectory(Number(mmsi), undefined, abortController.signal);
        if (active) setTrajectory(points);
      } catch (err) {
        if (active && !abortController.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load trajectory');
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadTrajectory();
    const refreshTimer = window.setInterval(loadTrajectory, 15000);

    return () => {
      active = false;
      abortController.abort();
      window.clearInterval(refreshTimer);
    };
  }, [mmsi]);

  const trajectoryVessel = trajectory[0];

  const vessel = useMemo(() => {
    if (liveShip) {
      return {
        mmsi: Number(liveShip.id),
        ship_name: trajectoryVessel?.ship_name,
        latitude: liveShip.lat,
        longitude: liveShip.lon,
        speed: liveShip.speed,
        course: trajectoryVessel?.course ?? 0,
        heading: liveShip.heading ?? trajectoryVessel?.heading ?? 0,
        nav_status: trajectoryVessel?.nav_status ?? 0,
      };
    }
    return trajectoryVessel;
  }, [liveShip, trajectoryVessel]);

  const chartData = useMemo(
    () =>
      trajectory
        .map((point) => ({
          time: new Date(point.recorded_at).toLocaleTimeString(),
          speed: point.speed,
        }))
        .reverse(),
    [trajectory],
  );

  if (!mmsi) return null;

  return (
    <div className="vessel-detail">
      <div className="detail-header">
        <div>
          <h2>{vessel?.ship_name || `Vessel ${mmsi}`}</h2>
          <span className="detail-live-badge">{liveShip ? 'Live snapshot' : 'Historical track'}</span>
        </div>
        <button onClick={onClose} className="close-button" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      {loading && <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading trajectory…</p>}
      {error && <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>}

      {vessel && !loading && (
        <>
          <div className="detail-stats">
            <div className="detail-stat">
              <span className="detail-stat-label">MMSI</span>
              <span className="detail-stat-value">{vessel.mmsi}</span>
            </div>
            <div className="detail-stat">
              <span className="detail-stat-label">Position</span>
              <span className="detail-stat-value">
                {vessel.latitude.toFixed(3)}, {vessel.longitude.toFixed(3)}
              </span>
            </div>
            <div className="detail-stat">
              <span className="detail-stat-label">Speed</span>
              <span className="detail-stat-value">{vessel.speed.toFixed(1)} kn</span>
            </div>
            <div className="detail-stat">
              <span className="detail-stat-label">Course</span>
              <span className="detail-stat-value">{vessel.course.toFixed(0)}°</span>
            </div>
            <div className="detail-stat">
              <span className="detail-stat-label">Heading</span>
              <span className="detail-stat-value">{vessel.heading}°</span>
            </div>
            <div className="detail-stat">
              <span className="detail-stat-label">Points</span>
              <span className="detail-stat-value">{trajectory.length}</span>
            </div>
          </div>

          {chartData.length > 1 && (
            <div className="detail-chart">
              <h4>Speed over time</h4>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData} margin={{ top: 5, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" />
                  <XAxis dataKey="time" stroke="var(--text-muted)" tick={{ fontSize: 10 }} />
                  <YAxis stroke="var(--text-muted)" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--tooltip-bg)',
                      border: '1px solid var(--tooltip-border)',
                    }}
                    labelStyle={{ color: 'var(--text-main)' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="speed"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const VesselDetail = memo(VesselDetailBase);
