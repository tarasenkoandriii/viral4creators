/**
 * Карточки обзора Publisher от P-G2 (реестр `PUBLISHER_HOME_CARDS`):
 * предупреждения бюджета, просроченные первые контакты и отметка
 * «очередь проверена сегодня», состояние интеграций — никогда не
 * «зелёный» при неизвестном (ТЗ §8.4).
 */
import { Badge } from '../../../kit/ui';
import { useAsync } from '../../../kit';
import {
  budgetTone,
  integrationTone,
  integrationsProblems,
  kyivToday,
} from '../../../lib/publisher/ops-view';
import { fmtMinor, fmtText } from '../../../lib/publisher/view';
import { Loadable, RecordLink, Section } from '../parts';
import { useOps } from './ops-hooks';

export function BudgetHomeCard() {
  const { o, dist, pid, locale } = useOps();
  const state = useAsync(() => dist.budget(pid), [pid]);
  return (
    <Section
      title={o.home.budget}
      action={<RecordLink section="budget">{o.common.open}</RecordLink>}
    >
      <Loadable state={state}>
        {(b) => (
          <div className="space-y-1 text-sm">
            {!b.built ? (
              <Badge tone="danger">{o.budget.notBuilt}</Badge>
            ) : b.warnings.length === 0 ? (
              <span>
                {fmtText(o.home.budgetOk, {
                  v: fmtMinor(
                    b.available,
                    b.currency,
                    locale,
                    o.common.unknown
                  ),
                })}
              </span>
            ) : (
              b.warnings.map((w) => (
                <div key={w}>
                  <Badge tone={budgetTone(b)}>{o.budget.warnings[w]}</Badge>
                </div>
              ))
            )}
          </div>
        )}
      </Loadable>
    </Section>
  );
}

export function LeadsHomeCard() {
  const { o, leads, pid, can } = useOps();
  const today = kyivToday();
  const state = useAsync(
    () =>
      Promise.all([
        leads.leads(pid, { status: 'new', test: 'exclude', limit: 100 }),
        can('queue.check') ? leads.queueChecks(pid) : Promise.resolve(null),
      ]),
    [pid]
  );
  return (
    <Section
      title={o.home.leads}
      action={<RecordLink section="leads">{o.common.open}</RecordLink>}
    >
      <Loadable state={state}>
        {([page, checks]) => {
          const overdue = page.items.filter((l) => l.overdue).length;
          const checked = checks?.items.some((c) => c.workDate === today);
          return (
            <div className="space-y-1 text-sm">
              {overdue > 0 ? (
                <Badge tone="danger">
                  {fmtText(o.home.overdue, { n: overdue })}
                </Badge>
              ) : (
                <span>{o.home.noOverdue}</span>
              )}
              {checks && (
                <div>
                  <Badge tone={checked ? 'neutral' : 'warning'}>
                    {checked ? o.leads.queueCheck : o.leads.queueNotChecked}
                  </Badge>
                </div>
              )}
            </div>
          );
        }}
      </Loadable>
    </Section>
  );
}

export function IntegrationsHomeCard() {
  const { o, reports, pid } = useOps();
  const state = useAsync(() => reports.integrations(pid), [pid]);
  return (
    <Section
      title={o.home.integrations}
      action={
        <RecordLink section="reports" query={{ tab: 'sources' }}>
          {o.common.open}
        </RecordLink>
      }
    >
      <Loadable state={state}>
        {(list) => {
          const bad = integrationsProblems(list);
          return bad.length === 0 ? (
            <Badge tone="success">{o.home.integrationsOk}</Badge>
          ) : (
            <div className="flex flex-wrap gap-1">
              {bad.map((i) => (
                <Badge key={i.kind} tone={integrationTone(i)}>
                  {o.reports.integrationKinds[i.kind]}
                </Badge>
              ))}
            </div>
          );
        }}
      </Loadable>
    </Section>
  );
}
