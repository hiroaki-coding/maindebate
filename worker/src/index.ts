import { Hono } from 'hono';
import { Env } from './types';
import { corsMiddleware, addCorsToResponse } from './middleware/cors';
import { errorHandler } from './middleware/error';
import { securityMiddleware } from './middleware/security';
import { authRoutes } from './routes/auth';
import { matchingRoutes } from './routes/matching';
import { debateRoutes } from './routes/debates';
import { homeRoutes } from './routes/home';
import { adminRoutes } from './routes/admin';
import { userRoutes } from './routes/users';

// Durable Objects のエクスポート（後で実装）
// export { DebateRoom } from './durable-objects/DebateRoom';

const app = new Hono<{ Bindings: Env }>();

// CORSミドルウェアを最初に適用（すべてのリクエストに対して）
app.use('*', securityMiddleware);
app.use('*', corsMiddleware);

// エラーハンドラー
app.use('*', errorHandler);

// ヘルスチェック
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cors: 'enabled',
    port: 8788
  });
});

// 明示的なOPTIONSハンドラー（念のため）
app.options('*', (c) => {
  return c.body(null, 204);
});

// ルート登録
app.route('/api/auth', authRoutes);
app.route('/api/matching', matchingRoutes);
app.route('/api/debates', debateRoutes);
app.route('/api/home', homeRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/users', userRoutes);

// 他のルートは後で追加
// app.route('/api/users', usersRoutes);
// app.route('/api/topics', topicsRoutes);


// 404ハンドラー（CORSヘッダー付き）
app.notFound((c) => {
  addCorsToResponse(c);

  const requestedPath = c.req.path;
  const method = c.req.method;

  return c.json({
    error: 'Not found',
    path: requestedPath,
    method: method,
    message: `Endpoint ${method} ${requestedPath} does not exist`,
    availableEndpoints: [
      'GET /health',
      'POST /api/auth/register',
      'GET /api/auth/me',
      'POST /api/auth/check-ban',
      'POST /api/auth/login-attempt',
      'POST /api/auth/lock-status',
      'POST /api/matching/join',
      'GET /api/matching/status',
      'POST /api/matching/cancel',
      'GET /api/debates/:debateId/snapshot',
      'GET /api/debates/:debateId/tick',
      'POST /api/debates/:debateId/heartbeat',
      'POST /api/debates/:debateId/message',
      'POST /api/debates/:debateId/vote',
      'POST /api/debates/:debateId/comment',
      'POST /api/debates/:debateId/comments/:commentId/report',
      'POST /api/debates/:debateId/report',
      'GET /api/home/cards',
      'GET /api/home/search?q=keyword',
      'GET /api/admin/guard',
      'POST /api/admin/secure/login',
      'GET /api/admin/secure/session',
      'POST /api/admin/secure/logout',
      'GET /api/admin/secure/dashboard',
      'GET /api/admin/secure/users',
      'POST /api/admin/secure/users/:userId/ban',
      'POST /api/admin/secure/users/:userId/unban',
      'POST /api/admin/secure/users/:userId/points',
      'DELETE /api/admin/secure/users/:userId',
      'GET /api/admin/secure/topics',
      'POST /api/admin/secure/topics',
      'PATCH /api/admin/secure/topics/:topicId',
      'DELETE /api/admin/secure/topics/:topicId',
      'GET /api/admin/secure/reports',
      'POST /api/admin/secure/reports/:reportId/resolve',
      'GET /api/admin/secure/rank-settings',
      'PATCH /api/admin/secure/rank-settings',
      'GET /api/admin/secure/logs',
      'GET /api/users/leaderboard',
      'GET /api/users/:userId',
      'PATCH /api/users/me/nickname',
      'GET /api/users/me/notifications'
    ]
  }, 404);
});

// すべての未処理エラーをキャッチ
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  addCorsToResponse(c);
  return c.json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  }, 500);
});

export default app;