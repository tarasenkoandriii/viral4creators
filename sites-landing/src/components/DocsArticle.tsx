import { Fragment, type ReactNode } from 'react';
import { claimStatus, isClaimId } from '../lib/claims';
import type { DocBlock, Inline, ParsedDoc } from '../lib/docs-markdown';
import type { Dictionary } from '../lib/get-dictionary';
import { SoonBadge } from './Claim';

/**
 * Рендер документации (Л5): блоки `parseDoc()` → React, без
 * `dangerouslySetInnerHTML`. Блок `:::claim` — по реестру утверждений:
 * `hidden` — нет в разметке, `soon` — метка в первом заголовке (ссылок и
 * кода в нём нет — это проверяет `scripts/docs.test.ts`).
 */
function InlineView({ inline }: { inline: readonly Inline[] }) {
  return (
    <>
      {inline.map((x, i) => {
        if (x.kind === 'code') return <code key={i}>{x.text}</code>;
        if (x.kind === 'bold') return <strong key={i}>{x.text}</strong>;
        if (x.kind === 'link') return <a key={i} href={x.href}>{x.text}</a>;
        return <Fragment key={i}>{x.text}</Fragment>;
      })}
    </>
  );
}

export function CodeBlock({ code, label, wrap = false }: { code: string; label: string; wrap?: boolean }) {
  return (
    <pre className={wrap ? 'code code-wrap' : 'code'} tabIndex={0} aria-label={label}>
      <code>{code}</code>
    </pre>
  );
}

function Block({ b, dict, soon }: { b: DocBlock; dict: Dictionary; soon: { pending: boolean } }): ReactNode {
  switch (b.kind) {
    case 'h2':
    case 'h3': {
      const H = b.kind;
      const badge = soon.pending;
      soon.pending = false;
      return (
        <H id={b.id}>
          {b.text} {badge && <SoonBadge dict={dict} />}
        </H>
      );
    }
    case 'p':
      return (
        <p>
          <InlineView inline={b.inline} />
        </p>
      );
    case 'note':
      return (
        <p className="legal-note">
          <InlineView inline={b.inline} />
        </p>
      );
    case 'ul':
    case 'ol': {
      const L = b.kind;
      return (
        <L>
          {b.items.map((item, i) => (
            <li key={i}>
              <InlineView inline={item} />
            </li>
          ))}
        </L>
      );
    }
    case 'code':
      return <CodeBlock code={b.code} label={`${dict.docsUi.codeLabel}: ${b.lang}`} />;
    case 'table':
      return (
        <div className="table-wrap">
          <table>
            <caption>{b.caption}</caption>
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        <InlineView inline={cell} />
                      </th>
                    ) : (
                      <td key={j}>
                        <InlineView inline={cell} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'claim': {
      if (!isClaimId(b.claim)) throw new Error(`docs: неизвестное утверждение «${b.claim}»`);
      const status = claimStatus(b.claim);
      if (status === 'hidden') return null;
      const state = { pending: status === 'soon' };
      return (
        <section className={`claim ${status === 'soon' ? 'claim-soon' : 'claim-live'}`} data-claim={b.claim} data-claim-status={status}>
          {b.blocks.map((x, i) => (
            <Block key={i} b={x} dict={dict} soon={state} />
          ))}
        </section>
      );
    }
  }
}

export function DocsArticle({ doc, dict }: { doc: ParsedDoc; dict: Dictionary }) {
  return (
    <article className="prose docs">
      <h1>{doc.heading}</h1>
      <p className="lead">
        <InlineView inline={doc.lead} />
      </p>
      {doc.blocks.map((b, i) => (
        <Block key={i} b={b} dict={dict} soon={{ pending: false }} />
      ))}
    </article>
  );
}
