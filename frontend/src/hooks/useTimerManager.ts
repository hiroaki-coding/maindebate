import { useCallback, useEffect, useRef } from 'react';

type TimeoutId = ReturnType<typeof globalThis.setTimeout>;
type IntervalId = ReturnType<typeof globalThis.setInterval>;

/**
 * Manages all time-based side effects in one place to prevent leaked timers
 * when components unmount or rerender frequently.
 */
export function useTimerManager() {
  const timeoutIdsRef = useRef<Set<TimeoutId>>(new Set());
  const intervalIdsRef = useRef<Set<IntervalId>>(new Set());

  const clearManagedTimeout = useCallback((id: TimeoutId | null | undefined) => {
    if (!id) return;
    globalThis.clearTimeout(id);
    timeoutIdsRef.current.delete(id);
  }, []);

  const clearManagedInterval = useCallback((id: IntervalId | null | undefined) => {
    if (!id) return;
    globalThis.clearInterval(id);
    intervalIdsRef.current.delete(id);
  }, []);

  const setManagedTimeout = useCallback((callback: () => void, delayMs: number): TimeoutId => {
    const id = globalThis.setTimeout(() => {
      timeoutIdsRef.current.delete(id);
      callback();
    }, delayMs);

    timeoutIdsRef.current.add(id);
    return id;
  }, []);

  const setManagedInterval = useCallback((callback: () => void, delayMs: number): IntervalId => {
    const id = globalThis.setInterval(callback, delayMs);
    intervalIdsRef.current.add(id);
    return id;
  }, []);

  const clearAllTimers = useCallback(() => {
    for (const timeoutId of timeoutIdsRef.current) {
      globalThis.clearTimeout(timeoutId);
    }
    timeoutIdsRef.current.clear();

    for (const intervalId of intervalIdsRef.current) {
      globalThis.clearInterval(intervalId);
    }
    intervalIdsRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      clearAllTimers();
    };
  }, [clearAllTimers]);

  return {
    setManagedTimeout,
    setManagedInterval,
    clearManagedTimeout,
    clearManagedInterval,
    clearAllTimers,
  };
}
