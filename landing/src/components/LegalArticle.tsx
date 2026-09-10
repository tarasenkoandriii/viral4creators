/**
 * Рендер юридического документа (spec §20). Разметку даёт
 * lib/legal-markdown (общий с TMA), стили — globals.css лендинга.
 */

import {
  parseInline,
  parseLegalMarkdown,
} from '../lib/legal-markdown';
import type { LegalDoc } from '../lib/legal-content';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span, i) =>
        span.bold ? <strong key={i}>{span.text}</strong> : <span key={i}>{span.text}</span>
      )}
    </>
  );
}

export function LegalArticle({ doc }: { doc: LegalDoc }) {
  const blocks = parseLegalMarkdown(doc.markdown);
  return (
    <article className="legal">
      {blocks.map((b, i) => {
        if (b.kind === 'h1') return <h1 key={i}>{b.text}</h1>;
        if (b.kind === 'h2') return <h2 key={i}>{b.text}</h2>;
        if (b.kind === 'ul')
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        if (b.kind === 'note')
          return (
            <p key={i} className="legal-note">
              <Inline text={b.text} />
            </p>
          );
        return (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        );
      })}
    </article>
  );
}
