/**
 * AI Publisher (P-G1) — оболочка раздела `#/sites/:siteId/publisher/*`
 * (§14.1): продукт сайта (или экран создания — только `publisher=admin`),
 * навигация по реестру `registry.ts` (P-G1 и P-G2), контекст экранов.
 * Видимость вкладок — подсказка по матрице §4.2; права проверяет сервер на
 * каждом запросе (AT-CORE-11), поэтому «скрытый» раздел, открытый прямой
 * ссылкой, честно покажет 403 сервера.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiError, useAsync, useKit } from '../../kit';
import { Alert, Badge, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { navigate } from '../../lib/router';
import { createCoreApi, type ProductView } from '../../lib/publisher/core-api';
import { getPublisherDict } from '../../lib/publisher/i18n';
import {
  canAny,
  canCreateProduct,
  canDo,
  type PubAction,
} from '../../lib/publisher/permissions';
import { GATE_NAMES } from '../../lib/publisher/states';
import { fmtText } from '../../lib/publisher/view';
import { useMutation } from './hooks';
import { Field, GateBrief, Select, TextInput } from './parts';
import {
  PublisherContext,
  usePublisher,
  type PubQuery,
  type PublisherValue,
} from './publisher-context';
import { PublisherHome } from './core/PublisherHome';
import {
  HIDDEN_SECTIONS,
  NAV_GROUPS,
  PUBLISHER_SECTIONS,
  findSection,
  sectionEnabled,
} from './registry';

export function PublisherShell({
  siteId,
  section,
  id,
  query,
}: {
  siteId: string;
  section: string | null;
  id: string | null;
  query: PubQuery;
}) {
  const { locale, account } = useKit();
  const { publisher } = useAssist();
  const t = getPublisherDict(locale);
  const core = useMemo(() => createCoreApi(publisher.http), [publisher.http]);
  const product = useAsync<ProductView | 'none'>(async () => {
    try {
      return await core.siteProduct(siteId);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PUB_PRODUCT_NONE') return 'none';
      throw e;
    }
  }, [core, siteId]);

  const href = useCallback(
    (s?: string | null, i?: string | null, q?: PubQuery) =>
      `#/sites/${siteId}/publisher${s ? `/${s}` : ''}${s && i ? `/${i}` : ''}${
        q && Object.keys(q).length
          ? `?${Object.keys(q)
              .sort()
              .map(
                (k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`
              )
              .join('&')}`
          : ''
      }`,
    [siteId]
  );
  const go = useCallback(
    (s?: string | null, i?: string | null, q?: PubQuery) =>
      navigate({
        name: 'publisher',
        siteId,
        section: s ?? null,
        id: s && i ? i : null,
        ...(q && Object.keys(q).length ? { query: q } : {}),
      }),
    [siteId]
  );

  if (product.loading && !product.data) {
    return <Spinner label={t.common.loading} />;
  }
  if (product.error || !product.data) {
    return (
      <div className="space-y-3">
        <ScreenTitle>{t.title}</ScreenTitle>
        <PublisherErrorStandalone error={product.error} t={t} />
        <Button variant="outline" onClick={product.reload}>
          {t.common.retry}
        </Button>
      </div>
    );
  }
  if (product.data === 'none') {
    return (
      <CreateProduct
        siteId={siteId}
        canCreate={canCreateProduct(account.me)}
        onCreated={(p) => product.setData(p)}
      />
    );
  }

  const p = product.data;
  const value: PublisherValue = {
    siteId,
    product: p,
    roles: p.myRoles,
    can: (a: PubAction) => canDo(p.myRoles, a),
    reloadProduct: product.reload,
    http: publisher.http,
    aiHttp: publisher.aiHttp,
    locale,
    t,
    href,
    go,
    memberId: account.me.memberId,
  };

  return (
    <PublisherContext.Provider value={value}>
      <ShellFrame section={section} id={id} query={query} />
    </PublisherContext.Provider>
  );
}

/** Ошибка до появления контекста (нет `usePublisher`). */
function PublisherErrorStandalone({
  error,
  t,
}: {
  error: Error | null;
  t: ReturnType<typeof getPublisherDict>;
}) {
  if (error instanceof ApiError) {
    const code = error.code as keyof typeof t.errors.codes;
    const text = Object.prototype.hasOwnProperty.call(t.errors.codes, code)
      ? t.errors.codes[code]
      : error.message;
    return (
      <Alert tone="danger" title={t.errors.title}>
        {text}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={t.errors.title}>
      {error?.message ?? ''}
    </Alert>
  );
}

function ShellFrame({
  section,
  id,
  query,
}: {
  section: string | null;
  id: string | null;
  query: PubQuery;
}) {
  const { product: p, t, roles, href, locale } = usePublisher();
  const visible = PUBLISHER_SECTIONS.filter(
    (s) =>
      !HIDDEN_SECTIONS.has(s.key) &&
      sectionEnabled(s, p.features) &&
      canAny(roles, s.actions)
  );
  // Раздел за выключенным флагом сервера — как несуществующий (AT-RD-17).
  const found = findSection(section);
  const current = found && sectionEnabled(found, p.features) ? found : null;
  const activeKey =
    section === 'briefs' ? 'plan' : section === null ? '' : section;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <ScreenTitle>
          <a href={href(null)} className="hover:underline">
            {p.name}
          </a>
        </ScreenTitle>
        <div className="flex flex-wrap gap-1">
          <Badge tone="neutral">{t.product.kinds[p.kind]}</Badge>
          <Badge tone={p.mode === 'live' ? 'accent' : 'neutral'}>
            {t.product.modes[p.mode]}
          </Badge>
          {p.status === 'archived' && (
            <Badge tone="warning">{t.product.statuses.archived}</Badge>
          )}
          {GATE_NAMES.map((g) => (
            <GateBrief key={g} gate={g} value={p.gates[g]} />
          ))}
        </div>
        {(p.kind === 'eval' || p.kind === 'restored') && (
          <Alert tone="warning">
            {fmtText(t.product.readOnlyKind, { kind: t.product.kinds[p.kind] })}
          </Alert>
        )}
      </div>
      <nav
        aria-label={t.nav.label}
        className="-mx-1 flex gap-1 overflow-x-auto pb-1"
      >
        <NavLink active={activeKey === ''} href={href(null)}>
          {t.nav.overview}
        </NavLink>
        {NAV_GROUPS.flatMap((g) =>
          visible
            .filter((s) => s.group === g)
            .sort((a, b) => a.order - b.order)
            .map((s) => {
              const Icon = s.icon;
              return (
                <NavLink
                  key={s.key}
                  active={activeKey === s.key}
                  href={href(s.key)}
                  title={t.nav.groups[g]}
                >
                  <Icon size={14} />
                  {s.label(locale)}
                </NavLink>
              );
            })
        )}
      </nav>
      {section === null ? (
        <PublisherHome />
      ) : current ? (
        <>
          {!canAny(roles, current.actions) && (
            <Alert tone="neutral">{t.nav.hiddenHint}</Alert>
          )}
          <current.Screen
            key={`${current.key}-${id ?? ''}`}
            id={id}
            query={query}
          />
        </>
      ) : (
        <Alert tone="warning">{t.nav.sectionNotFound}</Alert>
      )}
    </div>
  );
}

function NavLink({
  active,
  href,
  title,
  children,
}: {
  active: boolean;
  href: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={`shrink-0 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm min-h-[36px] ${
        active
          ? 'bg-accent text-accent-on font-medium'
          : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-600 dark:text-silver-300'
      }`}
    >
      {children}
    </a>
  );
}

/** Экран создания продукта (только `publisher=admin`/владелец, §14.1). */
function CreateProduct({
  siteId,
  canCreate,
  onCreated,
}: {
  siteId: string;
  canCreate: boolean;
  onCreated: (p: ProductView) => void;
}) {
  const { locale } = useKit();
  const { publisher } = useAssist();
  const t = getPublisherDict(locale);
  const core = useMemo(() => createCoreApi(publisher.http), [publisher.http]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'working' | 'test' | 'eval' | ''>('working');
  const m = useMutation();
  return (
    <div className="space-y-3">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Alert tone="neutral" title={t.product.noneTitle}>
        {t.product.noneHint}
      </Alert>
      {!canCreate ? (
        <Alert tone="warning">{t.product.noAdmin}</Alert>
      ) : (
        <Card className="space-y-3">
          <div className="font-semibold">{t.product.createTitle}</div>
          <Field label={t.product.name}>
            <TextInput value={name} onChange={setName} maxLength={120} />
          </Field>
          <Field
            label={t.product.kind}
            hint={kind ? t.product.kindHints[kind] : undefined}
          >
            <Select
              value={kind}
              options={['working', 'test', 'eval'] as const}
              labels={t.product.kinds}
              onChange={setKind}
            />
          </Field>
          {m.error ? <StandaloneMutationError error={m.error} /> : null}
          <Button
            loading={m.busy}
            disabled={!name.trim() || !kind}
            onClick={async () => {
              if (!kind) return;
              const p = await m.run((opKey) =>
                core.createProduct(siteId, { name: name.trim(), kind }, opKey)
              );
              if (p) onCreated(p);
            }}
          >
            {t.product.create}
          </Button>
        </Card>
      )}
    </div>
  );
}

function StandaloneMutationError({ error }: { error: unknown }) {
  const { locale } = useKit();
  const t = getPublisherDict(locale);
  return (
    <PublisherErrorStandalone
      error={error instanceof Error ? error : new Error(String(error))}
      t={t}
    />
  );
}
