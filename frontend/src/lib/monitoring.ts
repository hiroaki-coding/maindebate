type ErrorContext = {
  area: string;
  action: string;
  extras?: Record<string, unknown>;
};

type BrowserSentry = {
  captureException?: (error: unknown, options?: { tags?: Record<string, string>; extra?: Record<string, unknown> }) => void;
};

function getSentryClient(): BrowserSentry | null {
  if (typeof window === 'undefined') return null;
  const maybeSentry = (window as typeof window & { Sentry?: BrowserSentry }).Sentry;
  if (!maybeSentry || typeof maybeSentry.captureException !== 'function') {
    return null;
  }
  return maybeSentry;
}

/**
 * Centralized client-side error reporter. Always logs locally, then forwards to
 * Sentry when it is available in runtime.
 */
export function reportClientError(error: unknown, context: ErrorContext): void {
  console.error(`[${context.area}] ${context.action} failed`, {
    error,
    extras: context.extras,
  });

  const sentry = getSentryClient();
  if (!sentry) return;

  sentry.captureException?.(error, {
    tags: {
      area: context.area,
      action: context.action,
    },
    extra: context.extras,
  });
}
