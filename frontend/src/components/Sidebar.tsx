import { memo, useCallback, type ChangeEvent } from 'react';
import { MapPin, Route, TriangleAlert } from 'lucide-react';
import type { AlertData, ShipData } from '../types';

interface SidebarProps {
  ships: ShipData[];
  alerts: AlertData[];
  lastUpdate: string;
  onSelectVessel?: (mmsi: string) => void;
  showHeatmap?: boolean;
  onToggleHeatmap?: (enabled: boolean) => void;
  showRoutes?: boolean;
  onToggleRoutes?: (enabled: boolean) => void;
}

const ShipRow = memo(function ShipRow({
  ship,
  onSelect,
}: {
  ship: ShipData;
  onSelect?: (id: string) => void;
}) {
  const handleClick = useCallback(() => onSelect?.(ship.id), [ship.id, onSelect]);

  return (
    <button type="button" className="ship-row" onClick={handleClick}>
      <div>
        <div className="ship-id">{ship.id}</div>
        <div className="ship-meta">
          {ship.type} · {ship.status}
        </div>
      </div>
      <span className="ship-speed">{ship.speed.toFixed(1)} kn</span>
    </button>
  );
});

const AlertRow = memo(function AlertRow({ alert }: { alert: AlertData }) {
  const sev = alert.severity.toLowerCase();
  return (
    <div className={`alert-row severity-${sev}`}>
      <div className="alert-main">
        <span className={`alert-pill severity-${sev}`}>{alert.severity}</span>
        <span className="alert-type">{alert.type}</span>
        <span className="alert-vessel">{alert.ship_name ?? alert.mmsi}</span>
      </div>
      <span className="alert-time">{new Date(alert.timestamp).toLocaleTimeString()}</span>
    </div>
  );
});

function SidebarBase({
  ships,
  alerts,
  lastUpdate,
  onSelectVessel,
  showHeatmap = false,
  onToggleHeatmap,
  showRoutes = false,
  onToggleRoutes,
}: SidebarProps) {
  const handleHeatmap = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onToggleHeatmap?.(e.target.checked),
    [onToggleHeatmap],
  );
  const handleRoutes = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onToggleRoutes?.(e.target.checked),
    [onToggleRoutes],
  );

  return (
    <aside className="sidebar">
      <section className="panel">
        <div className="panel-head">
          <h3>Layer controls</h3>
          <div className="panel-head-icon">
            <MapPin size={14} />
          </div>
        </div>
        <div className="controls-list">
          <label className="control-row">
            <input type="checkbox" checked={showHeatmap} onChange={handleHeatmap} />
            <MapPin size={16} />
            <span>Heatmap layer</span>
          </label>
          <label className="control-row">
            <input type="checkbox" checked={showRoutes} onChange={handleRoutes} />
            <Route size={16} />
            <span>Route flows</span>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Recent alerts</h3>
          <div className="panel-head-icon">
            <TriangleAlert size={14} />
          </div>
        </div>
        <div className="alerts-list">
          {alerts.length === 0 && <span className="empty-state">No active alerts.</span>}
          {alerts.map((alert) => (
            <AlertRow key={alert.alert_id} alert={alert} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Vessel tracker</h3>
          </div>
          <span className="panel-meta">
            {lastUpdate ? `Updated ${lastUpdate}` : 'Waiting…'}
          </span>
        </div>

        {ships.length === 0 ? (
          <span className="empty-state">Waiting for data…</span>
        ) : (
          <div className="ship-scroll">
            {ships.map((ship) => (
              <ShipRow key={ship.id} ship={ship} onSelect={onSelectVessel} />
            ))}
          </div>
        )}

      </section>
    </aside>
  );
}

export const Sidebar = memo(SidebarBase);
