"use client";
// WP1: операторская сверка Story‑Tales. Здесь нет ни одного платного действия:
// привязка задания только читает статус у сборщика, остальное — смена статуса
// с обязательной причиной и записью в журнал.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getStoryTalesJournal,
  getStoryTalesQueue,
  getStoryTalesRetention,
  runStoryTalesAction,
  type StoryTalesActionPath,
} from '../../lib/endpoints';
import type {
  StoryTalesJournalEntry,
  StoryTalesQueue,
  StoryTalesRetentionPreview,
} from '../../lib/types';

type Kind =
  | 'gift-close' | 'gift-reopen' | 'gift-qa'
  | 'render-bind' | 'render-close' | 'render-qa'
  | 'ref-close' | 'ref-delete'
  | 'segment-close';
interface Pending { kind: Kind; id: string; stage?: string }

const TITLES: Record<Kind, string> = {
  'gift-close': 'Закрыть сказку как FAILED',
  'gift-reopen': 'Вернуть сказку в черновик',
  'gift-qa': 'Сбросить проверку озвучки в PENDING',
  'render-bind': 'Привязать подтверждённое задание сборщика',
  'render-close': 'Закрыть сборку как FAILED',
  'render-qa': 'Сбросить проверку видео в PENDING',
  'ref-close': 'Закрыть разбор как недоступный',
  'ref-delete': 'Удалить запись разбора',
  'segment-close': 'Закрыть сегмент речи и освободить ключ кэша',
};
const EFFECT: Record<Kind, string> = {
  'gift-close': 'Аудио не восстанавливается и не угадывается. Владелец сможет создать новую сказку или удалить эту.',
  'gift-reopen': 'Владелец сможет снова запустить озвучку — это новый платный вызов по его явному действию. Разрешено, только если вы проверили, что провайдер не списал средства.',
  'gift-qa': 'Владелец сможет снова запустить проверку (платный Soniox по его действию). Только если списания не было.',
  'render-bind': 'Читается только статус задания у сборщика. Готовое видео проверяется так же, как при обычном опросе (формат, 1280×720, длительность, хеш). Если задание ещё идёт — id сохраняется и крон проверит его сам.',
  'render-close': 'Сборка станет FAILED, слот этой конфигурации освободится, владелец сможет запустить новую сборку вручную.',
  'render-qa': 'Владелец сможет снова запустить проверку видео (платный Soniox по его действию). Только если списания не было.',
  'ref-close': 'Статус станет «недоступен»; несохранённый кандидат ответа удаляется. Повтор — только по явному запросу владельца с новой суточной квотой.',
  'ref-delete': 'Запись разбора удаляется целиком.',
  'segment-close': 'Сегмент станет DELETED, ключ кэша освободится: при следующей сборке владельца этот фрагмент будет синтезирован заново — новый платный вызов по его явному действию. Разрешено, только если вы проверили, что провайдер не списал средства за прежнюю попытку.',
};
const PATH: Record<Kind, (id: string) => StoryTalesActionPath> = {
  'gift-close': (id) => `gifts/${id}/close`,
  'gift-reopen': (id) => `gifts/${id}/reopen`,
  'gift-qa': (id) => `gifts/${id}/qa-reset`,
  'render-bind': (id) => `renders/${id}/bind-job`,
  'render-close': (id) => `renders/${id}/close`,
  'render-qa': (id) => `renders/${id}/qa-reset`,
  'ref-close': (id) => `references/${id}/close`,
  'ref-delete': (id) => `references/${id}/delete`,
  'segment-close': (id) => `segments/${id}/close`,
};
const STAGES: Record<string, string> = {
  base: 'проверка базового видео (платных вызовов не было)',
  main: 'озвучка основной сказки',
  voice: 'озвучка преамбулы',
  submit: 'отправка сборщику',
  'no-job': 'нет сохранённого задания',
  poll: 'задание есть, опрос кроном',
  qa: 'проверка видео',
  synthesis: 'синтез озвучки',
  unknown: 'не определён',
};
const NARRATION_KEY: Record<string, string> = {
  none: 'неподтверждённой основной речи нет — ключ кэша не затронут',
  released: 'ключ основной речи освобождён: следующая сборка владельца синтезирует её заново (платно, по его действию)',
  blocked: 'основная речь этим голосом заблокирована до подтверждения, что провайдер не списал средства',
};
/** Человеческое пояснение к результату действия (поля ответа сервера). */
const resultNote = (k: Kind, result: Record<string, unknown> | undefined): string => {
  if (!result) return '';
  const parts: string[] = [];
  if (k === 'render-bind' && typeof result.inputVerified === 'boolean')
    parts.push(result.inputVerified ? 'вход задания сверен со ссылкой — задание принадлежит этой сборке' : 'вход задания не сверялся (ссылка не указана)');
  if (k === 'render-close' && typeof result.narrationKey === 'string')
    parts.push(NARRATION_KEY[result.narrationKey] ?? `ключ речи: ${result.narrationKey}`);
  return parts.length ? `; ${parts.join('; ')}` : '';
};
const needsNoCharge = (k: Kind) => k === 'gift-reopen' || k === 'gift-qa' || k === 'render-qa' || k === 'segment-close';
const SEGMENT_KINDS: Record<string, string> = {
  intro: 'вступление',
  gift_note: 'реплика о подарке',
  main: 'основная речь',
  outro: 'завершение',
};
/** Та же проверка, что на сервере: не меньше трёх непробельных символов. */
const REASON_RE = /^(?:\s*\S){3}/;
const usd = (v: number) => `$${v.toFixed(2)}`;
const short = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
/** Один requestId на открытый диалог: двойной клик и повтор запроса не выполнят действие дважды. */
const uuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function ActionDialog({ pending, onDone, onCancel }: { pending: Pending; onDone: (msg: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [requestId] = useState(uuid);
  const [jobId, setJobId] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [noCharge, setNoCharge] = useState(false);
  const [release, setRelease] = useState<'' | 'yes' | 'no'>('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const k = pending.kind;
  const dialogRef = useRef<HTMLElement>(null);
  // Фокус в диалог при открытии (клавиатура и экранный диктор сразу в нём).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const releaseNeedsProof = k === 'render-close' && release === 'yes' && pending.stage !== 'base';
  const ready =
    REASON_RE.test(reason) &&
    understood &&
    (!needsNoCharge(k) || noCharge) &&
    (k !== 'render-bind' || jobId.trim().length >= 4) &&
    (k !== 'render-close' || release !== '') &&
    (!releaseNeedsProof || noCharge);
  const submit = async () => {
    if (!ready || busy) return;
    if (!window.confirm(`${TITLES[k]} (${short(pending.id)})?\n\n${EFFECT[k]}`)) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        reason: reason.trim(),
        requestId,
        ...(needsNoCharge(k) ? { providerChargeConfirmedAbsent: true } : {}),
        ...(k === 'render-bind'
          ? { jobId: jobId.trim(), ...(inputUrl.trim() ? { renderInputUrl: inputUrl.trim() } : {}) }
          : {}),
        ...(k === 'render-close'
          ? { releaseReserve: release === 'yes', ...(releaseNeedsProof ? { providerChargeConfirmedAbsent: true } : {}) }
          : {}),
      };
      const res = await runStoryTalesAction(PATH[k](pending.id), body);
      onDone(`${TITLES[k]}: готово${resultNote(k, res.result)}${res.replayed ? ' (повтор того же запроса — возвращён прежний результат)' : ''}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Действие не выполнено');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      ref={dialogRef}
      tabIndex={-1}
      className="card"
      role="dialog"
      aria-label={TITLES[k]}
      style={{ borderColor: 'var(--signal-warning, #b58900)' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel();
      }}
    >
      <h2>{TITLES[k]}</h2>
      <p className="muted">Объект: <code>{pending.id}</code></p>
      <p>{EFFECT[k]}</p>
      {k === 'render-bind' && (
        <label style={{ display: 'block', marginBottom: 8 }}>
          id задания из кабинета FFmpeg API{' '}
          <input value={jobId} onChange={(e) => setJobId(e.target.value)} maxLength={128} style={{ width: '100%' }} />
        </label>
      )}
      {k === 'render-bind' && (
        <label style={{ display: 'block', marginBottom: 8 }}>
          Ссылка на вход задания из кабинета FFmpeg API (необязательно; вида …/story-render-input/&lt;токен&gt;/&lt;часть&gt;) — подтверждает, что задание отправлено именно этой сборкой{' '}
          <input value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} maxLength={2048} type="url" style={{ width: '100%' }} />
        </label>
      )}
      {k === 'render-close' && (
        <fieldset style={{ marginBottom: 8 }}>
          <legend>Резерв бюджета этой попытки (выберите явно)</legend>
          <label><input type="radio" name="story-release-reserve" value="no" checked={release === 'no'} onChange={() => setRelease('no')} /> Сохранить резерв (если списание возможно)</label><br />
          <label><input type="radio" name="story-release-reserve" value="yes" checked={release === 'yes'} onChange={() => setRelease('yes')} /> Освободить резерв</label>
          {pending.stage === 'base' && release === 'yes' && <p className="muted">Сбой на проверке базового видео: платных вызовов не было, подтверждение не требуется.</p>}
        </fieldset>
      )}
      {(needsNoCharge(k) || releaseNeedsProof) && (
        <label style={{ display: 'block', marginBottom: 8 }}>
          <input type="checkbox" checked={noCharge} onChange={(e) => setNoCharge(e.target.checked)} /> Я проверил(а) в кабинете провайдера: средства за эту попытку не списаны
        </label>
      )}
      <label style={{ display: 'block', marginBottom: 8 }}>
        Причина (обязательно, попадёт в журнал; без персональных данных)
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} style={{ width: '100%' }} />
      </label>
      {reason.length > 0 && !REASON_RE.test(reason) && <p className="muted">Причина — не меньше трёх символов, не считая пробелов.</p>}
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> Понимаю последствия; действие необратимо и записывается в журнал
      </label>
      {error && <p role="alert" style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      <button onClick={() => void submit()} disabled={!ready || busy}>{busy ? 'Выполняется…' : 'Выполнить'}</button>{' '}
      <button onClick={onCancel} disabled={busy}>Отмена</button>
    </section>
  );
}

export default function StoryTalesPage() {
  const [queue, setQueue] = useState<StoryTalesQueue | null>(null);
  const [journal, setJournal] = useState<StoryTalesJournalEntry[]>([]);
  const [retention, setRetention] = useState<StoryTalesRetentionPreview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Кнопка, открывшая диалог: после закрытия фокус возвращается к ней. */
  const opener = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const restoreFocus = () => {
    const back = opener.current;
    opener.current = null;
    setTimeout(() => {
      if (back?.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
      else noticeRef.current?.focus();
    }, 0);
  };
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [q, j, r] = await Promise.all([getStoryTalesQueue(), getStoryTalesJournal(), getStoryTalesRetention()]);
      setQueue(q);
      setJournal(j);
      setRetention(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const open = (p: Pending) => {
    opener.current = document.activeElement as HTMLElement | null;
    setNotice('');
    setPending(p);
  };
  const act = (kind: Kind, id: string, label: string, stage?: string) => (
    <button key={kind} onClick={() => open({ kind, id, stage })} disabled={!!pending} style={{ marginRight: 6, marginBottom: 4 }}>{label}</button>
  );
  const segments = queue?.segments ?? [];
  const empty = queue && !queue.gifts.length && !queue.renders.length && !queue.references.length && !segments.length;
  return (
    <div className="page">
      <h1>Story‑Tales: сверка и сроки хранения</h1>
      <p className="muted">
        Записи, у которых результат провайдера не подтверждён (UNKNOWN). Автоматических и платных повторов здесь нет: оператор либо привязывает подтверждённое задание сборщика,
        либо закрывает запись, либо — только при подтверждённом отсутствии списания — возвращает её владельцу для явного повтора. Текст сказок, медиа и владельцы не показываются.
      </p>
      <button onClick={() => void load()} disabled={busy}>{busy ? 'Загрузка…' : 'Обновить'}</button>
      {error && <p role="alert" style={{ color: 'var(--signal-critical)' }}>{error}</p>}
      <p role="status" ref={noticeRef} tabIndex={-1}>{notice}</p>
      {pending && (
        <ActionDialog
          pending={pending}
          onCancel={() => {
            setPending(null);
            restoreFocus();
          }}
          onDone={(msg) => {
            setPending(null);
            setNotice(msg);
            restoreFocus();
            void load();
          }}
        />
      )}
      {empty && <p>Сейчас ничего не ждёт оператора.</p>}
      {queue && queue.gifts.length > 0 && (
        <section className="card">
          <h2>Сказки ({queue.gifts.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>id</th><th>Этап</th><th>Возраст, ч</th><th>Резерв / бюджет</th><th>Ошибка</th><th>Действия</th></tr></thead>
              <tbody>
                {queue.gifts.map((g) => (
                  <tr key={g.id}>
                    <td><code title={g.id}>{short(g.id)}</code></td>
                    <td>{STAGES[g.stage]}</td>
                    <td>{g.ageHours} (без изменений {g.idleHours})</td>
                    <td>{usd(g.reservedUsd)} / {usd(g.budgetUsd)}</td>
                    <td className="muted">{g.error ?? '—'}</td>
                    <td>
                      {g.stage === 'synthesis'
                        ? [act('gift-close', g.id, 'Закрыть FAILED'), act('gift-reopen', g.id, 'В черновик')]
                        : act('gift-qa', g.id, 'Сбросить QA')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {queue && queue.renders.length > 0 && (
        <section className="card">
          <h2>Сборки видео ({queue.renders.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>id</th><th>Сказка</th><th>Этап</th><th>Задание</th><th>Голос</th><th>Возраст, ч</th><th>Резерв</th><th>Ошибка</th><th>Действия</th></tr></thead>
              <tbody>
                {queue.renders.map((r) => (
                  <tr key={r.id}>
                    <td><code title={r.id}>{short(r.id)}</code></td>
                    <td><code title={r.giftId}>{short(r.giftId)}</code></td>
                    <td>{STAGES[r.stage] ?? r.stage}</td>
                    <td>{r.hasJobId ? 'есть' : 'нет'}</td>
                    <td>{r.voice === 'parent' ? 'родитель' : 'Nova'}</td>
                    <td>{r.ageHours}</td>
                    <td>{usd(r.reservedUsd)}</td>
                    <td className="muted">{r.error ?? '—'}</td>
                    <td>
                      {r.stage === 'qa'
                        ? act('render-qa', r.id, 'Сбросить QA')
                        : [
                            ...(r.submitReached && !r.hasJobId ? [act('render-bind', r.id, 'Привязать задание')] : []),
                            act('render-close', r.id, 'Закрыть FAILED', r.stage),
                          ]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {segments.length > 0 && (
        <section className="card">
          <h2>Сегменты речи видео ({segments.length})</h2>
          <p className="muted">
            Синтез сегмента был начат, но результат не подтверждён. Такой сегмент не покупается повторно, пока оператор не закроет его с подтверждением отсутствия списания.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>id</th><th>Сказка</th><th>Сборка</th><th>Вид</th><th>Источник</th><th>Возраст, ч</th><th>Действия</th></tr></thead>
              <tbody>
                {segments.map((s) => (
                  <tr key={s.id}>
                    <td><code title={s.id}>{s.shortId}</code></td>
                    <td><code title={s.giftId}>{short(s.giftId)}</code></td>
                    <td>{s.renderId ? <code title={s.renderId}>{short(s.renderId)}</code> : '—'}</td>
                    <td>{s.kind ? SEGMENT_KINDS[s.kind] ?? s.kind : 'не определён'}</td>
                    <td>{s.source === 'recorded' ? 'запись взрослого' : 'синтез'}</td>
                    <td>{s.ageHours} (без изменений {s.idleHours})</td>
                    <td>{act('segment-close', s.id, 'Закрыть и освободить ключ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {queue && queue.references.length > 0 && (
        <section className="card">
          <h2>Разборы референсов ({queue.references.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Ролик</th><th>Состояние</th><th>Кандидат ответа</th><th>Возраст, ч</th><th>Ошибка</th><th>Действия</th></tr></thead>
              <tbody>
                {queue.references.map((r) => (
                  <tr key={r.ref}>
                    <td><code>{r.videoId}</code></td>
                    <td>{r.state === 'unknown' ? 'не подтверждён' : 'завис в обработке'}</td>
                    <td>{r.hasPendingAssessment ? 'сохранён' : 'нет'}</td>
                    <td>{r.ageHours}</td>
                    <td className="muted">{r.error ?? '—'}</td>
                    <td>{[act('ref-close', r.ref, 'Закрыть'), act('ref-delete', r.ref, 'Удалить')]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {retention && (
        <section className="card">
          <h2>Сроки хранения (предпросмотр, ничего не удаляется)</h2>
          <p className="muted">
            Ночной крон <code>story-retention</code> {retention.dryRun ? 'сейчас работает в режиме dry-run: только считает кандидатов' : 'удаляет записи класса A'}.
            Готовые сказки старше 180 дней удаляются только с отдельным флагом ({retention.readyPurgeEnabled ? 'включён' : 'выключен'}).
          </p>
          <ul>
            <li>Незавершённые сказки (черновик/FAILED/UNKNOWN) без изменений 30 дней: {retention.staleGifts}</li>
            <li>Неудачные/неподтверждённые сборки старше 30 дней: {retention.staleRenders}</li>
            <li>Сборки с удалённым голосом рассказчика: {retention.revokedVoiceRenders}</li>
            <li>
              Сегменты речи, синтезированные удалённым голосом: {retention.revokedVoiceSegments ?? 0}
              {retention.candidates?.segments?.length ? (
                <> — <code>{retention.candidates.segments.map(short).join(', ')}</code></>
              ) : null}
            </li>
            <li>Неподтверждённые/недоступные разборы старше 30 дней: {retention.staleReferences}; старые ключи квоты: {retention.quotaKeys}</li>
            <li>Готовые сказки без изменений 180 дней (кандидаты): {retention.readyGifts}; завершённые разборы: {retention.readyReferences}</li>
          </ul>
        </section>
      )}
      <section className="card">
        <h2>Журнал (последние {journal.length})</h2>
        {journal.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Когда (Киев)</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Причина</th><th>Было → стало</th></tr></thead>
              <tbody>
                {journal.map((j) => (
                  <tr key={j.id}>
                    <td>{new Date(j.createdAt).toLocaleString('ru', { timeZone: 'Europe/Kyiv' })}</td>
                    <td>{j.actorKind === 'cron' ? 'крон сроков хранения' : j.actorKind === 'owner' ? 'владелец (удаление записи)' : <code>{short(j.actorUserId ?? '')}</code>}</td>
                    <td><code>{j.action}</code></td>
                    <td>{j.targetType}: <code title={j.targetId}>{short(j.targetId)}</code></td>
                    <td>{j.reason}</td>
                    <td className="muted"><code>{JSON.stringify(j.previousState)}</code> → <code>{JSON.stringify(j.result)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Записей пока нет.</p>
        )}
      </section>
    </div>
  );
}
