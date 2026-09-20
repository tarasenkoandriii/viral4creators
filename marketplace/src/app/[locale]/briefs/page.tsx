'use client';

/**
 * Аудит-фикс (находка №6): GET /creator-inquiries/mine существовал, но
 * ни одна страница его не вызывала — заказчик, потерявший ссылку на
 * /brief/[id], не мог найти свой бриф снова.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMyInquiries, InquiryView } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

export default function BriefsListPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [inquiries, setInquiries] = useState<InquiryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyInquiries()
      .then(setInquiries)
      .catch(() => setError(dict.errors.generic));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusLabel = (status: string) =>
    status === 'CONTACTED' ? dict.briefsList.statusContacted : status === 'DRAFT' ? dict.briefsList.statusDraft : dict.briefsList.statusSent;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>{dict.briefsList.heading}</h1>
        <Link href={`/${params.locale}/brief`} className="mp-cta">
          {dict.briefsList.newButton}
        </Link>
      </div>

      {error && <p style={{ color: '#e05252' }}>{error}</p>}
      {!error && inquiries === null && <p className="mp-empty">{dict.matches.loading}</p>}
      {inquiries && inquiries.length === 0 && <p className="mp-empty">{dict.briefsList.empty}</p>}

      {inquiries && inquiries.length > 0 && (
        <div className="mp-grid">
          {inquiries.map((inquiry) => (
            <div key={inquiry.id} className="mp-creator-card">
              <span className="mp-creator-card-name">{inquiry.productDescription.slice(0, 60)}</span>
              <span className="mp-pill">{statusLabel(inquiry.status)}</span>
              <Link href={`/${params.locale}/brief/${inquiry.id}`} className="mp-cta-secondary">
                {dict.briefsList.openMatches}
              </Link>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
