'use client';

// Пользователи — ТЗ §25 (этап 30). До этого экрана и режим (`users.plan`,
// этап 29), и флаг оператора (`isOperator`) правились только через psql.
// Пока разработчик и оператор — один человек, это терпимо; как только нет
// — нет.
//
// Здесь можно: найти пользователя, увидеть, что он вообще делал (сессии,
// проекты, манифесты, разборы, заявки), сменить режим и выдать/снять права
// оператора. С этапа 31 здесь же — блокировка (§25.3, запрет платных
// вызовов с причиной, которую увидит сам пользователь) и расход на ИИ
// (§26) колонкой в списке и разбивкой по операциям в карточке.
//
// Удаления пользователя намеренно нет: оно уносит каскадом проекты,
// манифесты и заявки, а разборы библиотеки оставляет без автора — такое
// не делают в один клик из списка.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adjustCredit, cancelSubscription, getUser, listUsers, patchUser } from '../../lib/endpoints';
import type {
  AdminUserDetail,
  AdminUserListResult,
  AdminUserSummary,
  PlanId,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';
import { operationLabel, usd } from '../../lib/money';
import { useAdminAuth } from '../../lib/admin-auth-context';

const PLAN_LABEL: Record<PlanId, string> = {
  LITE: 'Lite',
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
};
const PLAN_ORDER: PlanId[] = ['LITE', 'STANDARD', 'PREMIUM'];

// Этап 62 (ТЗ §41): статус подписки — вложенный в AdminUserSummary объект,
// null у Lite/тех, кто ничего не покупал.
const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'активна',
  PAST_DUE: 'просрочена',
  CANCELED: 'отменена',
};

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function displayName(u: AdminUserSummary): string {
  if (u.username) return `@${u.username}`;
  if (u.firstName) return u.firstName;
  return u.telegramId;
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

/** «1 заявка / 2 заявки / 5 заявок» — счётчиков здесь шесть штук в строке,
 * и с одной формой на все числа таблица читается как черновик. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return `${n} ${few}`;
  return `${n} ${many}`;
}

export default function UsersPage() {
  const { me } = useAdminAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState('');
  const [operatorsOnly, setOperatorsOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminUserListResult | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Этап 50 (В-5.10, В-5.12, В-5.13): поколение запроса — устаревший
  // ответ (страница 2 пришла позже страницы 3) не затирает свежий; ошибка
  // сбрасывается перед каждой загрузкой, а не висит над свежими данными;
  // `load` можно дёрнуть кнопкой «Повторить», когда фильтры не менялись.
  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setError(null);
    listUsers({
      q: query || undefined,
      plan: plan || undefined,
      operators: operatorsOnly ? '1' : undefined,
      blocked: blockedOnly ? '1' : undefined,
      page,
      pageSize: 20,
    })
      .then((r) => {
        if (gen === loadGen.current) setResult(r);
      })
      .catch((e) => {
        if (gen === loadGen.current) setError(errText(e));
      });
  }, [query, plan, operatorsOnly, blockedOnly, page]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async (
    id: string,
    body: {
      plan?: PlanId;
      isOperator?: boolean;
      isBlocked?: boolean;
      blockedReason?: string;
    }
  ) => {
    setBusy(id);
    setError(null);
    try {
      const updated = await patchUser(id, body);
      if (detail?.id === id) setDetail(updated);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleBlocked = (u: AdminUserSummary) => {
    if (u.isBlocked) {
      void apply(u.id, { isBlocked: false });
      return;
    }
    // Причина не косметика: она дословно попадает в текст отказа, который
    // увидит сам пользователь, когда попробует запустить разбор.
    const reason = window.prompt(
      `Причина блокировки ${displayName(u)}? Она войдёт в текст отказа, который увидит пользователь. Платные операции станут недоступны; проекты и готовые ролики останутся.`,
      u.blockedReason ?? ''
    );
    if (reason === null) return;
    void apply(u.id, { isBlocked: true, blockedReason: reason.trim() });
  };

  const toggleOperator = (u: AdminUserSummary) => {
    const next = !u.isOperator;
    if (
      next &&
      !window.confirm(
        `Выдать ${displayName(u)} права оператора? Он получит доступ ко всей админке: сессиям, модерации публикаций, библиотеке и этому экрану.`
      )
    ) {
      return;
    }
    void apply(u.id, { isOperator: next });
  };

  /** Отмена подписки — саппорт-действие (ТЗ §41): доступ остаётся до
   * конца уже оплаченного периода, деньги не возвращаются (для этого
   * есть отдельная кнопка «Возврат» на странице /payments). */
  const handleCancelSubscription = (u: AdminUserSummary) => {
    if (
      !window.confirm(
        `Отменить подписку ${displayName(u)}? Доступ к ${u.subscription?.plan ?? 'оплаченному режиму'} останется до конца текущего периода (${
          u.subscription ? date(u.subscription.currentPeriodEnd) : '—'
        }), дальше пользователь перейдёт в Lite. Деньги за уже оплаченный период не возвращаются.`
      )
    ) {
      return;
    }
    setBusy(u.id);
    setError(null);
    cancelSubscription(u.id)
      .then((updated) => {
        if (detail?.id === u.id) setDetail(updated);
        load();
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  /** Е-1.5 шестого аудита: ручная правка баланса кредитов — компенсация
   * или исправление ошибки, без привязки к платежу. `window.prompt` —
   * тот же приём, что у причины блокировки выше: значение не косметика,
   * оно уходит прямо в тело запроса. */
  const handleAdjustCredit = (u: AdminUserSummary) => {
    const raw = window.prompt(
      `На сколько изменить баланс кредитов ${displayName(u)} (сейчас ${u.credits.balance})? Положительное число — начислить, отрицательное — списать. Например: 5 или -2.`
    );
    if (raw === null) return;
    const delta = Number(raw.trim());
    if (!Number.isInteger(delta) || delta === 0) {
      setError('Дельта кредита должна быть целым числом, отличным от нуля');
      return;
    }
    if (
      !window.confirm(
        `${delta > 0 ? 'Начислить' : 'Списать'} ${Math.abs(delta)} кредит(ов) ${displayName(u)}? Действие пишется в лог и видно только через логи сервера.`
      )
    ) {
      return;
    }
    setBusy(u.id);
    setError(null);
    adjustCredit(u.id, delta)
      .then((updated) => {
        if (detail?.id === u.id) setDetail(updated);
        load();
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(null));
  };

  return (
    <main className="admin-main">
      <h1>Пользователи</h1>
      <p className="muted">
        Режим сервиса (§23) и права оператора. Список — только
        идентифицированные пользователи: анонимные сессии не заводят строку
        в базе и работают в Lite.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
        className="filters"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0' }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="telegramId, @username или имя"
          aria-label="Поиск пользователя"
          style={{ minWidth: 260 }}
        />
        <select
          aria-label="Фильтр по режиму"
          value={plan}
          onChange={(e) => {
            setPage(1);
            setPlan(e.target.value);
          }}
        >
          <option value="">Любой режим</option>
          {PLAN_ORDER.map((id) => (
            <option key={id} value={id}>
              {PLAN_LABEL[id]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={operatorsOnly}
            onChange={(e) => {
              setPage(1);
              setOperatorsOnly(e.target.checked);
            }}
          />
          только операторы
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={blockedOnly}
            onChange={(e) => {
              setPage(1);
              setBlockedOnly(e.target.checked);
            }}
          />
          только заблокированные
        </label>
        <button type="submit">Искать</button>
      </form>

      {error && (
        <p className="critical">
          {error}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}

      {result && (
        <>
          <p className="muted">
            Найдено: {result.total}. Всего в базе — Lite {result.byPlan.LITE},
            Standard {result.byPlan.STANDARD}, Premium {result.byPlan.PREMIUM};
            операторов {result.operators}; заблокированных {result.blocked}.
          </p>

          {/* Шесть колонок с датами, суммами и тремя кнопками в ряд
              сжимать некуда — прокрутка уезжает внутрь обёртки, а не в
              документ (А-3.2). */}
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Пользователь</th>
                  <th style={{ textAlign: 'left' }}>Режим</th>
                  <th style={{ textAlign: 'left' }}>Кредиты / подписка</th>
                  <th style={{ textAlign: 'left' }}>Активность</th>
                  <th style={{ textAlign: 'right' }}>Расход</th>
                  <th style={{ textAlign: 'left' }}>Оферта</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.items.map((u) => (
                  <tr key={u.id} style={{ borderTop: '1px solid #333' }}>
                    <td style={{ padding: '8px 0' }}>
                      <strong>{displayName(u)}</strong>
                      {u.isOperator && (
                        <span className="badge-status badge-status-ok" style={{ marginLeft: 8 }}>
                          оператор
                        </span>
                      )}
                      {u.isBlocked && (
                        <span
                          className="badge-status badge-status-critical"
                          style={{ marginLeft: 8 }}
                        >
                          заблокирован
                        </span>
                      )}
                      {me?.userId === u.id && (
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                          это вы
                        </span>
                      )}
                      {u.blockedReason && (
                        <div className="critical" style={{ fontSize: 12 }}>
                          Причина: {u.blockedReason}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.telegramId} · с {date(u.createdAt)}
                      </div>
                    </td>
                    <td>
                      <select
                        aria-label={`Режим пользователя ${u.telegramId}`}
                        value={u.plan}
                        disabled={busy === u.id}
                        onChange={(e) =>
                          void apply(u.id, { plan: e.target.value as PlanId })
                        }
                      >
                        {PLAN_ORDER.map((id) => (
                          <option key={id} value={id}>
                            {PLAN_LABEL[id]}
                          </option>
                        ))}
                      </select>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.planSince ? `с ${date(u.planSince)}` : 'по умолчанию'}
                        {u.planSelfService && (
                          <>
                            {' · '}
                            <span title="Режим выбран пользователем самостоятельно: функции режима доступны, суточный потолок расхода — как у Lite. Назначьте режим здесь, чтобы поднять потолок.">
                              выбран сам, потолок Lite
                            </span>
                          </>
                        )}
                      </div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div>{plural(u.credits.balance, 'кредит', 'кредита', 'кредитов')}</div>
                      {u.subscription ? (
                        <div className="muted" style={{ marginTop: 2 }}>
                          {u.subscription.plan} ·{' '}
                          {SUBSCRIPTION_STATUS_LABEL[u.subscription.status] ?? u.subscription.status}
                          {u.subscription.cancelAtPeriodEnd && ' (отменяется)'}
                          <div>до {date(u.subscription.currentPeriodEnd)}</div>
                        </div>
                      ) : (
                        <div className="muted" style={{ marginTop: 2 }}>без подписки</div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {plural(u.counts.sessions, 'сессия', 'сессии', 'сессий')} ·{' '}
                      {plural(u.counts.projects, 'проект', 'проекта', 'проектов')}
                      <div>
                        {plural(
                          u.counts.brandManifests,
                          'манифест',
                          'манифеста',
                          'манифестов'
                        )}{' '}
                        ·{' '}
                        {plural(
                          u.counts.libraryEntries,
                          'разбор',
                          'разбора',
                          'разборов'
                        )}{' '}
                        ·{' '}
                        {plural(u.counts.publications, 'заявка', 'заявки', 'заявок')}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {usd(u.costMicroUsd)}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.costCalls} выз.
                      </div>
                      {/* Сегодня против потолка (§26.4) — по этой строке
                          видно, кто упёрся в лимит и почему жалуется. */}
                      <div
                        className={
                          u.spentTodayMicroUsd >= u.dailyLimitMicroUsd
                            ? 'critical'
                            : 'muted'
                        }
                        style={{ fontSize: 12 }}
                      >
                        сегодня {usd(u.spentTodayMicroUsd)} /{' '}
                        {usd(u.dailyLimitMicroUsd)}
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {u.termsVersion ? (
                        <>
                          {u.termsVersion}
                          <div>{date(u.termsAcceptedAt)}</div>
                        </>
                      ) : (
                        'не принята'
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        disabled={busy === u.id}
                        onClick={() =>
                          void getUser(u.id)
                            .then(setDetail)
                            .catch((e) => setError(errText(e)))
                        }
                      >
                        Сессии
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy === u.id || (u.isOperator && me?.userId === u.id)}
                        title={
                          u.isOperator && me?.userId === u.id
                            ? 'Нельзя снять права с самого себя — иначе некому будет вернуть'
                            : undefined
                        }
                        onClick={() => toggleOperator(u)}
                      >
                        {u.isOperator ? 'Снять оператора' : 'Сделать оператором'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy === u.id || me?.userId === u.id}
                        title={
                          me?.userId === u.id
                            ? 'Нельзя заблокировать самого себя'
                            : undefined
                        }
                        onClick={() => toggleBlocked(u)}
                      >
                        {u.isBlocked ? 'Разблокировать' : 'Заблокировать'}
                      </button>{' '}
                      <button
                        type="button"
                        disabled={busy === u.id}
                        onClick={() => handleAdjustCredit(u)}
                      >
                        Кредиты
                      </button>{' '}
                      {u.subscription && u.subscription.status !== 'CANCELED' && !u.subscription.cancelAtPeriodEnd && (
                        <button
                          type="button"
                          disabled={busy === u.id}
                          onClick={() => handleCancelSubscription(u)}
                        >
                          Отменить подписку
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              disabled={result.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Назад
            </button>
            <button
              type="button"
              disabled={result.page * result.pageSize >= result.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </button>
          </div>
        </>
      )}

      {detail && (
        <section className="card" style={{ marginTop: 24 }}>
          {/* Б-4.1: имя в Telegram бывает длиной до 64 символов и без
              единого пробела. Flex-строка без `min-width: 0` не даёт
              заголовку сжаться — документ растягивался до 1597px, а
              кнопка «Закрыть» уезжала за экран, и закрыть карточку без
              горизонтальной прокрутки было нельзя. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
              minWidth: 0,
            }}
          >
            <h2 style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
              {displayName(detail)}
            </h2>
            <span className="muted">{PLAN_LABEL[detail.plan]}</span>
            {detail.isBlocked && (
              <span className="critical">
                заблокирован {date(detail.blockedAt)}
              </span>
            )}
            <button
              type="button"
              style={{ marginLeft: 'auto' }}
              onClick={() => setDetail(null)}
            >
              Закрыть
            </button>
          </div>
          {detail.costByOperation.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>
                Расход {usd(detail.costMicroUsd)} — из чего сложился
              </strong>
              <ul className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {detail.costByOperation.map((b) => (
                  <li key={b.key}>
                    {operationLabel(b.key)} — {usd(b.costMicroUsd)} ({b.calls}{' '}
                    выз.)
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.recentSessions.length === 0 ? (
            <p className="muted">Сессий нет.</p>
          ) : (
            <div className="table-scroll">
              <table className="table-narrow" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Сессия</th>
                    <th style={{ textAlign: 'left' }}>Статус</th>
                    <th style={{ textAlign: 'left' }}>Активность</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.recentSessions.map((s) => (
                    <tr key={s.sessionId} style={{ borderTop: '1px solid #333' }}>
                      <td style={{ padding: '6px 0' }}>
                        <a href={`/sessions/${s.sessionId}`}>
                          {s.productName ?? s.sessionId}
                        </a>
                        {s.hasGeneratedVideo && (
                          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                            есть ролик
                          </span>
                        )}
                      </td>
                      <td className="muted">{s.status}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {date(s.lastActivityAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
