import { Moon, Radio, SunMedium } from 'lucide-react';

interface HeaderProps {
  isConnected: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Header({ isConnected, theme, onToggleTheme }: HeaderProps) {
  return (
    <header className="header glass-panel">
      <div>
        <div className="header-title">
          <Radio size={28} />
          <span>OceanWatchAI</span>
        </div>
        <div className="header-subtitle">Maritime live operations console</div>
      </div>
      <div className="header-actions">
        <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? <SunMedium size={18} /> : <Moon size={18} />}
          <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
        </button>

        <div className={`status-indicator ${isConnected ? '' : 'disconnected'}`}>
          <div
            className="pulse-dot"
            style={{
              backgroundColor: isConnected ? 'var(--success-green)' : 'var(--danger-red)',
              boxShadow: `0 0 8px ${isConnected ? 'var(--success-green)' : 'var(--danger-red)'}`,
            }}
          />
          {isConnected ? 'LIVE FEED ACTIVE' : 'CONNECTION LOST'}
        </div>
      </div>
    </header>
  );
}