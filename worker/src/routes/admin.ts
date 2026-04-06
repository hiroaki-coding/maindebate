import { Context, Hono } from 'hono';
import { Env, AuthUser } from '../types';
import { adminRequired } from '../middleware/auth';
import { createClient } from '@supabase/supabase-js';
import { addCorsToResponse } from '../middleware/cors';
import { addPointsWithLog } from '../lib/points';
import {
  checkAdminLoginLock,
  clearAdminLoginFailure,
  createAdminSession,
  getAdminSession,
  getClientIp,
  recordAdminLoginFailure,
  revokeAdminSession,
  verifyTotp,
  writeAdminAuditLog,
} from '../lib/adminSecurity';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>();
type AppContext = Context<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>;

const getSupabase = (env: Env) => createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);

function hasSupabaseConfig(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

async function ensureSecureAdminSession(
  c: AppContext
): Promise<{ userId: string; sessionToken: string; ipAddress: string } | Response> {
  const authResult = await adminRequired(c, async () => {});
  if (authResult) return authResult;

  const admin = c.get('user');
  const userId = typeof admin?.userId === 'string' ? admin.userId : null;
  if (!userId) {
    return c.json({ error: '管理者情報が無効です' }, 403);
  }

  const sessionToken = c.req.header('x-admin-session') ?? '';
  if (!sessionToken) {
    return c.json({ error: '管理者セッションが必要です' }, 401);
  }

  const payload = await getAdminSession(c.env, sessionToken);
  if (!payload || payload.userId !== userId) {
    return c.json({ error: '管理者セッションが無効です' }, 401);
  }

  const ipAddress = getClientIp(c.req);
  if (payload.ipAddress !== ipAddress) {
    await revokeAdminSession(c.env, sessionToken);
    return c.json({ error: '管理者セッションが無効です' }, 401);
  }

  return {
    userId,
    sessionToken,
    ipAddress,
  };
}

app.get('/guard', adminRequired, async (c) => {
  return c.json({ ok: true, role: 'admin' });
});

app.get('/secure/session', async (c) => {
  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const payload = await getAdminSession(c.env, session.sessionToken);
  return c.json({
    ok: true,
    expiresAt: payload?.expiresAt,
  });
});

app.post('/secure/login', adminRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const admin = c.get('user');
  const userId = typeof admin?.userId === 'string' ? admin.userId : null;
  if (!userId) {
    return c.json({ error: '管理者情報が無効です' }, 403);
  }

  if (!c.env.ADMIN_PANEL_PASSWORD || !c.env.ADMIN_TOTP_SECRET) {
    return c.json({ error: 'Admin security credentials are not configured' }, 500);
  }

  const ipAddress = getClientIp(c.req);
  const identity = `${userId}:${ipAddress}`;

  try {
    const lock = await checkAdminLoginLock(c.env, identity);
    if (lock.locked) {
      c.header('Retry-After', String(lock.retryAfterSec ?? 60));
      return c.json({ error: 'アカウントがロックされています。しばらくしてから再試行してください。' }, 423);
    }

    const body = await c.req.json<{ password?: string; totp?: string }>();
    const password = body.password ?? '';
    const totp = body.totp ?? '';

    const passwordOk = password === c.env.ADMIN_PANEL_PASSWORD;
    const totpOk = await verifyTotp(c.env.ADMIN_TOTP_SECRET, totp);

    if (!passwordOk || !totpOk) {
      const failed = await recordAdminLoginFailure(c.env, identity);
      if (failed.locked) {
        c.header('Retry-After', String(failed.retryAfterSec ?? 60));
        return c.json({ error: 'アカウントがロックされています。しばらくしてから再試行してください。' }, 423);
      }
      return c.json({ error: '認証情報が正しくありません' }, 401);
    }

    await clearAdminLoginFailure(c.env, identity);
    const session = await createAdminSession(c.env, userId, ipAddress);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: userId,
      action: 'admin_login',
      ipAddress,
      detail: { method: 'password+totp' },
    });

    return c.json({
      token: session.token,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error('Admin secure login error:', error);
    addCorsToResponse(c);
    return c.json({ error: '管理者ログインに失敗しました' }, 500);
  }
});

app.post('/secure/logout', async (c) => {
  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  await revokeAdminSession(c.env, session.sessionToken);
  await writeAdminAuditLog({
    env: c.env,
    adminUserId: session.userId,
    action: 'admin_logout',
    ipAddress: session.ipAddress,
  });

  return c.json({ ok: true });
});

app.get('/secure/dashboard', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const supabase = getSupabase(c.env);
    const now = new Date();
    const before24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const before7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const before30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [
      totalUsers,
      registrations24h,
      registrations7d,
      pendingReports,
      growthRows,
    ] = await Promise.all([
      supabase.from('users').select('id', { head: true, count: 'exact' }),
      supabase.from('users').select('id', { head: true, count: 'exact' }).gte('created_at', before24h),
      supabase.from('users').select('id', { head: true, count: 'exact' }).gte('created_at', before7d),
      supabase.from('reports').select('id', { head: true, count: 'exact' }).eq('status', 'pending'),
      supabase
        .from('users')
        .select('created_at')
        .gte('created_at', before30d)
        .order('created_at', { ascending: true }),
    ]);

    if (totalUsers.error) return c.json({ error: totalUsers.error.message }, 500);
    if (registrations24h.error) return c.json({ error: registrations24h.error.message }, 500);
    if (registrations7d.error) return c.json({ error: registrations7d.error.message }, 500);
    if (pendingReports.error) return c.json({ error: pendingReports.error.message }, 500);
    if (growthRows.error) return c.json({ error: growthRows.error.message }, 500);

    const buckets = new Map<string, number>();
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, 0);
    }

    for (const row of growthRows.data ?? []) {
      const key = row.created_at.slice(0, 10);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'dashboard_view',
      ipAddress: session.ipAddress,
    });

    return c.json({
      totalUsers: totalUsers.count ?? 0,
      registrations24h: registrations24h.count ?? 0,
      registrations7d: registrations7d.count ?? 0,
      pendingReports: pendingReports.count ?? 0,
      growth30d: Array.from(buckets.entries()).map(([date, count]) => ({ date, count })),
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ダッシュボードの取得に失敗しました' }, 500);
  }
});

app.get('/secure/users', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const supabase = getSupabase(c.env);
    const query = (c.req.query('q') ?? '').trim();

    let request = supabase
      .from('users')
      .select('id, display_name, rank, points, is_banned, banned_reason, created_at')
      .order('created_at', { ascending: false })
      .limit(120);

    if (query) {
      if (/^[0-9a-fA-F-]{8,}$/.test(query)) {
        request = request.eq('id', query);
      } else {
        request = request.ilike('display_name', `%${query}%`);
      }
    }

    const { data, error } = await request;
    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'users_list_view',
      ipAddress: session.ipAddress,
      detail: { query },
    });

    return c.json({ users: data ?? [] });
  } catch (error) {
    console.error('Admin users list error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ユーザー一覧の取得に失敗しました' }, 500);
  }
});

app.post('/secure/users/:userId/ban', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const userId = c.req.param('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const body = await c.req.json<{ reason?: string }>();
    const reason = (body.reason ?? '').trim();
    if (!reason) return c.json({ error: 'BAN理由は必須です' }, 400);

    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from('users')
      .update({
        is_banned: true,
        banned_reason: reason,
        banned_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'user_ban',
      targetType: 'user',
      targetId: userId,
      ipAddress: session.ipAddress,
      detail: { reason },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin ban error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'BAN処理に失敗しました' }, 500);
  }
});

app.post('/secure/users/:userId/unban', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const userId = c.req.param('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const body = await c.req.json<{ reason?: string }>();
    const reason = (body.reason ?? '').trim();

    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from('users')
      .update({
        is_banned: false,
        banned_reason: null,
        banned_at: null,
      })
      .eq('id', userId);

    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'user_unban',
      targetType: 'user',
      targetId: userId,
      ipAddress: session.ipAddress,
      detail: { reason },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin unban error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'BAN解除に失敗しました' }, 500);
  }
});

app.post('/secure/users/:userId/points', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const userId = c.req.param('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const body = await c.req.json<{ delta?: number; reason?: string }>();
    const delta = Number(body.delta ?? 0);
    const reason = (body.reason ?? '').trim();

    if (!Number.isFinite(delta) || delta === 0) {
      return c.json({ error: 'delta must be non-zero number' }, 400);
    }
    if (!reason) {
      return c.json({ error: '理由は必須です' }, 400);
    }

    await addPointsWithLog({
      env: c.env,
      userId,
      baseDelta: Math.trunc(delta),
      reason: delta >= 0 ? 'report_valid' : 'report_invalid',
      relatedId: null,
    });

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'user_points_adjust',
      targetType: 'user',
      targetId: userId,
      ipAddress: session.ipAddress,
      detail: { delta: Math.trunc(delta), reason },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin points adjust error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ポイント変更に失敗しました' }, 500);
  }
});

app.delete('/secure/users/:userId', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const userId = c.req.param('userId');
  if (!userId) return c.json({ error: 'userId is required' }, 400);

  try {
    const body = await c.req.json<{ confirm?: string; reason?: string }>();
    if (body.confirm !== 'DELETE') {
      return c.json({ error: '確認文言が不正です' }, 400);
    }
    const reason = (body.reason ?? '').trim();
    if (!reason) return c.json({ error: '削除理由は必須です' }, 400);

    const supabase = getSupabase(c.env);

    await supabase.from('matching_queue').delete().eq('user_id', userId);
    await supabase.from('debate_votes').delete().eq('user_id', userId);
    await supabase.from('debate_comments').delete().eq('user_id', userId);
    await supabase.from('debate_messages').delete().eq('user_id', userId);
    await supabase.from('reports').delete().eq('reporter_id', userId);
    await supabase.from('notifications').delete().eq('user_id', userId);
    await supabase.from('point_logs').delete().eq('user_id', userId);
    await supabase.from('point_history').delete().eq('user_id', userId);
    await supabase.from('debates').update({ pro_user_id: null }).eq('pro_user_id', userId);
    await supabase.from('debates').update({ con_user_id: null }).eq('con_user_id', userId);

    const { error } = await supabase.from('users').delete().eq('id', userId);
    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'user_delete',
      targetType: 'user',
      targetId: userId,
      ipAddress: session.ipAddress,
      detail: { reason },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin delete user error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'アカウント削除に失敗しました' }, 500);
  }
});

app.get('/secure/topics', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('topics')
      .select('id, title, description, pro_label, con_label, category, is_active, created_at')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) return c.json({ error: error.message }, 500);

    return c.json({ topics: data ?? [] });
  } catch (error) {
    console.error('Admin topics list error:', error);
    addCorsToResponse(c);
    return c.json({ error: '議題一覧の取得に失敗しました' }, 500);
  }
});

app.post('/secure/topics', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const body = await c.req.json<{ title?: string; description?: string; category?: string }>();
    const title = (body.title ?? '').trim();
    const description = (body.description ?? '').trim();
    const category = (body.category ?? '').trim();

    if (!title) return c.json({ error: 'title is required' }, 400);

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('topics')
      .insert({
        title,
        description: description || null,
        category: category || null,
        is_active: true,
      })
      .select('id')
      .single();

    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'topic_create',
      targetType: 'topic',
      targetId: data.id,
      ipAddress: session.ipAddress,
      detail: { title },
    });

    return c.json({ ok: true, id: data.id });
  } catch (error) {
    console.error('Admin topic create error:', error);
    addCorsToResponse(c);
    return c.json({ error: '議題作成に失敗しました' }, 500);
  }
});

app.patch('/secure/topics/:topicId', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const topicId = c.req.param('topicId');
  if (!topicId) return c.json({ error: 'topicId is required' }, 400);

  try {
    const body = await c.req.json<{ title?: string; description?: string; category?: string; isActive?: boolean }>();
    const payload: Record<string, unknown> = {};
    if (typeof body.title === 'string') payload.title = body.title.trim();
    if (typeof body.description === 'string') payload.description = body.description.trim() || null;
    if (typeof body.category === 'string') payload.category = body.category.trim() || null;
    if (typeof body.isActive === 'boolean') payload.is_active = body.isActive;

    const supabase = getSupabase(c.env);
    const { error } = await supabase.from('topics').update(payload).eq('id', topicId);
    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'topic_update',
      targetType: 'topic',
      targetId: topicId,
      ipAddress: session.ipAddress,
      detail: payload,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin topic update error:', error);
    addCorsToResponse(c);
    return c.json({ error: '議題更新に失敗しました' }, 500);
  }
});

app.delete('/secure/topics/:topicId', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const topicId = c.req.param('topicId');
  if (!topicId) return c.json({ error: 'topicId is required' }, 400);

  try {
    const supabase = getSupabase(c.env);
    const { error } = await supabase.from('topics').delete().eq('id', topicId);
    if (error) return c.json({ error: error.message }, 500);

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'topic_delete',
      targetType: 'topic',
      targetId: topicId,
      ipAddress: session.ipAddress,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin topic delete error:', error);
    addCorsToResponse(c);
    return c.json({ error: '議題削除に失敗しました' }, 500);
  }
});

app.get('/secure/reports', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('reports')
      .select('id, reporter_id, target_type, target_id, reason, detail, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(300);

    if (error) return c.json({ error: error.message }, 500);

    return c.json({ reports: data ?? [] });
  } catch (error) {
    console.error('Admin secure reports list error:', error);
    addCorsToResponse(c);
    return c.json({ error: '通報一覧の取得に失敗しました' }, 500);
  }
});

app.post('/secure/reports/:reportId/resolve', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  const reportId = c.req.param('reportId');
  if (!reportId) return c.json({ error: 'reportId is required' }, 400);

  try {
    const body = await c.req.json<{ action?: 'valid' | 'invalid'; penalize?: boolean }>();
    const action = body.action;
    const penalize = Boolean(body.penalize);
    if (action !== 'valid' && action !== 'invalid') {
      return c.json({ error: 'action must be valid or invalid' }, 400);
    }

    const supabase = getSupabase(c.env);
    const { data: report, error: reportError } = await supabase
      .from('reports')
      .select('id, reporter_id, target_type, target_id, status')
      .eq('id', reportId)
      .maybeSingle();

    if (reportError) return c.json({ error: reportError.message }, 500);
    if (!report) return c.json({ error: 'Report not found' }, 404);
    if (report.status !== 'pending') return c.json({ error: 'Report already resolved' }, 400);

    const { data: pendingRows, error: pendingError } = await supabase
      .from('reports')
      .select('id, reporter_id')
      .eq('target_type', report.target_type)
      .eq('target_id', report.target_id)
      .eq('status', 'pending');

    if (pendingError) return c.json({ error: pendingError.message }, 500);

    const relatedPending = pendingRows ?? [];
    const relatedPendingIds = relatedPending.map((row) => row.id);
    const relatedReporterIds = Array.from(new Set(relatedPending.map((row) => row.reporter_id)));

    if (action === 'valid') {
      if (report.target_type === 'comment') {
        await supabase.from('debate_comments').update({ is_hidden: true }).eq('id', report.target_id);
      } else {
        await supabase.from('debates').update({ is_hidden: true }).eq('id', report.target_id);
      }

      if (relatedPendingIds.length > 0) {
        await supabase.from('reports').update({ status: 'approved' }).in('id', relatedPendingIds);
      }

      await Promise.all(
        relatedReporterIds.map((reporterId) =>
          addPointsWithLog({
            env: c.env,
            userId: reporterId,
            baseDelta: 20,
            reason: 'report_valid',
            relatedId: report.target_id,
          })
        )
      );
    } else {
      if (report.target_type === 'comment') {
        await supabase.from('debate_comments').update({ is_hidden: false }).eq('id', report.target_id);
      } else {
        await supabase.from('debates').update({ is_hidden: false }).eq('id', report.target_id);
      }

      if (relatedPendingIds.length > 0) {
        await supabase.from('reports').update({ status: 'rejected' }).in('id', relatedPendingIds);
      }

      if (penalize) {
        await Promise.all(
          relatedReporterIds.map((reporterId) =>
            addPointsWithLog({
              env: c.env,
              userId: reporterId,
              baseDelta: -20,
              reason: 'report_invalid',
              relatedId: report.target_id,
            })
          )
        );
      }
    }

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'report_resolve',
      targetType: report.target_type,
      targetId: report.target_id,
      ipAddress: session.ipAddress,
      detail: { reportId, action, penalize },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin secure report resolve error:', error);
    addCorsToResponse(c);
    return c.json({ error: '通報処理に失敗しました' }, 500);
  }
});

app.get('/secure/rank-settings', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('rank_settings')
      .select('rank, threshold, multiplier, banner_from, banner_to, badge_color, position')
      .order('position', { ascending: true });

    if (error) return c.json({ error: error.message }, 500);
    return c.json({ settings: data ?? [] });
  } catch (error) {
    console.error('Admin rank settings list error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ランク設定の取得に失敗しました' }, 500);
  }
});

app.patch('/secure/rank-settings', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const body = await c.req.json<{
      settings?: Array<{
        rank: string;
        threshold: number;
        multiplier: number;
        bannerFrom: string;
        bannerTo: string;
        badgeColor: string;
        position: number;
      }>;
    }>();

    const settings = body.settings ?? [];
    if (settings.length === 0) {
      return c.json({ error: 'settings is required' }, 400);
    }

    const supabase = getSupabase(c.env);
    for (const row of settings) {
      const { error } = await supabase
        .from('rank_settings')
        .update({
          threshold: row.threshold,
          multiplier: row.multiplier,
          banner_from: row.bannerFrom,
          banner_to: row.bannerTo,
          badge_color: row.badgeColor,
          position: row.position,
        })
        .eq('rank', row.rank);

      if (error) return c.json({ error: error.message }, 500);
    }

    await c.env.LOGIN_ATTEMPTS.delete('rank-settings:cache:v1');

    await writeAdminAuditLog({
      env: c.env,
      adminUserId: session.userId,
      action: 'rank_settings_update',
      ipAddress: session.ipAddress,
      detail: { count: settings.length },
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error('Admin rank settings update error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ランク設定更新に失敗しました' }, 500);
  }
});

app.get('/secure/logs', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const session = await ensureSecureAdminSession(c);
  if (session instanceof Response) return session;

  try {
    const limit = Math.min(500, Math.max(10, Number(c.req.query('limit') ?? 100)));
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('admin_audit_logs')
      .select('id, admin_user_id, action, target_type, target_id, ip_address, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return c.json({ error: error.message }, 500);

    return c.json({ logs: data ?? [] });
  } catch (error) {
    console.error('Admin logs list error:', error);
    addCorsToResponse(c);
    return c.json({ error: '監査ログの取得に失敗しました' }, 500);
  }
});

export const adminRoutes = app;
