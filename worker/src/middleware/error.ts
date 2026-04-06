import { Context, Next } from 'hono';
import { addCorsToResponse } from './cors';

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (e) {
    console.error('Error:', e);

    // すべてのエラーレスポンスにCORSヘッダーを付与
    addCorsToResponse(c);

    if (e instanceof Error) {
      // 特定のエラーコードに応じたステータスコード
      if (e.message.includes('not found') || e.message.includes('見つかりません')) {
        return c.json({ error: e.message }, 404);
      }
      if (e.message.includes('unauthorized') || e.message.includes('認証')) {
        return c.json({ error: e.message }, 401);
      }
      if (e.message.includes('forbidden') || e.message.includes('権限')) {
        return c.json({ error: e.message }, 403);
      }
      if (e.message.includes('validation') || e.message.includes('入力')) {
        return c.json({ error: e.message }, 400);
      }

      return c.json({ error: e.message }, 500);
    }

    return c.json({ error: 'Internal server error' }, 500);
  }
}