/**
 * LegalScreen — оферта и условия использования внутри TMA (spec §20).
 * Тексты приходят из общего сгенерированного модуля lib/legal-content.ts
 * (источник — doc/legal/*.md, синхронизация — scripts/sync-legal.mjs),
 * разметка — lib/legal-markdown.ts, общий с лендингом.
 */

import { Card } from '../../components/ui';
import { LEGAL_DOCS } from '../../lib/legal-content';
import { parseInline, parseLegalMarkdown } from '../../lib/legal-markdown';
import { navigate, routes } from '../../lib/router';
import { ScreenHeader } from '../projects/shared';
import { useI18n } from '../../lib/i18n-context';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span, i) =>
        span.bold ? (
          <strong key={i} className="font-semibold">
            {span.text}
          </strong>
        ) : (
          <span key={i}>{span.text}</span>
        )
      )}
    </>
  );
}

export function LegalScreen({ slug }: { slug: string }) {
  const { dict } = useI18n();
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);
  const other = LEGAL_DOCS.filter((d) => d.slug !== slug);

  if (!doc) {
    return (
      <div>
        <ScreenHeader
          title={dict.legalScreen.notFoundTitle}
          back={routes.projects()}
        />
        <Card className="p-5 text-sm text-silver-400">
          {dict.legalScreen.notFoundBody}
        </Card>
      </div>
    );
  }

  const blocks = parseLegalMarkdown(doc.markdown);

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={doc.title}
        back={routes.projects()}
        hint={dict.legalScreen.versionHint.replace(
          '{{version}}',
          String(doc.version)
        )}
      />
      <Card className="p-5">
        <div className="space-y-2 text-sm leading-relaxed">
          {blocks.map((b, i) => {
            if (b.kind === 'h1') return null;
            if (b.kind === 'h2')
              return (
                <h2 key={i} className="pt-3 text-base font-semibold">
                  {b.text}
                </h2>
              );
            if (b.kind === 'ul')
              return (
                <ul key={i} className="list-disc space-y-1 pl-5">
                  {b.items.map((item, j) => (
                    <li key={j}>
                      <Inline text={item} />
                    </li>
                  ))}
                </ul>
              );
            if (b.kind === 'note')
              return (
                <p
                  key={i}
                  className="rounded-xl border-l-2 border-accent/50 bg-accent/5 p-3 text-xs text-silver-500 dark:text-silver-400"
                >
                  <Inline text={b.text} />
                </p>
              );
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
          })}
        </div>
      </Card>
      <div className="mt-3 flex gap-3 text-xs">
        {other.map((d) => (
          <button
            key={d.slug}
            type="button"
            className="inline-flex min-h-[44px] items-center text-accent underline"
            onClick={() => navigate(routes.legal(d.slug))}
          >
            {d.title}
          </button>
        ))}
      </div>
    </div>
  );
}
