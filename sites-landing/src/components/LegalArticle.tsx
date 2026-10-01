import { parseInline, parseLegalMarkdown } from '../lib/legal-markdown';

/** Рендер юридического черновика (порт `landing/src/components/LegalArticle.tsx`). */
function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((span, i) => (span.bold ? <strong key={i}>{span.text}</strong> : <span key={i}>{span.text}</span>))}
    </>
  );
}

export function LegalArticle({ markdown }: { markdown: string }) {
  const blocks = parseLegalMarkdown(markdown);
  return (
    <article className="legal prose">
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
