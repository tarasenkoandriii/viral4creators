'use client';

// Вкладка «Тестирование» (этап 158,
// `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §5).
//
// Три части, и порядок у них не произвольный: приглашения (позвать),
// прогресс (что вообще проверено) и очередь находок (что чинить).
// Прогресс стоит между ними затем, чтобы вопрос «а этот сценарий кто-то
// открывал?» задавался ДО того, как оператор уйдёт разбирать находки:
// сценарий, по которому тишина, — главный вопрос к любому тестированию,
// и из очереди его не видно вовсе.
//
// Переписки здесь нет намеренно (§5.2): тикет — это находка и ответ на
// неё, а не чат. Комментарии в карточке показываются только чтением.

import { useEffect, useState } from 'react';
import {
  createTesterInvite,
  getTesterInvites,
  getTesterProgress,
  getTestTicket,
  getTestTickets,
  replyToTestTicket,
  revokeTesterInvite,
  setTestTicketStatus,
} from '../../lib/endpoints';
import type {
  TesterInvite,
  TesterProgress,
  TestTicketDetail,
  TestTicketRow,
  TicketStatus,
} from '../../lib/types';
import {
  FREE_SCENARIOS,
  FREE_SCENARIO_LABELS,
  type FreeScenario,
} from '../../lib/free-scenarios';
import { ApiRequestError } from '../../lib/admin-api';

const STATUS_LABEL: Record<TicketStatus, string> = {
  NEW: 'Новая',
  IN_PROGRESS: 'Чиним',
  ANSWERED: 'Ждём ответа',
  FIXED: 'Исправлено',
  REJECTED: 'Отклонено',
  DUPLICATE: 'Дубль',
};

/** Статусы, которые нельзя поставить молча — зеркало бэкенда. */
const NEEDS_REASON: TicketStatus[] = ['REJECTED', 'DUPLICATE'];

const STATUSES = Object.keys(STATUS_LABEL) as TicketStatus[];

/** Микродоллары — в доллары, как на вкладке «Расходы». */
function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

/** Сколько висит — в очереди разбора это важнее точной даты. */
function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'меньше часа';
  if (hours < 24) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

export default function TestingPage() {
  const [invites, setInvites] = useState<TesterInvite[] | null>(null);
  const [progress, setProgress] = useState<TesterProgress[] | null>(null);
  const [tickets, setTickets] = useState<TestTicketRow[] | null>(null);
  const [detail, setDetail] = useState<TestTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Фильтры очереди. `OPEN` по умолчанию: рабочий вид вкладки — это
  // «что ждёт нас», а не весь архив.
  const [status, setStatus] = useState('OPEN');
  const [userId, setUserId] = useState('');
  const [envKey, setEnvKey] = useState('');

  const [label, setLabel] = useState('');
  const [scenarios, setScenarios] = useState<FreeScenario[]>([]);
  const [outside, setOutside] = useState(false);
  const [limit, setLimit] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');

  function fail(err: unknown, fallback: string) {
    setError(err instanceof ApiRequestError ? err.message : fallback);
  }

  async function loadTickets() {
    try {
      setTickets(
        await getTestTickets({
          status: status || undefined,
          userId: userId || undefined,
          envKey: envKey || undefined,
        })
      );
      setError(null);
    } catch (err) {
      fail(err, 'Не удалось загрузить находки');
    }
  }

  async function loadSide() {
    try {
      const [i, p] = await Promise.all([
        getTesterInvites(),
        getTesterProgress(),
      ]);
      setInvites(i);
      setProgress(p);
    } catch (err) {
      fail(err, 'Не удалось загрузить приглашения и прогресс');
    }
  }

  useEffect(() => {
    void loadSide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, userId, envKey]);

  async function open(id: string) {
    try {
      setDetail(await getTestTicket(id));
      setReply('');
      setNote('');
      setError(null);
    } catch (err) {
      fail(err, 'Не удалось открыть находку');
    }
  }

  async function changeStatus(next: TicketStatus) {
    if (!detail) return;
    // Причину требуем ЗДЕСЬ тоже, а не только на бэкенде: узнавать о
    // ней из красной ошибки после нажатия — лишний круг.
    if (NEEDS_REASON.includes(next) && !note.trim()) {
      setError('Для «отклонено» и «дубль» нужна причина.');
      return;
    }
    setBusy(true);
    try {
      const updated = await setTestTicketStatus(
        detail.id,
        next,
        note.trim() || undefined
      );
      setDetail(updated);
      setError(null);
      await loadTickets();
    } catch (err) {
      fail(err, 'Не удалось сменить статус');
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!detail || !reply.trim()) return;
    setBusy(true);
    try {
      const updated = await replyToTestTicket(detail.id, reply.trim());
      setDetail(updated);
      setReply('');
      setError(null);
      await loadTickets();
    } catch (err) {
      fail(err, 'Не удалось отправить ответ');
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    if (!label.trim()) {
      setError('Подпись нужна: по ней приглашение потом и находят.');
      return;
    }
    setBusy(true);
    try {
      // Пустое поле — общий потолок, а не ноль: ноль здесь законное
      // значение и означает ровно ноль. А непонятное значение — это
      // отказ, а не тихий откат к общему (аудит этапа 159): `Number`
      // отдал бы `NaN`, `JSON.stringify` превратил бы его в `null`, и
      // оператор считал бы, что ограничил трату.
      const dailyLimitUsd = limit.trim() === '' ? null : Number(limit);
      if (dailyLimitUsd !== null && !Number.isInteger(dailyLimitUsd)) {
        setError('Суточный потолок — целое число долларов или пусто.');
        setBusy(false);
        return;
      }
      await createTesterInvite({
        label: label.trim(),
        freeScenarios: scenarios,
        freeOutsideProject: outside,
        dailyLimitUsd,
        expiresAt: expiresAt || null,
      });
      setLabel('');
      setScenarios([]);
      setOutside(false);
      setLimit('');
      setExpiresAt('');
      setError(null);
      await loadSide();
    } catch (err) {
      fail(err, 'Не удалось создать приглашение');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const reason = window.prompt('Причина отзыва — она останется в истории:');
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await revokeTesterInvite(id, reason.trim());
      setError(null);
      await loadSide();
    } catch (err) {
      fail(err, 'Не удалось отозвать приглашение');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Тестирование</h1>
      {error && <p className="error">{error}</p>}

      <section style={{ marginTop: 24 }}>
        <h2>Приглашения</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Telegram не даёт боту написать человеку первым — единственный вход
          это ссылка, по которой он сам нажмёт START.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          <input
            placeholder="Кому — имя для себя"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {FREE_SCENARIOS.map((s) => (
            <label key={s} style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={scenarios.includes(s)}
                onChange={(e) =>
                  setScenarios((prev) =>
                    e.target.checked
                      ? [...prev, s]
                      : prev.filter((x) => x !== s)
                  )
                }
              />{' '}
              {FREE_SCENARIO_LABELS[s]}
            </label>
          ))}
          <label
            style={{ fontSize: 13 }}
            title="Клон голоса, озвучка, скетчи, поиск на YouTube — они не принадлежат проекту"
          >
            <input
              type="checkbox"
              checked={outside}
              onChange={(e) => setOutside(e.target.checked)}
            />{' '}
            Вне проекта
          </label>
          <input
            type="number"
            min={0}
            placeholder="$/сутки"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            style={{ width: 90 }}
            title="Свой суточный потолок. Пусто — общий для тестовых аккаунтов; общий действует НА КАЖДОГО"
          />
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            title="До какого числа ссылка действует"
          />
          <button type="button" onClick={() => void invite()} disabled={busy}>
            Создать
          </button>
        </div>

        {invites?.length ? (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="table-narrow" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Кому</th>
                  <th style={{ textAlign: 'left' }}>Открыто</th>
                  <th style={{ textAlign: 'left' }}>Срок</th>
                  <th style={{ textAlign: 'left' }}>Состояние</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.label}</td>
                    <td className="muted">
                      {[
                        ...i.freeScenarios.map(
                          (s) => FREE_SCENARIO_LABELS[s as FreeScenario] ?? s
                        ),
                        ...(i.freeOutsideProject ? ['вне проекта'] : []),
                      ].join(', ') || 'ничего'}
                      {i.dailyLimitUsd !== null && ` · $${i.dailyLimitUsd}/сут`}
                    </td>
                    <td className="muted">{date(i.expiresAt)}</td>
                    <td className="muted">
                      {i.revokedAt
                        ? `отозвано ${date(i.revokedAt)}`
                        : i.activated
                          ? `активировано ${date(i.activatedAt)}`
                          : 'ждёт'}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard?.writeText(i.link)
                        }
                      >
                        Скопировать ссылку
                      </button>{' '}
                      {!i.revokedAt && (
                        <button
                          type="button"
                          onClick={() => void revoke(i.id)}
                          disabled={busy}
                        >
                          Отозвать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Приглашений пока нет.</p>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Прогресс</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Прогоны считаются из сессий и типов проектов — отдельного
          чек-листа нет. Строка с нулями и означает сценарий, которого
          никто не трогал.
        </p>
        {progress?.length ? (
          <div className="table-scroll" style={{ marginTop: 8 }}>
            <table className="table-narrow" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Тестировщик</th>
                  {FREE_SCENARIOS.map((s) => (
                    <th key={s} style={{ textAlign: 'left' }}>
                      {FREE_SCENARIO_LABELS[s]}
                    </th>
                  ))}
                  <th style={{ textAlign: 'left' }}>Находки</th>
                  <th style={{ textAlign: 'left' }}>Сегодня</th>
                  <th style={{ textAlign: 'left' }}>Активность</th>
                </tr>
              </thead>
              <tbody>
                {progress.map((p) => (
                  <tr key={p.userId}>
                    <td>
                      {p.label}{' '}
                      <span className="muted">#{p.telegramId}</span>
                      {!p.accessActive && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          доступ истёк {date(p.accessUntil)}
                        </div>
                      )}
                    </td>
                    {p.scenarios.map((s) => (
                      <td key={s.scenario} className="muted">
                        {s.open ? '' : '🔒 '}
                        {s.sessions} прогон. / {s.tickets} нах.
                      </td>
                    ))}
                    <td className="muted">
                      {p.openTickets} откр. / {p.closedTickets} закр.
                    </td>
                    {/* Потолок — НА КАЖДОГО тестировщика, а не общий на
                        всех: трое это втрое больше денег в сутки. */}
                    <td className="muted">
                      {usd(p.spentTodayMicroUsd)} / {usd(p.dailyLimitMicroUsd)}
                    </td>
                    <td className="muted">{date(p.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Тестовых аккаунтов пока нет.</p>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Находки</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="OPEN">Открытые</option>
            <option value="">Все</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Все тестировщики</option>
            {progress?.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            placeholder="Ключ окружения — например tma:ios"
            value={envKey}
            onChange={(e) => setEnvKey(e.target.value)}
            style={{ minWidth: 220 }}
            title="Точное совпадение ключа: «это у всех или у него одного»"
          />
          {envKey && (
            <button type="button" onClick={() => setEnvKey('')}>
              Сбросить окружение
            </button>
          )}
        </div>

        {tickets?.length ? (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="table-narrow" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>№</th>
                  <th style={{ textAlign: 'left' }}>Кто</th>
                  <th style={{ textAlign: 'left' }}>Откуда</th>
                  <th style={{ textAlign: 'left' }}>Что</th>
                  <th style={{ textAlign: 'left' }}>Окружение</th>
                  <th style={{ textAlign: 'left' }}>Статус</th>
                  <th style={{ textAlign: 'left' }}>Висит</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => void open(t.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>#{t.number}</td>
                    <td>{t.tester.label}</td>
                    <td className="muted">
                      {t.source === 'BOT' ? 'бот' : 'приложение'}
                      {t.attachments > 0 && ` · 📎${t.attachments}`}
                    </td>
                    <td>{t.preview}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {t.envSummary || '—'}
                      {t.envStale && ' (последнее известное)'}
                    </td>
                    <td>
                      {STATUS_LABEL[t.status]}
                      {t.replyFailedAt && ' · ответ не доставлен'}
                    </td>
                    <td className="muted">{age(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Находок нет.</p>
        )}
      </section>

      {detail && (
        <section
          style={{ marginTop: 32, borderTop: '1px solid #8883', paddingTop: 16 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h2 style={{ margin: 0 }}>
              #{detail.number} — {STATUS_LABEL[detail.status]}
            </h2>
            <span className="muted">
              {detail.tester.label}, {date(detail.createdAt)}
            </span>
            <button
              type="button"
              style={{ marginLeft: 'auto' }}
              onClick={() => setDetail(null)}
            >
              Закрыть
            </button>
          </div>

          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
            {detail.text}
          </pre>

          {detail.attachmentList?.length ? (
            <ul className="muted" style={{ fontSize: 13 }}>
              {detail.attachmentList.map((a) => (
                <li key={a.url}>
                  <a href={a.url} target="_blank" rel="noreferrer">
                    {a.fileName || a.kind}
                  </a>{' '}
                  ({Math.round(a.size / 1024)} КБ)
                </li>
              ))}
            </ul>
          ) : null}

          <p className="muted" style={{ fontSize: 13 }}>
            {detail.envSummary || 'окружение неизвестно'}
            {detail.envStale && (
              <>
                {' '}
                — <strong>последнее известное</strong>, снято{' '}
                {date(detail.envCapturedAt)}: к этой находке оно, скорее
                всего, отношения не имеет
              </>
            )}
          </p>
          {detail.env && (
            <details>
              <summary className="muted" style={{ fontSize: 13 }}>
                Окружение целиком
              </summary>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(detail.env, null, 2)}
              </pre>
            </details>
          )}

          {detail.sessionId && (
            <p className="muted" style={{ fontSize: 13 }}>
              Сессия:{' '}
              {/* `search`, а не выдуманный параметр: именно его читает
                  страница сессий, и поиск там теперь совпадает с id
                  точно (аудит этапа 158). */}
              <a href={`/sessions?search=${encodeURIComponent(detail.sessionId)}`}>
                {detail.sessionId}
              </a>
              {detail.stepId && ` · шаг ${detail.stepId}`}
              {detail.sessionLocale && ` · язык ролика ${detail.sessionLocale}`}
            </p>
          )}

          {detail.sameEnvironment.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {/* Число — от бэкенда, а не длина списка: список обрезан,
                  и выдавать его длину за общее значило бы сообщать
                  «ещё 10» там, где их полсотни. */}
              <strong style={{ fontSize: 13 }}>
                Ещё {detail.sameEnvironmentTotal} с тем же окружением
                {detail.sameEnvironmentTotal > detail.sameEnvironment.length &&
                  ` — показаны ${detail.sameEnvironment.length} свежих`}
              </strong>
              {/* Именно окружением: у находки из бота нет ни сценария, ни
                  шага, и ключ вырождается в «та же платформа и локаль». */}
              <ul className="muted" style={{ fontSize: 13 }}>
                {detail.sameEnvironment.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => void open(s.id)}
                      style={{ all: 'unset', cursor: 'pointer' }}
                    >
                      #{s.number} — {s.preview} ({STATUS_LABEL[s.status]})
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.comments?.length ? (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>Переписка в личке</strong>
              <ul className="muted" style={{ fontSize: 13 }}>
                {detail.comments.map((c, i) => (
                  <li key={`${c.at}-${i}`}>
                    {c.from === 'OPERATOR' ? 'мы' : 'тестировщик'},{' '}
                    {date(c.at)}: {c.text}
                    {c.attachments?.map((a, j) => (
                      <span key={`${a.url}-${j}`}>
                        {' '}
                        <a href={a.url} target="_blank" rel="noreferrer">
                          файл
                        </a>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <input
              placeholder="Причина — обязательна для «отклонено» и «дубль»"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ minWidth: 320 }}
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void changeStatus(s)}
                  disabled={busy || s === detail.status}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            {detail.statusNote && (
              <p className="muted" style={{ fontSize: 13 }}>
                Причина: {detail.statusNote} ({date(detail.statusAt)})
              </p>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <textarea
              placeholder={
                detail.canReply
                  ? 'Ответ уйдёт в личку тестировщику'
                  : 'Диалог с ботом не открыт — человек ещё не нажимал START'
              }
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              disabled={!detail.canReply}
              rows={3}
              style={{ width: '100%' }}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !detail.canReply || !reply.trim()}
            >
              Ответить
            </button>
            {detail.replyFailedAt && (
              <span className="muted" style={{ marginLeft: 8 }}>
                Последний ответ НЕ доставлен ({date(detail.replyFailedAt)}) —
                человек мог заблокировать бота.
              </span>
            )}
            {detail.replySentAt && !detail.replyFailedAt && (
              <span className="muted" style={{ marginLeft: 8 }}>
                Отвечено {date(detail.replySentAt)}
              </span>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
