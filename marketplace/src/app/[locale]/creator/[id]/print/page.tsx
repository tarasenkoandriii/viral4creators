import { notFound } from 'next/navigation';
import { getCreatorPortfolio, getCreatorProfile } from '../../../../../lib/api';
import { getDictionary } from '../../../../../lib/get-dictionary';
import type { Locale } from '../../../../../lib/i18n';
import { PrintButton } from '../../../../../components/PrintButton';

/**
 * «Экспорт портфолио в PDF» (ТЗ §20 №7) — честная замена настоящей
 * серверной генерации PDF, см. подробное обоснование в истории файла.
 * PrintButton сам читает словарь через useDictionary(); остальной текст
 * здесь — из тех же переводов профиля/каталога, чтобы не заводить
 * отдельную секцию словаря ради одной вспомогательной страницы.
 */
export default async function CreatorPrintPage({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}) {
  const { locale, id } = await params;
  const dict = getDictionary(locale);
  const profile = await getCreatorProfile(id);
  if (!profile) notFound();
  const portfolio = await getCreatorPortfolio(id);

  return (
    <div className="mp-print-page">
      <div className="mp-print-only-controls">
        <PrintButton />
      </div>
      <h1>{profile.displayName ?? dict.catalog.noName}</h1>
      <p>{profile.niches.join(' · ')}</p>
      {profile.bio && <p>{profile.bio}</p>}
      {(profile.priceRangeMin != null || profile.priceRangeMax != null) && (
        <p>
          {dict.profile.priceRangeLabel}: {profile.priceRangeMin ?? '?'}–{profile.priceRangeMax ?? '?'}
        </p>
      )}
      {profile.contactHandle && <p>{profile.contactHandle}</p>}

      <h2>{dict.profile.portfolioHeading}</h2>
      <div className="mp-print-grid">
        {portfolio.map((item) => (
          <div key={item.id} className="mp-print-item">
            {/* eslint-disable-next-line @next/next/no-img-element -- страница для печати/PDF: внешнее превью как есть, оптимизатор next/image здесь не нужен */}
            {item.thumbnailUrl && <img src={item.thumbnailUrl} alt={item.title} />}
            <p>{item.title}</p>
            <p style={{ fontSize: 11, color: '#666' }}>{item.videoUrl}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
