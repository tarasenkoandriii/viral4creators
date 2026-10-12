/**
 * Источники «Промахов» и «Пропозицій» карты «Админки» — ЧИСТЫЙ разбор
 * журнала (заход 13, Р-З13-А2; ТЗ §5-кватер.10 «Т-4 → Промахи»).
 *
 * У «Админки» своего журнала шагов нет: план, шаги и стоп голосового
 * управления сотрудника — строки `ui-plan`/`ui-step` append-only журнала
 * действий `assist_admin_action_log` (маскированный запрос: `plan`,
 * `mapKey`, `mapMiss`, `mapVersion` — заход 11; `mapKey` шага — заход 13).
 * Здесь строки журнала приводятся к форме общего ядра свёртки
 * (`assist-ui-core/map-misses-core.ts`), чтобы «Сайт» и «Админка» считали
 * «нажмите сами / не найдено / не туда / промах карты» ОДНИМ кодом:
 *  - `ui.plan` → строка `plan` (служебная): `refused` — «план без шагов»
 *    (`skipped`, причина `no_target`, если её назвали проверки), `mapKey`/
 *    `mapMiss` — как записал план; планы мастера (`test`), сухие прогоны
 *    (`dryrun`) и уход в API (`api`) — не сигнал;
 *  - `ui.stop` → `stop` с причиной `by` (кнопка/Esc/голос/свой клик —
 *    «человек остановил»);
 *  - `ui.<вид>` шага → строка шага: исход (`expect_miss` — `failed`,
 *    нарушение запрета — служебная `violation`), причина, `mapKey`, адрес.
 * Подписей и значений здесь нет: только ключи целей, коды, пути и id.
 */
import type { MapMissRow } from '../../assist-ui-core/map-misses-core';

/** Строка журнала действий «Админки» (выборка — `admin-editor-assist.service.ts`). */
export interface AdminJournalRow {
  at: Date;
  kind: string;
  operation: string;
  outcome: string;
  error: string | null;
  requestMasked: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

/** Строки плана, которые не сигнал владельцу (мастер, сухой прогон, API). */
const NOT_SIGNAL = new Set(['dryrun', 'api']);

/**
 * Журнал «Админки» → строки ядра свёртки. Строки мастера (`test`) и
 * строки без плана (`plan: '-'` — уход в API до плана) — вон.
 */
export function adminMissRows(rows: readonly AdminJournalRow[]): MapMissRow[] {
  const out: MapMissRow[] = [];
  for (const r of rows) {
    if (r.kind !== 'ui-plan' && r.kind !== 'ui-step') continue;
    const q = isObj(r.requestMasked) ? r.requestMasked : {};
    const planId = str(q.plan);
    if (!planId || planId === '-' || q.test !== undefined) continue;
    const op = r.operation.replace(/^ui\./, '');
    const mapKey = str(q.mapKey);
    if (r.kind === 'ui-plan') {
      if (op === 'plan') {
        if (NOT_SIGNAL.has(r.outcome)) continue;
        const notes = Array.isArray(q.notes)
          ? q.notes.filter((x): x is string => typeof x === 'string')
          : [];
        const refused = r.outcome === 'refused';
        out.push({
          planId,
          action: 'plan',
          result: refused ? 'skipped' : r.outcome,
          reason: refused
            ? notes.includes('no_target')
              ? 'no_target'
              : notes.length
                ? notes.join(',').slice(0, 120)
                : null
            : null,
          mapKey,
          mapMiss: q.mapMiss === true,
          url: str(q.page),
          createdAt: r.at,
        });
      } else
        out.push({
          planId,
          action: op === 'stop' ? 'stop' : op,
          result: r.outcome,
          reason: op === 'stop' ? str(q.by) : r.error,
          mapKey: null,
          mapMiss: false,
          url: null,
          createdAt: r.at,
        });
      continue;
    }
    out.push({
      planId,
      action: r.outcome === 'violation' ? 'violation' : op,
      result: r.outcome === 'expect_miss' ? 'failed' : r.outcome,
      reason: r.error,
      mapKey,
      mapMiss: false,
      url: str(q.url),
      createdAt: r.at,
    });
  }
  return out;
}

/** Планы «просили, не нашли»: 0 шагов (без причины / `no_target`) или промах карты. */
export function askedPlanRows(rows: readonly MapMissRow[]): MapMissRow[] {
  return rows.filter(
    (r) =>
      r.action === 'plan' &&
      (r.mapMiss ||
        (r.result === 'skipped' &&
          (r.reason === null || r.reason.includes('no_target')))),
  );
}

/**
 * Аудит З13-А P3-3: команда сотрудника, похожая на данные КЛИЕНТОВ
 * заказчика, — не кандидат в синоним карты «Админки». Маска ПД ловит
 * e-mail, телефоны, ключи и длинные числа, но не имена и короткие номера
 * («відкрий клієнта Іван Петренко», «замовлення 1042»). Поэтому вон:
 *  - номер из 3+ цифр подряд;
 *  - слово с заглавной буквы НЕ в начале команды (имя, фамилия, город);
 *  - уже замаскированное (`•`, `[…]`).
 * Ложные срабатывания (бренд с заглавной) — цена осторожности: такую фразу
 * владелец добавит синонимом сам.
 */
export function adminPhrasePd(utterance: string): boolean {
  if (/\d{3,}/.test(utterance) || /[•[\]]/.test(utterance)) return true;
  return utterance
    .trim()
    .split(/\s+/)
    .slice(1)
    .some((w) => /^["«„(]?\p{Lu}\p{Ll}/u.test(w));
}
