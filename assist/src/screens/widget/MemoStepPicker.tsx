/**
 * Карточка мемо → «Додати крок» / «Замінити ціль» с телефона (Э6-бис (е)
 * хвост (4), ТЗ §5-бис.17 п.14, В-56): список элементов карты интерфейса
 * Ш4 страницы шага (`GET …/memos/:n/elements`), выбор — одним нажатием.
 * Отпечаток цели строит сервер (TMA шлёт только id элемента), сохранение —
 * операциями черновика с теми же воротами (`POST …/steps/element`): шаг
 * «никогда» сервер не примет (422 — текст ошибки в карточке). Запись
 * кликами и перепривязка мышкой — в редакторе («Відкрити в редакторі»).
 */
import { useState } from 'react';
import { MousePointerClick, X } from 'lucide-react';
import { fmt, useAsync } from '../../kit';
import { Badge, Button, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { MemoDetail } from '../../lib/memo-api';
import { useSetupErrorText } from '../../lib/use-error-text';
import { voiceControlErrorCode } from '../../lib/voice-control-api';
import { Field } from './controls';

export type MemoPickMode = { kind: 'add' } | { kind: 'replace'; index: number };

export function MemoStepPicker({
  siteId,
  memo,
  mode,
  busy,
  onPick,
  onCancel,
}: {
  siteId: string;
  memo: MemoDetail;
  mode: MemoPickMode;
  busy: boolean;
  onPick: (uiElementId: string, page: string) => void;
  onCancel: () => void;
}) {
  const { appDict, voiceControl } = useAssist();
  const t = appDict.voiceControl.memo;
  const errText = useSetupErrorText();
  const steps = memo.draft.steps;
  const startPage =
    mode.kind === 'replace'
      ? (steps[mode.index]?.page ?? '/')
      : (steps[steps.length - 1]?.page ?? '/');
  const [page, setPage] = useState(startPage);
  const [asked, setAsked] = useState(startPage);
  const list = useAsync(
    () =>
      voiceControl.memo.elements(
        siteId,
        memo.number,
        mode.kind === 'replace' && asked === startPage
          ? { step: mode.index }
          : { page: asked }
      ),
    [voiceControl, siteId, memo.number, asked, mode.kind]
  );
  const shown = list.data?.page ?? asked;
  return (
    <div className="space-y-2 rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs">
      <div className="flex items-center justify-between gap-2 font-medium">
        <span>
          {mode.kind === 'add'
            ? fmt(t.pickTitleAdd, { page: shown })
            : fmt(t.pickTitleReplace, { n: mode.index + 1, page: shown })}
        </span>
        <Button
          variant="ghost"
          aria-label={t.pickCancel}
          icon={<X size={14} />}
          onClick={onCancel}
        />
      </div>
      {mode.kind === 'add' && (
        <div className="flex items-end gap-2">
          <Field label={t.pickPage} htmlFor={`mp-${memo.number}`}>
            <input
              id={`mp-${memo.number}`}
              className={inputClass}
              value={page}
              maxLength={300}
              placeholder="/catalog/*"
              onChange={(e) => setPage(e.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            disabled={!page.trim().startsWith('/')}
            onClick={() => setAsked(page.trim())}
          >
            {t.pickLoad}
          </Button>
        </div>
      )}
      <p className="text-silver-500">{t.pickHint}</p>
      {list.error && (
        <p className="text-red-600">
          {(() => {
            const code = voiceControlErrorCode(list.error);
            return code
              ? appDict.voiceControl.errors[code]
              : errText(list.error);
          })()}
        </p>
      )}
      {list.data && list.data.items.length === 0 && <p>{t.pickEmpty}</p>}
      <ul className="space-y-1">
        {(list.data?.items ?? []).map((el) => (
          <li key={el.uiElementId}>
            <button
              type="button"
              disabled={busy}
              className="w-full text-left rounded-md border border-silver-200 dark:border-silver-800 px-2 py-1 flex items-center justify-between gap-2 disabled:opacity-50"
              onClick={() => onPick(el.uiElementId, list.data?.page ?? asked)}
            >
              <span className="flex items-center gap-1 min-w-0">
                <MousePointerClick size={14} className="shrink-0" />
                <span className="truncate">«{el.label || el.tag}»</span>
              </span>
              <span className="flex gap-1 shrink-0">
                <Badge tone="neutral">
                  {t.pickActions[el.action as keyof typeof t.pickActions] ??
                    el.action}
                </Badge>
                {el.stability === 'fragile' && (
                  <Badge tone="warning">{t.pickFragile}</Badge>
                )}
                {el.stale && <Badge tone="danger">{t.pickStale}</Badge>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
