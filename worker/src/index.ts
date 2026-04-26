import { Hono } from 'hono';
import { Env } from './types';
import { corsMiddleware, addCorsToResponse } from './middleware/cors';
import { errorHandler } from './middleware/error';
import { securityMiddleware } from './middleware/security';
import { authRoutes } from './routes/auth';
import { matchingRoutes } from './routes/matching';
import { debateRoutes, runDebateProgressSweep } from './routes/debates';
import { homeRoutes } from './routes/home';
import { adminRoutes } from './routes/admin';
import { userRoutes } from './routes/users';
import { reportWorkerError } from './lib/monitoring';

export { DebateRoom } from './durable-objects/DebateRoom';

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

  const env = c.env;
  const isProduction = env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production';

  // Hide route topology in production to reduce endpoint discovery surface.
  if (isProduction) {
    return new Response('Not Found', {
      status: 404,
      headers: c.res.headers,
    });
  }

  const requestedPath = c.req.path;
  const method = c.req.method;

  return c.json({
    error: 'Not found',
    path: requestedPath,
    method: method,
    message: `Endpoint ${method} ${requestedPath} does not exist`,
    hint: 'Check route definitions for development diagnostics',
  }, 404);
});

// すべての未処理エラーをキャッチ
app.onError((err, c) => {
  reportWorkerError(err, {
    area: 'worker',
    action: 'unhandled_error',
    extras: {
      method: c.req.method,
      path: c.req.path,
    },
  });
  addCorsToResponse(c);
  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' || c.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : (err.message || 'An unexpected error occurred')
  }, 500);
});

const worker: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil((async () => {
      try {
        const result = await runDebateProgressSweep(env);
        const isProduction = env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production';
        if (!isProduction) {
          console.info('[cron] debate progress sweep', result);
        }
      } catch (error) {
        reportWorkerError(error, {
          area: 'worker',
          action: 'debate_progress_sweep',
        });
      }
    })());
  },
};

export default worker;