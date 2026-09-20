'use client';

/**
 * Форма брифа (ТЗ §21.2) — НЕ тендер: одна страница, без окна приёма
 * заявок. Требует Telegram-идентичность — анонимно бриф не создать.
 */

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, createInquiry } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

type TargetPlatform = 'instagram_reels' | 'tiktok' | 'youtube_shorts' | 'youtube_long' | 'other';
const PLATFORMS: TargetPlatform[] = ['instagram_reels', 'tiktok', 'youtube_shorts', 'youtube_long', 'other'];

const FORMAT_ADVICE_PREVIEW: Record<TargetPlatform, { aspectRatio: string; quality: 'fast' | 'standard' }> = {
  instagram_reels: { aspectRatio: '9:16', quality: 'fast' },
  tiktok: { aspectRatio: '9:16', quality: 'fast' },
  youtube_shorts: { aspectRatio: '9:16', quality: 'fast' },
  youtube_long: { aspectRatio: '16:9', quality: 'standard' },
  other: { aspectRatio: '16:9', quality: 'fast' },
};

/**
 * Аудит-фикс: useSearchParams() требует границы Suspense при статической
 * генерации (Next.js App Router) — без неё сборка падает на пререндере
 * этой страницы для всех 5 локалей сразу. Логика формы вынесена в
 * BriefForm, а сам default export — только обёртка с Suspense.
 */
export default function BriefPage({ params }: { params: { locale: Locale } }) {
  return (
    <Suspense fallback={null}>
      <BriefForm params={params} />
    </Suspense>
  );
}

function BriefForm({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const router = useRouter();
  const searchParams = useSearchParams();
  const brandManifestId = searchParams.get('brandManifestId') ?? undefined;
  const [productDescription, setProductDescription] = useState('');
  const [isProductLine, setIsProductLine] = useState(false);
  const [goal, setGoal] = useState('');
  const [targetPlatform, setTargetPlatform] = useState<TargetPlatform>('instagram_reels');
  const [budgetHint, setBudgetHint] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const advice = FORMAT_ADVICE_PREVIEW[targetPlatform];
  const adviceNote = dict.formatAdvice[targetPlatform];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (productDescription.trim().length < 10) {
      setError(dict.brief.errorTooShort);
      return;
    }
    setSubmitting(true);
    try {
      const inquiry = await createInquiry({
        productDescription,
        isProductLine,
        goal: goal || undefined,
        targetPlatform,
        budgetHint: budgetHint ? Number(budgetHint) : undefined,
        brandManifestId,
      });
      router.push(`/${params.locale}/brief/${inquiry.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? dict.errors.notLoggedIn : dict.brief.errorSubmit);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h1>{dict.brief.heading}</h1>
      <p className="mp-hint">{dict.brief.hint}</p>
      {brandManifestId && <p className="mp-advice-box">{dict.brief.brandAttached}</p>}

      <form className="mp-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="mp-field">
          <label htmlFor="productDescription">{dict.brief.productLabel}</label>
          <textarea
            id="productDescription"
            rows={5}
            value={productDescription}
            onChange={(e) => setProductDescription(e.target.value)}
            placeholder={dict.brief.productPlaceholder}
            required
          />
        </div>

        <div className="mp-field">
          <label>
            <input type="checkbox" checked={isProductLine} onChange={(e) => setIsProductLine(e.target.checked)} /> {dict.brief.isLineLabel}
          </label>
        </div>

        <div className="mp-field">
          <label htmlFor="goal">{dict.brief.goalLabel}</label>
          <input id="goal" type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={dict.brief.goalPlaceholder} />
        </div>

        <div className="mp-field">
          <label htmlFor="targetPlatform">{dict.brief.platformLabel}</label>
          <select id="targetPlatform" value={targetPlatform} onChange={(e) => setTargetPlatform(e.target.value as TargetPlatform)}>
            {PLATFORMS.map((value) => (
              <option key={value} value={value}>
                {dict.brief.platforms[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="mp-advice-box">
          {dict.brief.advicePrefix} <strong>{advice.aspectRatio}</strong>, {dict.brief.adviceQualityLabel}{' '}
          <strong>{advice.quality === 'fast' ? dict.brief.adviceFast : dict.brief.adviceStandard}</strong>. {adviceNote}
        </div>

        <div className="mp-field">
          <label htmlFor="budgetHint">{dict.brief.budgetLabel}</label>
          <input
            id="budgetHint"
            type="number"
            min={0}
            value={budgetHint}
            onChange={(e) => setBudgetHint(e.target.value)}
            placeholder={dict.brief.budgetPlaceholder}
          />
        </div>

        {error && <p style={{ color: '#e05252' }}>{error}</p>}

        <button className="mp-cta" type="submit" disabled={submitting}>
          {submitting ? dict.brief.submitting : dict.brief.submit}
        </button>
      </form>
    </>
  );
}
