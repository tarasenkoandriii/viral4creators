'use client';

// Вкладка «Помощник» — ИИ-помощник клиентских сайтов (ТЗ
// docs-tz/TZ-AI-Pomoshchnik-TMA.md §8, пункты 1–5 и 8; Э4). Данные живут в
// sites-backend; админка ходит туда через backend (/admin/assist/*,
// внутренний API с секретом) — у генератора нет доступа к схеме sites.
// Под-вкладки — client-side useState, как у «ИИ-консультанта».
// Текст ответов в «Ревью» уже маскирован (ПДн скрыты) и каждое открытие
// списка пишется в журнал доступа на стороне sites-backend.

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from '../../lib/admin-api';
import {
  assistApi,
  confirmThen,
  fmtDate,
  fmtMinor,
  fmtUsd,
  parseCapUsd,
  parseDays,
  type AssistAbuse,
  type AssistAccountDetail,
  type AssistAccountRow,
  type AssistCosts,
  type AssistReviewRow,
  type AssistSettings,
  type AssistSummary,
} from '../../lib/assist-platform';

type Tab = 'summary' | 'accounts' | 'review' | 'abuse' | 'settings' | 'costs';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'summary', label: 'Сводка' },
  { key: 'accounts', label: 'Кабинеты и сайты' },
  { key: 'review', label: 'Ревью' },
  { key: 'abuse', label: 'Анти-абьюз' },
  { key: 'settings', label: 'Настройки' },
  { key: 'costs', label: 'Расходы' },
];

const PLAN_IDS = ['trial', 'start', 'business', 'pro'];

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="critical" style={{ marginBottom: 12 }}>
      {error}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-tile">
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default function AssistPlatformPage() {
  const [tab, setTab] = useState<Tab>('summary');
  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Помощник</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        ИИ-помощник для клиентских сайтов: кабинеты, тарифы и оплата, ревью ответов, анти-абьюз, рубильник и
        расходы. Данные — из бэкенда клиентских сайтов.
      </p>
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border, #333)', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--accent, #4c8dff)' : '2px solid transparent',
              background: 'transparent',
              fontWeight: tab === t.key ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'summary' && <SummaryTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'review' && <ReviewTab />}
      {tab === 'abuse' && <AbuseTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'costs' && <CostsTab />}
    </div>
  );
}

// ── 1. Сводка ───────────────────────────────────────────────────────────

function SummaryTab() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AssistSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    assistApi.summary(days).then(setData).catch((e) => setError(errText(e)));
  }, [days]);
  const refused = data?.refusals.reduce((a, r) => a + r.count, 0) ?? 0;
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <select aria-label="Окно" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>сутки</option>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <Stat label="Кабинеты с помощником" value={`${data.assistAccounts} / ${data.accounts}`} />
            <Stat label="Сайты" value={data.assistSites} />
            <Stat label="Выручка" value={fmtUsd(data.revenueUsd)} />
            <Stat label="Расход ИИ" value={fmtUsd(data.spendUsd)} />
            <Stat label="Маржа" value={fmtUsd(data.marginUsd)} />
            <Stat
              label="Отказы (доля ответов)"
              value={data.answers ? `${((refused / data.answers) * 100).toFixed(1)}%` : '—'}
            />
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>Хосты по статусу подтверждения</h2>
            <p>{data.hostsByStatus.map((h) => `${h.status}: ${h.count}`).join(' · ') || '—'}</p>
            <h2 style={{ fontSize: 16 }}>Подписки</h2>
            <p>{data.subscriptions.map((s) => `${s.planId} (${s.status}): ${s.count}`).join(' · ') || '—'}</p>
            <h2 style={{ fontSize: 16 }}>Выручка по тарифам</h2>
            <p>
              {data.revenueByPlan.map((r) => `${r.planId ?? '—'}: ${fmtUsd(r.usd)} (${r.payments})`).join(' · ') ||
                '—'}
            </p>
            <h2 style={{ fontSize: 16 }}>Отказы по причинам</h2>
            <p>{data.refusals.map((r) => `${r.rule}: ${r.count}`).join(' · ') || '—'}</p>
          </div>
          <div className="card table-scroll">
            <h2 style={{ fontSize: 16 }}>Диалоги в сутки</h2>
            <table>
              <tbody>
                {data.dialogsPerDay.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── 2. Кабинеты и сайты ─────────────────────────────────────────────────

function AccountsTab() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AssistAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const search = useCallback(() => {
    setError(null);
    assistApi
      .accounts(q.trim())
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, [q]);
  useEffect(() => {
    assistApi
      .accounts('')
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, []);
  return (
    <div>
      <form
        className="filters"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          aria-label="Поиск"
          placeholder="домен, Telegram id владельца или id кабинета"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 320 }}
        />
        <button type="submit">Найти</button>
      </form>
      <ErrorBox error={error} />
      {rows && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Кабинет</th>
                <th>Владелец</th>
                <th>Домены</th>
                <th>Тариф</th>
                <th>Единицы</th>
                <th>Оплачено до</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.accountId}
                  onClick={() => setSelected(r.accountId)}
                  style={{ cursor: 'pointer', fontWeight: selected === r.accountId ? 600 : 400 }}
                >
                  <td>{r.accountId}</td>
                  <td>{r.ownerTelegramId ?? '—'}</td>
                  <td>{r.domains.join(', ') || '—'}</td>
                  <td>
                    {r.plan ?? '—'} <span className="muted">({r.status}, {r.method})</span>
                  </td>
                  <td>
                    {r.units} / {r.limit}
                  </td>
                  <td>{fmtDate(r.paidThrough)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <AccountPanel id={selected} />}
    </div>
  );
}

function AccountPanel({ id }: { id: string }) {
  const [d, setD] = useState<AssistAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState('start');
  const [days, setDays] = useState(30);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setD(null);
    setError(null);
    assistApi
      .account(id)
      .then(setD)
      .catch((e) => setError(errText(e)));
  }, [id]);
  // Каждое действие — после подтверждения оператора (confirmThen).
  const act = (text: string, run: () => Promise<AssistAccountDetail>) => {
    const p = confirmThen(text, run);
    if (!p) return;
    setBusy(true);
    setError(null);
    p.then(setD)
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ fontSize: 16 }}>Кабинет {id}</h2>
      <ErrorBox error={error} />
      {d && (
        <>
          <p>
            Тариф: <b>{d.state.planId ?? 'нет'}</b> ({d.state.status}, {d.state.method}); период {fmtDate(d.state.periodStart)} —{' '}
            {fmtDate(d.state.periodEnd)}; оплачено до {fmtDate(d.state.paidThrough)}. Единицы: {d.usage.units} / {d.usage.limit}{' '}
            (докуплено {d.usage.extraUnits}).
            {d.subscription?.note ? ` Пометка: ${d.subscription.note}.` : ''}
            {d.subscription?.lastRenewError ? ` Продление: ${d.subscription.lastRenewError} (${d.subscription.renewAttempts}).` : ''}
          </p>
          <div className="filters" style={{ marginBottom: 12 }}>
            <select aria-label="Тариф" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {PLAN_IDS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              aria-label="Дней"
              type="number"
              min={1}
              max={730}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              style={{ width: 80 }}
            />
            <input aria-label="Пометка" placeholder="пометка (пилот…)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              disabled={busy || parseDays(days) === null}
              onClick={() =>
                act(`Задать кабинету ${id} тариф ${planId} на ${days} дн.? Текущий тариф будет заменён.`, () =>
                  assistApi.setPlan(id, planId, days, note || undefined),
                )
              }
            >
              Задать тариф вручную
            </button>
            <button
              type="button"
              disabled={busy || parseDays(days) === null}
              onClick={() => act(`Продлить тариф кабинета ${id} на ${days} дн.?`, () => assistApi.extend(id, days))}
            >
              Продлить на {days} дн.
            </button>
          </div>
          <h3 style={{ fontSize: 14 }}>Сайты</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {d.sites.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.name}</td>
                    <td>{s.hosts.map((h) => `${h.host} (${h.status})`).join(', ')}</td>
                    <td>{s.enabled ? 'включён' : 'выключен'}{s.chatPaused ? ', пауза владельца' : ''}</td>
                    <td>потолок/сутки: {s.dailyCapUsd === null ? 'по тарифу' : fmtUsd(s.dailyCapUsd)}</td>
                    <td>
                      <button
                        type="button"
                        className={s.blocked ? undefined : 'button-danger'}
                        disabled={busy}
                        onClick={() =>
                          act(
                            s.blocked
                              ? `Снять блокировку с сайта «${s.name}»?`
                              : `Заблокировать сайт «${s.name}»? Виджет перестанет отвечать посетителям.`,
                            () => assistApi.setSite(s.siteId, { blocked: !s.blocked }),
                          )
                        }
                      >
                        {s.blocked ? 'Снять блокировку' : 'Заблокировать'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ fontSize: 14 }}>Платежи</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {d.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.createdAt)}</td>
                    <td>{p.kind}</td>
                    <td>{p.planId ?? '—'}</td>
                    <td>{p.method}</td>
                    <td>{fmtMinor(p.amountMinor, p.currency)}</td>
                    <td>{p.status}{p.failureReason ? ` (${p.failureReason})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            Документы: {d.legal.map((l) => `${l.document} ${l.version}${l.current ? '' : ' (старая)'}${l.evalConsent ? ', согласие на eval' : ''}`).join('; ') || 'не приняты'}
          </p>
          <div className="filters">
            <input
              aria-label="Сообщение владельцу"
              placeholder="Написать владельцу в бот Помощника"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              style={{ minWidth: 360 }}
            />
            <button
              type="button"
              disabled={busy || !message.trim()}
              onClick={() => {
                const sending = confirmThen(`Отправить владельцу кабинета ${id} сообщение в бот Помощника?`, () =>
                  assistApi.message(id, message),
                );
                if (!sending) return;
                setBusy(true);
                sending
                  .then((r) => {
                    setMessage('');
                    setError(r.sent ? null : 'Не доставлено: владелец не запускал бота или бот не настроен');
                  })
                  .catch((e) => setError(errText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Отправить
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── 3. Ревью ────────────────────────────────────────────────────────────

function ReviewTab() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<AssistReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setError(null);
    assistApi
      .review(days)
      .then(setRows)
      .catch((e) => setError(errText(e)));
  }, [days]);
  return (
    <div>
      <p className="muted">
        Флагованные ответы режима «Сайт» и 👎 посетителей. Текст маскирован; открытие списка записано в журнал доступа.
        «В eval» — только если заказчик дал согласие в DPA; ответы «Админки» сюда не попадают никогда.
      </p>
      <div className="filters" style={{ marginBottom: 12 }}>
        <select aria-label="Окно" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {rows && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Вопрос</th>
                <th>Ответ</th>
                <th>Флаги</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.messageId}>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td style={{ maxWidth: 260 }}>{r.question ?? '—'}</td>
                  <td style={{ maxWidth: 360 }}>{r.answer}</td>
                  <td>
                    {r.flags.join(', ')}
                    {r.rating === -1 ? ' 👎' : ''}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={!r.evalConsent || added[r.messageId]}
                      title={r.evalConsent ? '' : 'Нет согласия заказчика в DPA'}
                      onClick={() =>
                        confirmThen('Добавить этот ответ в eval-набор платформы (обезличенно)?', () =>
                          assistApi.addToEval(r.messageId),
                        )
                          ?.then(() => setAdded((a) => ({ ...a, [r.messageId]: true })))
                          .catch((e) => setError(errText(e)))
                      }
                    >
                      {added[r.messageId] ? 'В eval' : 'В eval платформы'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 4. Анти-абьюз ───────────────────────────────────────────────────────

function AbuseTab() {
  const [data, setData] = useState<AssistAbuse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const load = useCallback(() => {
    setError(null);
    assistApi
      .abuse(7)
      .then(setData)
      .catch((e) => setError(errText(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>Подозрительный трафик (7 дней)</h2>
            <table>
              <tbody>
                {data.suspicious.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.siteId}</td>
                    <td>{s.accountId}</td>
                    <td>
                      {s.suspicious} из {s.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2 style={{ fontSize: 16 }}>Всплески (сегодня ≥ 3× среднего)</h2>
            <table>
              <tbody>
                {data.spikes.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.siteId}</td>
                    <td>сегодня {s.today}</td>
                    <td>в среднем {s.avgPerDay}/сут</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2 style={{ fontSize: 16 }}>Отказ доменов от обхода (общий с QA)</h2>
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                const d = domain.trim();
                if (!d) return;
                confirmThen(`Внести ${d} в opt-out? Обход домена прекратится (общий список с QA).`, () =>
                  assistApi.addOptOut(d),
                )
                  ?.then(() => {
                    setDomain('');
                    load();
                  })
                  .catch((err) => setError(errText(err)));
              }}
            >
              <input aria-label="Домен" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
              <button type="submit">Добавить</button>
            </form>
            <table>
              <tbody>
                {data.optOut.map((o) => (
                  <tr key={o.domain}>
                    <td>{o.domain}</td>
                    <td className="muted">{o.source}</td>
                    <td>{fmtDate(o.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          confirmThen(`Убрать ${o.domain} из opt-out? Обход домена снова станет возможен.`, () =>
                            assistApi.removeOptOut(o.domain),
                          )
                            ?.then(load)
                            .catch((err) => setError(errText(err)))
                        }
                      >
                        Убрать
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── 5. Настройки ────────────────────────────────────────────────────────

function SettingsTab() {
  const [s, setS] = useState<AssistSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  useEffect(() => {
    assistApi
      .settings()
      .then((v) => {
        setS(v);
        setCap(v.widget.dailyCapUsd === null ? '' : String(v.widget.dailyCapUsd));
      })
      .catch((e) => setError(errText(e)));
  }, []);
  const save = (text: string, body: { enabled?: boolean; dailyCapUsd?: number | null }) => {
    setError(null);
    confirmThen(text, () => assistApi.setSettings(body))
      ?.then(setS)
      .catch((e) => setError(errText(e)));
  };
  return (
    <div>
      <ErrorBox error={error} />
      {s && (
        <div className="card">
          <p>
            Рубильник виджета платформы: <b>{s.widget.enabled ? 'включён' : 'ВЫКЛЮЧЕН — все виджеты принимают только заявки'}</b>
            {!s.env.widgetEnabled && ' (env ASSIST_WIDGET_ENABLED=false — сильнее админки)'}
          </p>
          <button
            type="button"
            className={s.widget.enabled ? 'button-danger' : undefined}
            onClick={() =>
              save(s.widget.enabled ? 'Выключить ответы ИИ на всех сайтах?' : 'Включить ответы ИИ на всех сайтах?', {
                enabled: !s.widget.enabled,
              })
            }
          >
            {s.widget.enabled ? 'Выключить виджеты' : 'Включить виджеты'}
          </button>
          <p style={{ marginTop: 16 }}>
            Суточный потолок платформы: env {fmtUsd(s.env.platformDailyCapUsd)} (верхняя граница); из админки —{' '}
            {s.widget.dailyCapUsd === null ? 'не задан' : fmtUsd(s.widget.dailyCapUsd)}.
          </p>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              const v = parseCapUsd(cap);
              if (!v.ok) {
                setError('Потолок — число от 0 до 1000 (USD) или пусто');
                return;
              }
              save(
                v.value === null
                  ? 'Снять потолок админки (останется только env)?'
                  : `Установить суточный потолок платформы ${fmtUsd(v.value)}?`,
                { dailyCapUsd: v.value },
              );
            }}
          >
            <input aria-label="Потолок, USD" placeholder="пусто — как в env" value={cap} onChange={(e) => setCap(e.target.value)} />
            <button type="submit">Сохранить потолок</button>
          </form>
          <p className="muted" style={{ marginTop: 16 }}>
            Модели (только чтение): ответ — {s.models.chat}, эмбеддинги — {s.models.embeddings}. Публичная песочница:{' '}
            {s.env.sandboxPublicEnabled ? 'включена' : 'выключена'}. Курсы оплаты: {s.rates.uahPerUsd} грн/$,{' '}
            {s.rates.starsPerUsd} ⭐/$.
          </p>
          <table>
            <tbody>
              {s.plans.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>${p.priceUsdMonthly}/мес</td>
                  <td>{p.dialogsPerMonth} диалогов</td>
                  <td>{p.overageUsdPer100 === null ? 'без докупки' : `$${p.overageUsdPer100}/100`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 8. Расходы ──────────────────────────────────────────────────────────

function CostsTab() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AssistCosts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    assistApi
      .costs(days)
      .then(setData)
      .catch((e) => setError(errText(e)));
  }, [days]);
  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <select aria-label="Окно" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
          <option value={90}>90 дней</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>assist-* по операциям (site_ai_usage)</h2>
            <table>
              <tbody>
                {data.byOperation.map((r) => (
                  <tr key={r.operation}>
                    <td>{r.operation}</td>
                    <td>{fmtUsd(r.usd)}</td>
                    <td className="muted">{r.calls} вызовов</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2 style={{ fontSize: 16 }}>Топ-10 сайтов по себестоимости и выручка их кабинета</h2>
            <table>
              <tbody>
                {data.topSites.map((r) => (
                  <tr key={r.siteId}>
                    <td>{r.siteId}</td>
                    <td>{fmtUsd(r.costUsd)}</td>
                    <td>выручка {fmtUsd(r.accountRevenueUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
