'use client';

/**
 * Минимальная аналитика для самого исполнителя (ТЗ §20 №14) — не
 * публичная, только свои цифры.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CreatorStatsView, getOwnStats } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

export default function DashboardPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [stats, setStats] = useState<CreatorStatsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOwnStats()
      .then(setStats)
      .catch(() => setError(dict.dashboard.errorPrefix));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h1>{dict.dashboard.heading}</h1>
      <p className="mp-hint">
        <Link href={`/${params.locale}/settings`}>{dict.settings.heading}</Link>
        {' · '}
        <Link href={`/${params.locale}/my-portfolio`}>{dict.myPortfolio.heading}</Link>
      </p>
      {error && (
        <p className="mp-empty">
          {error} <Link href={`/${params.locale}/become-creator`}>{dict.dashboard.takeQuiz}</Link>
        </p>
      )}
      {!error && !stats && <p className="mp-empty">{dict.dashboard.loading}</p>}
      {stats && (
        <div className="mp-grid">
          <div className="mp-creator-card">
            <span className="mp-creator-card-name">{stats.profileViewCount}</span>
            <span className="mp-hint">{dict.dashboard.profileViews}</span>
          </div>
          <div className="mp-creator-card">
            <span className="mp-creator-card-name">{stats.totalPortfolioViews}</span>
            <span className="mp-hint">{dict.dashboard.portfolioViews}</span>
          </div>
          <div className="mp-creator-card">
            <span className="mp-creator-card-name">{stats.totalLikes}</span>
            <span className="mp-hint">{dict.dashboard.likes}</span>
          </div>
          <div className="mp-creator-card">
            <span className="mp-creator-card-name">{stats.itemCount}</span>
            <span className="mp-hint">{dict.dashboard.itemCount}</span>
          </div>
        </div>
      )}
    </>
  );
}
