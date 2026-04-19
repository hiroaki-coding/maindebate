import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError, adminApi } from '../lib/api';

type TabKey = 'dashboard' | 'users' | 'topics' | 'reports' | 'settings' | 'logs';

type Phase = 'checking' | 'denied' | 'login' | 'ready';

const SESSION_KEY = 'admin_secure_session';

export function AdminDashboardPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');

  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [dashboard, setDashboard] = useState<{
    totalUsers: number;
    registrations24h: number;
    registrations7d: number;
    pendingReports: number;
    growth30d: Array<{ date: string; count: number }>;
  } | null>(null);

  const [users, setUsers] = useState<Array<{
    id: string;
    display_name: string;
    rank: string;
    points: number;
    is_banned: boolean;
    banned_reason?: string | null;
    created_at: string;
  }>>([]);
  const [userSearch, setUserSearch] = useState('');

  const [topics, setTopics] = useState<Array<{
    id: string;
    title: string;
    description?: string | null;
    category?: string | null;
    is_active: boolean;
    created_at: string;
  }>>([]);

  const [reports, setReports] = useState<Array<{
    id: string;
    reporter_id: string;
    target_type: 'comment' | 'debate';
    target_id: string;
    reason: string;
    detail?: string | null;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
  }>>([]);

  const [settings, setSettings] = useState<Array<{
    rank: string;
    threshold: number;
    multiplier: number;
    banner_from: string;
    banner_to: string;
    badge_color: string;
    position: number;
  }>>([]);

  const [logs, setLogs] = useState<Array<{
    id: string;
    admin_user_id: string;
    action: string;
    target_type?: string | null;
    target_id?: string | null;
    ip_address?: string | null;
    detail?: Record<string, unknown> | null;
    created_at: string;
  }>>([]);

  const expiryLabel = useMemo(() => {
    if (!expiresAt) return '-';
    return new Date(expiresAt).toLocaleString();
  }, [expiresAt]);

  const clearSession = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setSessionToken('');
    setExpiresAt('');
    setPhase('login');
  };

  const loadAll = async (token: string) => {
    const [dash, userRows, topicRows, reportRows, rankRows, logRows] = await Promise.all([
      adminApi.getDashboard(token),
      adminApi.listUsers(token),
      adminApi.listTopics(token),
      adminApi.listReports(token),
      adminApi.getRankSettings(token),
      adminApi.getLogs(token, 120),
    ]);

    setDashboard(dash);
    setUsers(userRows.users);
    setTopics(topicRows.topics);
    setReports(reportRows.reports);
    setSettings(rankRows.settings);
    setLogs(logRows.logs);
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await adminApi.guard();
      } catch {
        if (!cancelled) {
          setPhase('denied');
        }
        return;
      }

      const stored = sessionStorage.getItem(SESSION_KEY) ?? '';
      if (!stored) {
        if (!cancelled) {
          setPhase('login');
        }
        return;
      }

      try {
        const session = await adminApi.secureSession(stored);
        if (!session.ok) {
          throw new Error('Invalid session');
        }

        if (cancelled) return;
        setSessionToken(stored);
        setExpiresAt(session.expiresAt ?? '');
        await loadAll(stored);
        if (!cancelled) {
          setPhase('ready');
        }
      } catch {
        if (cancelled) return;
        clearSession();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!expiresAt || phase !== 'ready') return;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      clearSession();
      return;
    }
    const timer = window.setTimeout(() => {
      clearSession();
    }, ms);
    return () => window.clearTimeout(timer);
  }, [expiresAt, phase]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accepted) {
      setError('警告事項への同意が必要です');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await adminApi.secureLogin(password, totp);
      sessionStorage.setItem(SESSION_KEY, data.token);
      setSessionToken(data.token);
      setExpiresAt(data.expiresAt);
      await loadAll(data.token);
      setPassword('');
      setTotp('');
      setPhase('ready');
    } catch (loginError) {
      if (loginError instanceof ApiError && loginError.statusCode === 423) {
        setError('ログイン試行がロックされています。時間をおいて再試行してください。');
      } else {
        setError(loginError instanceof Error ? loginError.message : '管理者ログインに失敗しました');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reloadUsers = async () => {
    const data = await adminApi.listUsers(sessionToken, userSearch);
    setUsers(data.users);
  };

  const reloadTopics = async () => {
    const data = await adminApi.listTopics(sessionToken);
    setTopics(data.topics);
  };

  const reloadReports = async () => {
    const data = await adminApi.listReports(sessionToken);
    setReports(data.reports);
  };

  const reloadLogs = async () => {
    const data = await adminApi.getLogs(sessionToken, 120);
    setLogs(data.logs);
  };

  const logout = async () => {
    try {
      if (sessionToken) {
        await adminApi.secureLogout(sessionToken);
      }
    } catch {
      // ignore logout errors and clear local session anyway
    } finally {
      clearSession();
    }
  };

  const executeAction = async (task: () => Promise<void>) => {
    setError(null);
    try {
      await task();
      await reloadLogs();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作に失敗しました');
    }
  };

  if (phase === 'checking') {
    return (
      <div className="min-h-screen bg-bg-secondary grid place-items-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (phase === 'denied') {
    return <Navigate to="/" replace />;
  }

  if (phase === 'login') {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_15%_10%,#fce7f3_0%,#f5f4f0_45%,#ece9e1_100%)] px-4 py-10">
        <div className="mx-auto max-w-2xl rounded-2xl border border-slate-300 bg-white/95 p-8 shadow-xl">
          <p className="text-xs tracking-[0.22em] text-slate-500">CONFIDENTIAL OPS CONSOLE</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">管理者セキュアログイン</h1>

          <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            法的警告: このシステムは許可された管理者のみ利用可能です。不正アクセス・不正操作は監査ログに記録され、法的措置の対象となります。
          </div>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Admin Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                autoComplete="current-password"
                required
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">TOTP (6桁)</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 tracking-[0.35em]"
                required
              />
            </label>

            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-0.5"
              />
              <span>私は許可された管理者であり、全操作が監査ログに保存されることに同意します。</span>
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {submitting ? '認証中...' : 'セキュアログイン'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f2efe8] px-4 py-6">
      <div className="mx-auto max-w-7xl rounded-2xl border border-slate-300 bg-white p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <p className="text-xs tracking-[0.2em] text-slate-500">ADMIN INTERNAL</p>
            <h1 className="text-2xl font-bold text-slate-900">Security Operations Console</h1>
            <p className="text-xs text-slate-500">Session expires: {expiryLabel}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
          >
            ログアウト
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {[
            ['dashboard', 'Dashboard'],
            ['users', 'Users'],
            ['topics', 'Topics'],
            ['reports', 'Reports'],
            ['settings', 'Settings'],
            ['logs', 'Logs'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key as TabKey)}
              className={`rounded-lg px-3 py-2 text-sm ${tab === key ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-700'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'dashboard' && dashboard && (
          <section className="mt-5 grid gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Total Users</p>
              <p className="mt-1 text-2xl font-bold">{dashboard.totalUsers}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">New 24h</p>
              <p className="mt-1 text-2xl font-bold">{dashboard.registrations24h}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">New 7d</p>
              <p className="mt-1 text-2xl font-bold">{dashboard.registrations7d}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Pending Reports</p>
              <p className="mt-1 text-2xl font-bold">{dashboard.pendingReports}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-4 md:col-span-4">
              <p className="text-sm font-semibold text-slate-700">30日ユーザー増加</p>
              <div className="mt-3 grid grid-cols-6 gap-2 md:grid-cols-10">
                {dashboard.growth30d.slice(-30).map((entry) => (
                  <div key={entry.date} className="rounded border border-slate-200 p-2 text-center">
                    <p className="text-[10px] text-slate-500">{entry.date.slice(5)}</p>
                    <p className="text-sm font-semibold text-slate-800">{entry.count}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {tab === 'users' && (
          <section className="mt-5">
            <div className="mb-3 flex flex-wrap gap-2">
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="IDまたは表示名で検索"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => executeAction(reloadUsers)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                検索
              </button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Points</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((row) => (
                    <tr key={row.id} className="border-t border-slate-200">
                      <td className="px-3 py-2">
                        <p className="font-medium">{row.display_name}</p>
                        <p className="text-xs text-slate-500">{row.id}</p>
                      </td>
                      <td className="px-3 py-2">{row.rank}</td>
                      <td className="px-3 py-2">{row.points}</td>
                      <td className="px-3 py-2">{row.is_banned ? 'BANNED' : 'OK'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs"
                            onClick={() => executeAction(async () => {
                              const reason = window.prompt('BAN理由を入力してください');
                              if (!reason) return;
                              await adminApi.banUser(sessionToken, row.id, reason);
                              await reloadUsers();
                            })}
                          >
                            BAN
                          </button>
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs"
                            onClick={() => executeAction(async () => {
                              const reason = window.prompt('解除理由(任意)');
                              await adminApi.unbanUser(sessionToken, row.id, reason ?? '');
                              await reloadUsers();
                            })}
                          >
                            Unban
                          </button>
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs"
                            onClick={() => executeAction(async () => {
                              const deltaRaw = window.prompt('変更ポイント(例: 50 / -20)');
                              if (!deltaRaw) return;
                              const delta = Number(deltaRaw);
                              if (!Number.isFinite(delta) || delta === 0) return;
                              const reason = window.prompt('理由を入力してください');
                              if (!reason) return;
                              await adminApi.adjustPoints(sessionToken, row.id, delta, reason);
                              await reloadUsers();
                            })}
                          >
                            Points
                          </button>
                          <button
                            type="button"
                            className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700"
                            onClick={() => executeAction(async () => {
                              const reason = window.prompt('削除理由を入力してください');
                              if (!reason) return;
                              const confirmed = window.confirm('本当に削除しますか？この操作は戻せません。');
                              if (!confirmed) return;
                              await adminApi.deleteUser(sessionToken, row.id, reason);
                              await reloadUsers();
                            })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'topics' && (
          <section className="mt-5 space-y-4">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              onClick={() => executeAction(async () => {
                const title = window.prompt('議題タイトル');
                if (!title) return;
                const description = window.prompt('説明(任意)') ?? '';
                const category = window.prompt('カテゴリ(任意)') ?? '';
                await adminApi.createTopic(sessionToken, { title, description, category });
                await reloadTopics();
              })}
            >
              議題を追加
            </button>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Active</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((topic) => (
                    <tr key={topic.id} className="border-t border-slate-200">
                      <td className="px-3 py-2">{topic.title}</td>
                      <td className="px-3 py-2">{topic.category ?? '-'}</td>
                      <td className="px-3 py-2">{topic.is_active ? 'ON' : 'OFF'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs"
                            onClick={() => executeAction(async () => {
                              await adminApi.updateTopic(sessionToken, topic.id, { isActive: !topic.is_active });
                              await reloadTopics();
                            })}
                          >
                            Toggle
                          </button>
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs"
                            onClick={() => executeAction(async () => {
                              const title = window.prompt('新しいタイトル', topic.title);
                              if (!title) return;
                              await adminApi.updateTopic(sessionToken, topic.id, { title });
                              await reloadTopics();
                            })}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700"
                            onClick={() => executeAction(async () => {
                              if (!window.confirm('議題を削除しますか？')) return;
                              await adminApi.deleteTopic(sessionToken, topic.id);
                              await reloadTopics();
                            })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'reports' && (
          <section className="mt-5 space-y-3">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              onClick={() => executeAction(reloadReports)}
            >
              更新
            </button>

            {reports.map((report) => (
              <article key={report.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-700">[{report.target_type}] {report.reason}</p>
                  <p className="text-xs text-slate-500">{new Date(report.created_at).toLocaleString()}</p>
                </div>
                <p className="mt-1 text-xs text-slate-500">target={report.target_id} reporter={report.reporter_id}</p>
                {report.detail && <p className="mt-2 text-sm text-slate-700">{report.detail}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800"
                    onClick={() => executeAction(async () => {
                      await adminApi.resolveReport(sessionToken, report.id, 'valid', false);
                      await reloadReports();
                    })}
                  >
                    Valid
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-xs"
                    onClick={() => executeAction(async () => {
                      await adminApi.resolveReport(sessionToken, report.id, 'invalid', false);
                      await reloadReports();
                    })}
                  >
                    Invalid
                  </button>
                  <button
                    type="button"
                    className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                    onClick={() => executeAction(async () => {
                      await adminApi.resolveReport(sessionToken, report.id, 'invalid', true);
                      await reloadReports();
                    })}
                  >
                    Invalid + Penalize
                  </button>
                </div>
              </article>
            ))}
            {reports.length === 0 && <p className="text-sm text-slate-500">未処理の通報はありません。</p>}
          </section>
        )}

        {tab === 'settings' && (
          <section className="mt-5 space-y-3">
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Threshold</th>
                    <th className="px-3 py-2">Multiplier</th>
                    <th className="px-3 py-2">Badge</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.map((row, idx) => (
                    <tr key={row.rank} className="border-t border-slate-200">
                      <td className="px-3 py-2 font-medium">{row.rank}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          value={row.threshold}
                          onChange={(e) => {
                            const next = [...settings];
                            next[idx] = { ...next[idx], threshold: Number(e.target.value) };
                            setSettings(next);
                          }}
                          className="w-28 rounded border border-slate-300 px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="0.1"
                          value={row.multiplier}
                          onChange={(e) => {
                            const next = [...settings];
                            next[idx] = { ...next[idx], multiplier: Number(e.target.value) };
                            setSettings(next);
                          }}
                          className="w-24 rounded border border-slate-300 px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={row.badge_color}
                          onChange={(e) => {
                            const next = [...settings];
                            next[idx] = { ...next[idx], badge_color: e.target.value };
                            setSettings(next);
                          }}
                          className="w-28 rounded border border-slate-300 px-2 py-1"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
              onClick={() => executeAction(async () => {
                await adminApi.updateRankSettings(
                  sessionToken,
                  settings.map((row) => ({
                    rank: row.rank,
                    threshold: row.threshold,
                    multiplier: row.multiplier,
                    bannerFrom: row.banner_from,
                    bannerTo: row.banner_to,
                    badgeColor: row.badge_color,
                    position: row.position,
                  }))
                );
              })}
            >
              設定を保存
            </button>
          </section>
        )}

        {tab === 'logs' && (
          <section className="mt-5 space-y-3">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              onClick={() => executeAction(reloadLogs)}
            >
              更新
            </button>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Target</th>
                    <th className="px-3 py-2">IP</th>
                    <th className="px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-slate-200 align-top">
                      <td className="px-3 py-2 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2">{log.action}</td>
                      <td className="px-3 py-2">{log.target_type ?? '-'}:{log.target_id ?? '-'}</td>
                      <td className="px-3 py-2">{log.ip_address ?? '-'}</td>
                      <td className="px-3 py-2 whitespace-pre-wrap">{log.detail ? JSON.stringify(log.detail) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
