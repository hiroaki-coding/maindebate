import { Link } from 'react-router-dom';

interface LiveEmptyStateProps {
  className?: string;
}

export function LiveEmptyState({ className = '' }: LiveEmptyStateProps) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white px-4 py-14 text-center ${className}`.trim()}>
      <p className="text-4xl" aria-hidden="true">🎙️</p>
      <p className="mt-3 text-base text-[var(--color-con)]">現在ライブ中のディベートはありません</p>
      <Link
        to="/matching"
        className="mt-6 inline-flex rounded-lg bg-[var(--color-pro)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--color-pro-hover)]"
      >
        マッチングして最初のディベーターになる →
      </Link>
    </div>
  );
}
