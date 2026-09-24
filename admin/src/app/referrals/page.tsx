'use client';

// Вкладка «Приглашения» («Условно бесплатный Lite» §11, этап 135).
//
// Экран отвечает на один вопрос владельца: работает этот канал
// привлечения или нет и во что он обходится (§12.4 — если доля дошедших
// до ролика ниже примерно четверти, чинить надо не уговорами, а числом).
// Поэтому наверху стоят не состояния приглашений, а именно доля, и
// рядом с ней — деньги.
//
// Два числа подписаны оговорками, и это не перестраховка:
//  - «за всё время» у доли — потому что у перехода НЕТ даты (§5.2: это
//    счётчик, а не строка, у клика нет ключа и персональных полей);
//  - «оценка» у потраченного — потому что списание не помнит, какой
//    кредит потратили, бесплатный или купленный.
// Молча показать их как точные значило бы дать оператору принять
// решение по числу, которого в базе нет.

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  getReferralsOverview,
  revokeReferral,
  revokeUserLite,
} from '../../lib/endpoints';
import type {
  AdminReferralsOverview,
  ReferralsWindow,
  SuspiciousInviter,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const WINDOW_LABEL: Record<ReferralsWindow, string> = {
  day: 'Последние сутки',
  week: 'Последняя неделя',
  month: 'Последний месяц',
};

/**
 * Микродоллары → «$12.34». `null` — ставки модели нет в прайсе, и тогда
 * тут прочерк, а НЕ «$0»: ноль в графе денег читается как правда, по
 * которой принимают решение продолжать программу.
 */
function money(micro: number | null): string {
  if (micro === null) return 'ставки нет в прайсе';
  const usd = micro / 1_000_000;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function pct(ratio: number | null): string {
  if (ratio === null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="card" style={{ minWidth: 150 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>{value}</div>
      {hint && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export default function ReferralsPage() {
  const [window_, setWindow] = useState<ReferralsWindow>('week');
  const [data, setData] = useState<AdminReferralsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getReferralsOverview(window_)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof ApiRequestError ? e.message : 'Не удалось загрузить',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [window_, reload]);

  // Причина обязательна и на сервере (`RevokeWithReasonDto`), но
  // спрашивается и здесь — диалогом, а не `prompt()`. В админке уже
  // принято решение уходить от системных `confirm/prompt` к модалке
  // (см. `ConfirmDialog`), и у действия с обязательной причиной оно
  // тем более уместно: в `prompt` не видно ни что именно снимаем, ни
  // сколько строк это затронет.
  const [pending, setPending] = useState<
    | { kind: 'burst'; row: SuspiciousInviter }
    | { kind: 'lite'; row: SuspiciousInviter }
    | null
  >(null);
  const [reason, setReason] = useState('');

  const closeDialog = useCallback(() => {
    setPending(null);
    setReason('');
  }, []);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const text = reason.trim();
    if (!text) return;
    setBusy(pending.row.inviterId);
    try {
      if (pending.kind === 'lite') {
        await revokeUserLite(pending.row.inviterId, text);
      } else {
        // По одному запросу на приглашение: их единицы, а общий
        // «снять пачку» на сервере означал бы маршрут, который умеет
        // менять много строк разом, — ради экономии пары запросов на
        // служебном экране это плохой размен.
        for (const id of pending.row.burstReferralIds) {
          await revokeReferral(id, text);
        }
      }
      closeDialog();
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Не удалось');
    } finally {
      setBusy(null);
    }
  }, [pending, reason, closeDialog]);

  return (
    <main>
      <h1>Приглашения</h1>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0 20px' }}>
        {(Object.keys(WINDOW_LABEL) as ReferralsWindow[]).map((w) => (
          <button
            key={w}
            type="button"
            className={w === window_ ? 'btn btn-primary' : 'btn'}
            onClick={() => setWindow(w)}
          >
            {WINDOW_LABEL[w]}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>
          Обновить
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Загрузка…</p>}

      {data && (
        <>
          <h2>Работает ли канал</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat
              label="Дошли до ролика"
              value={pct(data.allTime.visitToGenerated)}
              hint={`${data.allTime.generated} из ${data.allTime.visits} переходов · за всё время`}
            />
            <Stat
              label="Вошли"
              value={String(data.allTime.identified)}
              hint="за всё время"
            />
            <Stat
              label="Стена снята"
              value={String(data.unlock.active)}
              hint={`цель — ${data.unlock.target} приглашений`}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Доля считается за всё время: у перехода нет даты — это счётчик,
            а не строка (переход происходит до того, как человек
            представился, и персональных полей у него быть не может).
          </p>

          <h2 style={{ marginTop: 28 }}>За период · {WINDOW_LABEL[data.window]}</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="Вошли" value={String(data.period.identified)} />
            <Stat label="Сделали ролик" value={String(data.period.generated)} />
            <Stat label="Снято оператором" value={String(data.period.revoked)} />
          </div>

          <h2 style={{ marginTop: 28 }}>Чего это стоит</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat
              label="Начислено"
              value={String(data.credits.granted)}
              hint={`${money(data.credits.grantedMicroUsd)} · по ${money(data.credits.unitCostMicroUsd)} за генерацию`}
            />
            <Stat
              label="Потрачено (оценка)"
              value={String(data.credits.spentEstimate)}
              hint={money(data.credits.spentEstimateMicroUsd)}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            «Потрачено» — оценка сверху: списание не помнит, бесплатный
            кредит потратили или купленный, поэтому по каждому человеку
            берётся не больше, чем ему начислили.
          </p>

          <h2 style={{ marginTop: 28 }}>Разблокировки</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Действует</th>
                <th>Заработано</th>
                <th>Сохранено с прошлых правил</th>
                <th>Выдано оператором</th>
                <th>Отозвано</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{data.unlock.active}</td>
                <td>{data.unlock.earned}</td>
                <td>{data.unlock.grandfathered}</td>
                <td>{data.unlock.byOperator}</td>
                <td>{data.unlock.revoked}</td>
              </tr>
            </tbody>
          </table>

          <h2 style={{ marginTop: 28 }}>Засчёты пачкой</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Три и больше засчитанных приглашения в пределах одного часа.
            Это повод посмотреть глазами, а не приговор: у семьи за одним
            Wi-Fi так тоже бывает. Снятое приглашение перестаёт двигать
            прогресс и приносить начисления, но уже выданное не
            отбирается, а строка остаётся с причиной — иначе разбор
            накрутки не на чем вести.
          </p>
          {data.suspicious.length === 0 ? (
            <p className="muted">Никого — засчёты идут вразнобой.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Пригласивший</th>
                  <th>Пачка</th>
                  <th>Начало пачки</th>
                  <th>Засчитано всего</th>
                  <th>Стена</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.suspicious.map((row) => (
                  <tr key={row.inviterId}>
                    <td>{row.telegramId ?? row.inviterId}</td>
                    <td>{row.burst}</td>
                    <td>{new Date(row.burstStartedAt).toLocaleString('ru-RU')}</td>
                    <td>{row.counted}</td>
                    <td>{row.liteUnlocked ? 'снята' : 'стоит'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === row.inviterId}
                        onClick={() => setPending({ kind: 'burst', row })}
                      >
                        Снять пачку ({row.burst})
                      </button>{' '}
                      {row.liteUnlocked && (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy === row.inviterId}
                          onClick={() => setPending({ kind: 'lite', row })}
                        >
                          Отнять доступ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'lite'
            ? 'Отнять разблокировку Lite'
            : `Снять засчитанные приглашения (${pending?.row.burst ?? 0})`
        }
        confirmLabel="Снять"
        confirmDisabled={!reason.trim()}
        busy={busy !== null}
        onConfirm={() => void confirm()}
        onCancel={closeDialog}
      >
        <p style={{ marginTop: 0 }}>
          {pending?.kind === 'lite' ? (
            <>
              У {pending.row.telegramId ?? pending.row.inviterId} доступ
              пропадёт. Дата разблокировки при этом не стирается — вернуть
              его можно, и история отзыва останется на месте.
            </>
          ) : (
            <>
              Снимутся {pending?.row.burst ?? 0} приглашений, засчитанных в
              пределах одного часа. Уже начисленные генерации не
              отбираются, разблокировка не отнимается — для неё отдельное
              действие.
            </>
          )}
        </p>
        <label
          style={{ display: 'block', fontSize: 13 }}
          htmlFor="revoke-reason"
        >
          Причина (обязательно, до 300 символов)
        </label>
        <textarea
          id="revoke-reason"
          value={reason}
          maxLength={300}
          rows={3}
          style={{ width: '100%', marginTop: 4 }}
          onChange={(e) => setReason(e.target.value)}
        />
      </ConfirmDialog>
    </main>
  );
}
