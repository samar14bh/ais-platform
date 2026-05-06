import 'leaflet/dist/leaflet.css';
import './App.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Radio, SunMedium } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { VesselMap } from './components/VesselMap';
import { TrafficInsightsPage } from './components/TrafficInsightsPage';
import { VesselDetail } from './components/VesselDetail';
import { buildWsUrl, fetchLiveSnapshot, fetchRecentAlerts } from './api';
import type { AlertData, ShipData, WebSocketMessage } from './types';

type ThemeMode = 'dark' | 'light';

const getInitialTheme = (): ThemeMode => {
  if (typeof window === 'undefined') return 'dark';

  const storedTheme = window.localStorage.getItem('oceanwatch-theme');
  if (storedTheme === 'dark' || storedTheme === 'light') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

interface KpiChipProps {
  label: string;
  value: string | number;
  tone?: 'default' | 'live' | 'offline';
}

function KpiChip({ label, value, tone = 'default' }: KpiChipProps) {
  return (
    <div className={`kpi-chip kpi-tone-${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
}

function App() {
  const [ships, setShips] = useState<ShipData[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [alerts, setAlerts] = useState<AlertData[]>([]);
  const [avgSpeed, setAvgSpeed] = useState<number>(0);
  const [selectedVesselMmsi, setSelectedVesselMmsi] = useState<string | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  const selectedShip = useMemo(
    () => (selectedVesselMmsi ? ships.find((ship) => ship.id === selectedVesselMmsi) ?? null : null),
    [ships, selectedVesselMmsi],
  );

  const wsUrl = useMemo(() => buildWsUrl(), []);

  // Throttle WS updates: coalesce bursts into a single React render at most every 200ms.
  const pendingMessageRef = useRef<WebSocketMessage | null>(null);
  const flushScheduledRef = useRef<number | null>(null);

  const handleToggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleSelectVessel = useCallback((mmsi: string) => {
    setSelectedVesselMmsi(mmsi);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedVesselMmsi(null);
  }, []);

  const handleShowDashboard = useCallback(() => {
    setShowInsights(false);
  }, []);

  const handleShowInsights = useCallback(() => {
    setShowInsights(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    window.localStorage.setItem('oceanwatch-theme', theme);
    root.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    const abortController = new AbortController();

    const loadInitialData = async () => {
      try {
        const [liveData, recentAlerts] = await Promise.all([
          fetchLiveSnapshot(abortController.signal),
          fetchRecentAlerts(abortController.signal),
        ]);

        setShips(liveData.data);
        setAvgSpeed(liveData.average_speed ?? 0);
        setLastUpdate(new Date(liveData.timestamp).toLocaleTimeString());
        setAlerts(recentAlerts);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Initial data load failed', error);
        }
      }
    };

    loadInitialData();

    let aborted = false;
    const ws = new WebSocket(wsUrl);

    const flush = () => {
      flushScheduledRef.current = null;
      const message = pendingMessageRef.current;
      pendingMessageRef.current = null;
      if (!message || aborted) return;

      setShips(message.data);
      setAvgSpeed(
        message.average_speed ??
          (message.data.length > 0
            ? message.data.reduce((acc, ship) => acc + ship.speed, 0) / message.data.length
            : 0),
      );
      setLastUpdate(new Date(message.timestamp).toLocaleTimeString());
    };

    ws.onopen = () => {
      if (aborted) {
        // Cleanup ran while we were still connecting — close cleanly now.
        ws.close();
        return;
      }
      setIsConnected(true);
    };
    ws.onmessage = (event) => {
      if (aborted) return;
      try {
        pendingMessageRef.current = JSON.parse(event.data) as WebSocketMessage;
      } catch (err) {
        console.error('Bad WS payload', err);
        return;
      }
      if (flushScheduledRef.current === null) {
        flushScheduledRef.current = window.setTimeout(flush, 200);
      }
    };
    ws.onclose = () => {
      if (!aborted) setIsConnected(false);
    };
    ws.onerror = () => {
      if (!aborted) setIsConnected(false);
    };

    return () => {
      aborted = true;
      abortController.abort();
      if (flushScheduledRef.current !== null) {
        window.clearTimeout(flushScheduledRef.current);
        flushScheduledRef.current = null;
      }
      pendingMessageRef.current = null;
      // Only close if already OPEN. If still CONNECTING, the onopen handler
      // above will close it on its own (avoids the noisy "closed before
      // established" warning under React StrictMode double-mount).
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [wsUrl]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-logo">
            <Radio size={20} />
          </div>
          <div className="brand-text">
            <strong>OceanWatch</strong>
            <span>Maritime live ops</span>
          </div>
        </div>

        <div className="topbar-kpis">
          <KpiChip label="Vessels" value={ships.length} />
          <KpiChip label="Avg speed" value={`${avgSpeed.toFixed(1)} kn`} />
          <KpiChip label="Updated" value={lastUpdate || '—'} />
          <KpiChip
            label="Feed"
            value={isConnected ? 'Live' : 'Offline'}
            tone={isConnected ? 'live' : 'offline'}
          />
        </div>

        <div className="topbar-actions">
          <div className="topbar-nav" role="tablist" aria-label="Main views">
            <button
              type="button"
              className={`view-tab ${!showInsights ? 'active' : ''}`}
              onClick={handleShowDashboard}
              aria-pressed={!showInsights}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={`view-tab ${showInsights ? 'active' : ''}`}
              onClick={handleShowInsights}
              aria-pressed={showInsights}
            >
              Traffic insights
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={handleToggleTheme}
            aria-label="Toggle theme"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <SunMedium size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Sidebar
          ships={ships}
          alerts={alerts}
          lastUpdate={lastUpdate}
          onSelectVessel={handleSelectVessel}
          showHeatmap={showHeatmap}
          onToggleHeatmap={setShowHeatmap}
          showRoutes={showRoutes}
          onToggleRoutes={setShowRoutes}
        />

        <section className="workspace">
          <div className="surface map-surface">
            <div className="surface-head">
              <div>
                <span className="eyebrow">Live map</span>
                <h2>Fleet movement</h2>
              </div>
              <span className="surface-meta">
                {lastUpdate ? `Refreshed ${lastUpdate}` : 'Waiting for feed…'}
              </span>
            </div>

            <VesselMap
              ships={ships}
              onSelectVessel={handleSelectVessel}
              showHeatmap={showHeatmap}
              showRoutes={showRoutes}
              theme={theme}
            />
          </div>
        </section>
      </main>

      {showInsights && (
        <div className="insights-overlay">
          <TrafficInsightsPage ships={ships} lastUpdate={lastUpdate} />
        </div>
      )}

      {selectedVesselMmsi && (
        <VesselDetail
          mmsi={selectedVesselMmsi}
          liveShip={selectedShip}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}

export default App;
