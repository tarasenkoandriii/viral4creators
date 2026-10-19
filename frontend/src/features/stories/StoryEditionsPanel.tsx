import { useEffect, useState } from 'react';
import { Card } from '../../components/ui';
import { api } from '../../services/api';
import { EDITION_STATUS_LABELS, LEGAL_LABELS } from './story-library';
import { storyErrorText } from './story-errors';
type Edition = {
  id: string;
  kind: string;
  kindLabel: string;
  locale: string;
  countries: string[];
  title: string;
  revision: string;
  author: string | null;
  translator: string | null;
  publication: { citation: string; pages: string | null } | null;
  source: {
    textUrl: string | null;
    plotUrl: string | null;
    scanUrl: string | null;
    scanSha256: string | null;
    scanLocation: string | null;
  };
  legal: { status: string; basis: string; checkedAt: string };
  responsible: string;
  status: string;
  textVerification: { verifiedAt: string; normalization: string } | null;
  textSha256: string;
  textHashVerified: boolean;
  availableInWizard: boolean;
  blocker: string | null;
  chapterTitles: string[];
  characters: number;
  adaptation: {
    plotSourceTitle: string;
    plotSourceUrl: string;
    changes: string[];
    classic: { id: string; title: string } | null;
  } | null;
};
const Link = ({ href, children }: { href: string; children: string }) => (
  <a
    className="underline"
    href={href}
    target="_blank"
    rel="noopener noreferrer"
  >
    {children}
  </a>
);
/** Editorial registry (§23.5): rights, sources and adaptation differences. */
export function StoryEditionsPanel() {
  const [editions, setEditions] = useState<Edition[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api
      .get<Edition[]>('/story-gifts/editions')
      .then((r) => setEditions(r.data || []))
      .catch((e) =>
        setError(
          storyErrorText(e, {
            fallback: 'Не удалось загрузить реестр редакций',
          })
        )
      );
  }, []);
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-xl font-semibold">Редакции текстов</h2>
      <p className="text-sm">
        Реестр источников и прав. В мастере доступны только утверждённые
        редакции с подтверждёнными правами и совпадающим SHA-256 текста.
        Адаптации помечены и показывают отличия от источника; классика читается
        без переписывания. Сканы не хранятся — только ссылки.
      </p>
      {error && <p role="alert">{error}</p>}
      {editions.map((e) => (
        <details
          key={e.id}
          className="rounded-lg border border-silver-500/30 p-3"
        >
          <summary>
            <strong>{e.title}</strong> · {e.kindLabel} ·{' '}
            {e.locale.toUpperCase()} ·{' '}
            {EDITION_STATUS_LABELS[e.status] ?? e.status} ·{' '}
            {LEGAL_LABELS[e.legal.status] ?? e.legal.status}
            {e.availableInWizard ? '' : ` · не в мастере: ${e.blocker}`}
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            <p>
              Правовой статус проверен {e.legal.checkedAt}: {e.legal.basis}
            </p>
            {(e.author || e.translator) && (
              <p>
                {e.author ? `Автор/обработка: ${e.author}` : ''}
                {e.translator ? ` · Перевод: ${e.translator}` : ''}
              </p>
            )}
            {e.publication && (
              <p>
                Издание: {e.publication.citation}
                {e.publication.pages ? `, с. ${e.publication.pages}` : ''}
              </p>
            )}
            {e.textVerification && (
              <p>
                Сверка со сканом {e.textVerification.verifiedAt}:{' '}
                {e.textVerification.normalization}
              </p>
            )}
            <p className="flex flex-wrap gap-3">
              {e.source.textUrl && (
                <Link href={e.source.textUrl}>Источник текста</Link>
              )}
              {e.source.scanUrl && e.source.scanUrl !== e.source.textUrl && (
                <Link href={e.source.scanUrl}>Скан</Link>
              )}
              {e.source.plotUrl && (
                <Link href={e.source.plotUrl}>Источник сюжета</Link>
              )}
            </p>
            {e.source.scanUrl && (
              <p>
                {e.source.scanSha256
                  ? `SHA-256 скана: ${e.source.scanSha256}`
                  : 'Хеш файла скана не записан.'}{' '}
                {e.source.scanLocation}
              </p>
            )}
            <p className="break-all text-xs">
              SHA-256 текста: {e.textSha256}{' '}
              {e.textHashVerified ? '(совпадает)' : '(НЕ совпадает с текстом)'}
            </p>
            <p>
              Сцены: {e.chapterTitles.join(' · ')} · {e.characters} знаков ·
              ревизия {e.revision} · ответственный: {e.responsible}
            </p>
            {e.adaptation && (
              <div className="rounded-lg border border-amber-500 p-2">
                <p className="font-semibold">
                  Адаптация —{' '}
                  {e.adaptation.classic
                    ? `отличия от классики «${e.adaptation.classic.title}»`
                    : 'отличия от источника сюжета (классическая редакция в реестр не внесена)'}
                </p>
                <p>
                  Источник:{' '}
                  <Link href={e.adaptation.plotSourceUrl}>
                    {e.adaptation.plotSourceTitle}
                  </Link>
                </p>
                <ul className="list-disc pl-5">
                  {e.adaptation.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      ))}
    </Card>
  );
}
