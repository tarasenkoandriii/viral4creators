import type { ReactNode } from 'react';
import { claimStatus, isClaimId, type ClaimId } from '../lib/claims';
import type { Dictionary } from '../lib/get-dictionary';

/**
 * Рендер утверждения по реестру (§3.0):
 *  - `hidden` → ничего (и в HTML его нет);
 *  - `soon`   → метка «скоро», и НИКАКИХ ссылок/кнопок внутри блока:
 *               `cta` выводится только у `live`;
 *  - `live`   → как обычно.
 * Атрибуты `data-claim`/`data-claim-status` — для проверок собранного
 * HTML (`scripts/built/check-built.ts`).
 */

type Tag = 'div' | 'li' | 'article' | 'section' | 'p';

export function SoonBadge({ dict }: { dict: Dictionary }) {
  return (
    <span className="badge-soon" title={dict.common.soonTitle}>
      {dict.common.soon}
    </span>
  );
}

function resolve(id: string): ClaimId {
  if (!isClaimId(id)) throw new Error(`Неизвестное утверждение «${id}» — заведите его в lib/claims.ts`);
  return id;
}

export function ClaimCard({
  claim,
  dict,
  title,
  text,
  as: Element = 'article',
  heading: Heading = 'h3',
  cta,
  className,
  headingId,
}: {
  claim: string;
  dict: Dictionary;
  title?: string;
  text?: ReactNode;
  as?: Tag;
  heading?: 'h2' | 'h3';
  cta?: { href: string; label: string };
  className?: string;
  headingId?: string;
}) {
  const id = resolve(claim);
  const status = claimStatus(id);
  if (status === 'hidden') return null;
  const soon = status === 'soon';
  return (
    <Element
      className={['claim', soon ? 'claim-soon' : 'claim-live', className].filter(Boolean).join(' ')}
      data-claim={id}
      data-claim-status={status}
    >
      {title !== undefined && (
        <Heading className="claim-title" id={headingId}>
          {title} {soon && <SoonBadge dict={dict} />}
        </Heading>
      )}
      {text !== undefined && (
        <p className="claim-text">
          {title === undefined && soon && (
            <>
              <SoonBadge dict={dict} />{' '}
            </>
          )}
          {text}
        </p>
      )}
      {cta && !soon && (
        <p className="claim-cta">
          <a className="button button-secondary" href={cta.href}>
            {cta.label}
          </a>
        </p>
      )}
    </Element>
  );
}

/** Виден ли блок по реестру — для секций, которые целиком из утверждений. */
export function visibleClaims<T extends { claim: string }>(items: readonly T[]): T[] {
  return items.filter((item) => claimStatus(resolve(item.claim)) !== 'hidden');
}

/**
 * Секция целиком под одним утверждением (например, таблицы тарифов под
 * `payment`): `hidden` — нет секции, `soon` — метка в заголовке. Ссылки
 * и кнопки внутри `soon`-секции запрещены так же, как в `ClaimCard`, —
 * это проверяет `scripts/built/check-built.ts` по собранному HTML.
 */
export function ClaimSection({
  claim,
  dict,
  heading,
  headingId,
  className,
  children,
}: {
  claim: string;
  dict: Dictionary;
  heading: string;
  headingId: string;
  className?: string;
  children: ReactNode;
}) {
  const id = resolve(claim);
  const status = claimStatus(id);
  if (status === 'hidden') return null;
  return (
    <section
      className={['claim', status === 'soon' ? 'claim-soon' : 'claim-live', className].filter(Boolean).join(' ')}
      data-claim={id}
      data-claim-status={status}
      aria-labelledby={headingId}
    >
      <h2 className="claim-title" id={headingId}>
        {heading} {status === 'soon' && <SoonBadge dict={dict} />}
      </h2>
      {children}
    </section>
  );
}
