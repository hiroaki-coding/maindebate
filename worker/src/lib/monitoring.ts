type ErrorContext = {
  area: string;
  action: string;
  extras?: Record<string, unknown>;
};

type WorkerSentry = {
  captureException?: (error: unknown, options?: { tags?: Record<string, string>; extra?: Record<string, unknown> }) => void;
};

function getWorkerSentry(): WorkerSentry | null {
  const globalRef = globalThis as typeof globalThis & { Sentry?: WorkerSentry };
  const sentry = globalRef.Sentry;
  if (!sentry || typeof sentry.captureException !== 'function') {
    return null;
  }
  return sentry;
}

/**
 * Centralized worker-side error reporting with optional Sentry forwarding.
 */
export function reportWorkerError(error: unknown, context: ErrorContext): void {
  console.error(`[${context.area}] ${context.action} failed`, {
    error,
    extras: context.extras,
  });

  const sentry = getWorkerSentry();
  if (!sentry) return;

  sentry.captureException?.(error, {
    tags: {
      area: context.area,
      action: context.action,
    },
    extra: context.extras,
  });
}
