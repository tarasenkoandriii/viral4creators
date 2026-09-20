'use client';

/**
 * Подбор исполнителя без тендера (ТЗ §21.3) — список из каталога,
 * отфильтрованный по нише/цене брифа. «Связаться» отмечает бриф как
 * CONTACTED и уводит на публичный профиль — сама сделка вне платформы.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  contactCreator,
  FormatAdviceView,
  getFormatAdvice,
  getInquiry,
  getInquiryMatches,
  InquiryMatchView,
} from '../../../../lib/client-api';
import { useDictionary } from '../../../../lib/dictionary-context';
import type { Locale } from '../../../../lib/i18n';

export default function BriefMatchesPage({ params }: { params: { locale: Locale; id: string } }) {
  const { dict } = useDictionary();
  const [matches, setMatches] = useState<InquiryMatchView[] | null>(null);
  const [advice, setAdvice] = useState<FormatAdviceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contactedId, setContactedId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getInquiryMatches(params.id), getFormatAdvice(params.id), getInquiry(params.id)])
      .then(([m, a, inquiry]) => {
        setMatches(m);
        setAdvice(a);
        // Аудит-фикс: раньше «Отмечено ✓» пропадало при обновлении
        // страницы — contactedCreatorId уже был сохранён в БД, но
        // локальный useState никогда его не перечитывал.
        setContactedId(inquiry.contactedCreatorId ?? null);
      })
      .catch(() => setError(dict.matches.errorLoad));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const handleContact = async (creatorProfileId: string) => {
    try {
      await contactCreator(params.id, creatorProfileId);
      setContactedId(creatorProfileId);
    } catch {
      // Аудит: раньше это молчаливо игнорировалось. Теперь короткое
      // сообщение — например, если исполнитель перестал принимать заказы
      // между подбором и кликом «Связаться» (см. backend-фикс §9).
      setError(dict.errors.generic);
    }
  };

  return (
    <>
      <h1>{dict.matches.heading}</h1>

      {advice && (
        <p className="mp-advice-box">
          {dict.matches.adviceIntro} <strong>{advice.aspectRatio}</strong>,{' '}
          {dict.brief.adviceQualityLabel}{' '}
          <strong>{advice.quality === 'fast' ? dict.brief.adviceFast : dict.brief.adviceStandard}</strong> —{' '}
          {dict.matches.adviceSuffix}
        </p>
      )}

      {error && <p style={{ color: '#e05252' }}>{error}</p>}

      {matches === null && !error && <p className="mp-empty">{dict.matches.loading}</p>}

      {matches && matches.length === 0 && (
        <p className="mp-empty">
          {dict.matches.emptyPrefix} <Link href={`/${params.locale}`}>{dict.matches.emptyLink}</Link>{' '}
          {dict.matches.emptySuffix}
        </p>
      )}

      {matches && matches.length > 0 && (
        <div className="mp-grid">
          {matches.map((m) => (
            <div key={m.creatorProfileId} className="mp-creator-card">
              <span className="mp-creator-card-name">{m.displayName ?? dict.matches.noName}</span>
              <span className="mp-creator-card-niches">
                {m.niches.map((n) => (
                  <span key={n} className="mp-pill">
                    {n}
                  </span>
                ))}
              </span>
              {(m.priceRangeMin != null || m.priceRangeMax != null) && (
                <span className="mp-creator-card-price">
                  {dict.catalog.priceFrom} {m.priceRangeMin ?? '?'} {dict.catalog.priceTo} {m.priceRangeMax ?? '?'}
                </span>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Link href={`/${params.locale}/creator/${m.creatorProfileId}`} className="mp-cta-secondary">
                  {dict.matches.portfolioButton}
                </Link>
                <button type="button" className="mp-cta" onClick={() => void handleContact(m.creatorProfileId)}>
                  {contactedId === m.creatorProfileId ? dict.matches.contactedButton : dict.matches.contactButton}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
