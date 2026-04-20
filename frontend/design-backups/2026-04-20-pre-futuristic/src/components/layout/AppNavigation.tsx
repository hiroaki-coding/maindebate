import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { User } from '../../types';

interface AppNavigationProps {
  user: User | null;
  mobileDimmed?: boolean;
  onMobileNavInteract?: () => void;
}

type TabItem = {
  to: string;
  label: string;
  icon: string;
  show: boolean;
  isMatch?: boolean;
  isSettings?: boolean;
};

export function AppNavigation({
  user,
  mobileDimmed = false,
  onMobileNavInteract,
}: AppNavigationProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const profilePath = user ? `/user/${user.id}` : '/profile';
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);

  const legalLinks = [
    { to: '/legal/terms', label: '利用規約' },
    { to: '/legal/privacy', label: 'プライバシーポリシー' },
    { to: '/legal/cookie', label: 'Cookie・デバイス情報' },
  ];

  const sidebarItems = [
    { to: '/', label: 'Home', icon: '🏠' },
    { to: '/feed', label: 'Slide Feed', icon: '📋' },
    { to: '/matching', label: 'Match', icon: '⚔️' },
    { to: profilePath, label: 'User Profile', icon: '👤' },
  ];

  const mobileTabs: TabItem[] = [
    { to: '/', label: 'Home', icon: '🏠', show: true },
    { to: '/feed', label: 'Feed', icon: '📋', show: true },
    { to: profilePath, label: 'User', icon: '👤', show: true },
    { to: '/legal', label: '設定', icon: '⚙️', show: true, isSettings: true },
    { to: '/matching', label: 'Match', icon: '⚔️', show: true, isMatch: true },
  ];

  return (
    <>
      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:z-40 md:flex md:w-[220px] md:flex-col md:border-r md:border-[#E0E0E0] md:bg-white">
        <div className="h-[60px] flex items-center px-4 border-b border-[#E0E0E0]">
          <p className="text-lg font-semibold">LiveDebate</p>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-1">
          {sidebarItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                {
                  const forceUserActive = item.label === 'User Profile' && (location.pathname.startsWith('/user/') || location.pathname === '/profile');
                  const active = isActive || forceUserActive;
                  return `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                    active
                      ? 'border-l-2 border-[var(--color-pro)] bg-[var(--color-pro-bg)] text-[var(--color-pro)]'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`;
                }
              }
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[#E0E0E0] p-4">
          {user ? (
            <>
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-[var(--color-pro-bg)] grid place-items-center text-[var(--color-pro)] font-semibold">
                  {user.displayName.slice(0, 1)}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.displayName}</p>
                  <p className="text-xs text-slate-500">{user.rank.toUpperCase()}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-slate-600 space-x-2">
                <Link to="/login" className="text-[var(--color-pro)]">ログイン</Link>
                <span>/</span>
                <Link to="/register" className="text-[var(--color-pro)]">新規登録</Link>
              </div>
            </>
          )}
        </div>
      </aside>

      <nav
        className={`fixed bottom-0 left-0 right-0 z-[90] border-t border-[#E0E0E0] bg-white transition-opacity md:hidden ${
          mobileDimmed ? 'opacity-60 bg-white/95 backdrop-blur-sm' : 'opacity-100'
        }`}
        onPointerDown={() => onMobileNavInteract?.()}
      >
        <div className="relative mx-auto flex h-14 max-w-xl items-center justify-around">
          {mobileSettingsOpen && (
            <div className="absolute bottom-[58px] right-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
              {legalLinks.map((link) => (
                <button
                  key={link.to}
                  type="button"
                  className="block w-full rounded-lg px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    setMobileSettingsOpen(false);
                    navigate(link.to);
                  }}
                >
                  {link.label}
                </button>
              ))}
            </div>
          )}

          {mobileTabs
            .filter((tab) => tab.show)
            .map((tab) => {
              const active = tab.label === 'User'
                ? location.pathname.startsWith('/user/') || location.pathname === '/profile'
                : tab.isSettings
                  ? location.pathname.startsWith('/legal/') || mobileSettingsOpen
                : location.pathname === tab.to;

              if (tab.isMatch) {
                return (
                  <button
                    key={tab.to}
                    type="button"
                    onClick={() => {
                      setMobileSettingsOpen(false);
                      navigate(tab.to);
                    }}
                    className="absolute -top-5 left-1/2 -translate-x-1/2 h-12 w-12 rounded-full bg-[var(--color-pro)] text-white shadow-lg"
                    aria-label={tab.label}
                  >
                    {tab.icon}
                  </button>
                );
              }

              if (tab.isSettings) {
                return (
                  <button
                    key={tab.label}
                    type="button"
                    onClick={() => setMobileSettingsOpen((prev) => !prev)}
                    className={`flex flex-col items-center justify-center text-[11px] ${active ? 'text-[var(--color-pro)]' : 'text-slate-500'}`}
                    aria-expanded={mobileSettingsOpen}
                    aria-label="法的情報メニュー"
                  >
                    <span className="text-sm">{tab.icon}</span>
                    <span>{tab.label}</span>
                  </button>
                );
              }

              return (
                <button
                  key={tab.to}
                  type="button"
                  onClick={() => {
                    setMobileSettingsOpen(false);
                    navigate(tab.to);
                  }}
                  className={`flex flex-col items-center justify-center text-[11px] ${active ? 'text-[var(--color-pro)]' : 'text-slate-500'}`}
                >
                  <span className="text-sm">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
        </div>
      </nav>
    </>
  );
}
