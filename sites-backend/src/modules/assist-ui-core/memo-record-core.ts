/**
 * Запись мемо кликами — общие ЧИСТЫЕ правила двух контуров (заход 13,
 * Р-З13-А1): действие шага по дескриптору элемента, тип и имя слота поля,
 * варианты списка. «Сайт» — `assist-site-voice-map/editor/memo-record.ts`
 * (шаги `click/fill/select/check`, пины, цели и риск сайта); «Админка» —
 * `assist-admin-voice-map/editor/admin-memo-record.ts` (шаги `ui` мемо АМ-N
 * без серверного эффекта). Значений полей здесь нет и не бывает.
 */
import {
  MEMO_LIMITS,
  memoTextProblem,
  suggestMemoKey,
  type MemoSlot,
  type MemoSlotKind,
  type MemoStepKind,
} from './memo';
import { normText } from './normalize';
import { cleanText } from './snapshot';
import type { VoiceMapDescriptor } from './voice-map';

const SLOT_NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;

/** Действие шага по элементу: поле → `fill`, список → `select`, флажок → `check`. */
export function actionOf(d: VoiceMapDescriptor): MemoStepKind {
  if (d.tag === 'select' || d.role === 'combobox') return 'select';
  if (d.role === 'checkbox' || d.role === 'radio' || d.role === 'switch')
    return 'check';
  const field =
    d.tag === 'textarea' ||
    (d.tag === 'input' &&
      !['submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(
        d.inputType ?? 'text',
      ));
  if (field || d.role === 'textbox' || d.role === 'searchbox') return 'fill';
  return 'click';
}

/** Тип слота по полю (тип, подпись) — значения поля здесь нет. */
export function slotKindOf(
  d: VoiceMapDescriptor,
  hasOptions: boolean,
): MemoSlotKind {
  if (d.tag === 'select' || d.role === 'combobox')
    return hasOptions ? 'option' : 'text';
  const t = d.inputType;
  const label = `${d.text} ${d.hiddenLabel ?? ''}`;
  if (t === 'email' || /e-?mail|пошт|почт/iu.test(label)) return 'email';
  if (t === 'tel' || /телефон|phone|mobile|\btel\b/iu.test(label))
    return 'phone';
  if (t === 'number' || t === 'range') return 'number';
  if (t === 'date' || t === 'datetime-local') return 'date';
  return 'text';
}

/** Имя слота `[a-z][a-z0-9_]{0,19}` из `name`/подписи/`aria-label`/id поля. */
export function slotNameOf(
  bases: ReadonlyArray<string | null | undefined>,
  kind: MemoSlotKind,
  taken: readonly string[],
): string {
  let base: string = kind;
  for (const b of bases) {
    if (!b) continue;
    const k = suggestMemoKey(b);
    if (k === 'memo' && !/memo/i.test(b)) continue;
    const n = k
      .replace(/-/g, '_')
      .replace(/^[^a-z]+/, '')
      .slice(0, 20)
      .replace(/_+$/, '');
    if (SLOT_NAME_RE.test(n)) {
      base = n;
      break;
    }
  }
  let name = base;
  for (let i = 2; taken.includes(name); i++) {
    const suf = `_${i}`;
    name = `${base.slice(0, 20 - suf.length).replace(/_+$/, '')}${suf}`;
  }
  return name;
}

/** Подписи вариантов `<select>` (недоверенно) → варианты слота `option`. */
export function optionsOf(raw: unknown): MemoSlot['options'] {
  if (!Array.isArray(raw)) return [];
  const out: MemoSlot['options'] = [];
  for (const o of raw.slice(0, 40)) {
    const t = cleanText(o, 60);
    if (!t || memoTextProblem(t, 60)) continue;
    if (out.some((x) => normText(x.value) === normText(t))) continue;
    out.push({ value: t, say: {} });
    if (out.length >= MEMO_LIMITS.slotOptions) break;
  }
  return out;
}
