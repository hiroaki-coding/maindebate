import { Context, Next } from 'hono';

function isHttpsRequest(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto === 'https';
  return c.req.url.startsWith('https://');
}

function setSecurityHeaders(c: Context): void {
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://www.gstatic.com https://www.googleapis.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self' https: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
}

export async function securityMiddleware(c: Context, next: Next): Promise<Response | void> {
  const env = c.env as { ENVIRONMENT?: string };
  const isProd = env.ENVIRONMENT === 'production';

  if (isProd && !isHttpsRequest(c)) {
    const redirectUrl = c.req.url.replace('http://', 'https://');
    return c.redirect(redirectUrl, 301);
  }

  setSecurityHeaders(c);
  await next();
  setSecurityHeaders(c);
}
