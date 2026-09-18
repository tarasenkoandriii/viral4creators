/**
 * Части окна скетча (`SketchSheet.tsx`), вынесенные ради его размера:
 * форма параметров (§3.2, пп. 1–3) и превью «оригинал / скетч» (п. 5).
 * Состояния здесь нет — всё приходит сверху, чтобы «Ещё вариант»
 * генерировал ровно теми параметрами, которые видит пользователь.
 */

import { Field, Pills, Textarea } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import type {
  SketchMode,
  SketchOptions,
  SketchTargetType,
} from '../../types/sketch';
import type { SketchStyle } from '../../types/sketch';
import {
  isAnonymizeForced,
  showsRealisticNote,
  sketchSubject,
  SKETCH_DESCRIPTION_MAX,
  SKETCH_DESCRIPTION_MIN,
  SKETCH_STYLES,
  supportsRemoveLogos,
} from './sketch-model';

export function SketchForm({
  targetType,
  modes,
  mode,
  style,
  options,
  description,
  disabled,
  onMode,
  onStyle,
  onOptions,
  onDescription,
}: {
  targetType: SketchTargetType;
  /** Один режим — выбора нет, и радио не рисуется (аудит А-10). */
  modes: SketchMode[];
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  description: string;
  disabled: boolean;
  onMode: (v: SketchMode) => void;
  onStyle: (v: SketchStyle) => void;
  onOptions: (fn: (prev: SketchOptions) => SketchOptions) => void;
  onDescription: (v: string) => void;
}) {
  const { dict } = useI18n();
  const t = dict.sketch;

  return (
    <>
      {modes.length > 1 && (
        <div>
          <span className="label">{t.sourceLabel}</span>
          <Pills
            value={mode}
            ariaLabel={t.sourceLabel}
            onChange={onMode}
            options={modes.map((m) => ({
              value: m,
              label: m === 'from-image' ? t.sourceImage : t.sourceText,
            }))}
            disabled={disabled}
          />
        </div>
      )}

      {mode === 'from-text' && (
        <Field
          label={t.descriptionLabel}
          htmlFor="sketch-description"
          hint={
            // Слишком короткий текст сервер отвергает валидацией
            // (`@Length(3, 2000)`) — говорим об этом ДО нажатия, а не
            // сырой непереведённой ошибкой после (аудит A-15).
            description.trim().length > 0 &&
            description.trim().length < SKETCH_DESCRIPTION_MIN
              ? t.descriptionTooShort
              : sketchSubject(targetType) === 'character'
                ? t.sourceTextHintPeople
                : undefined
          }
          counter={`${description.length}/${SKETCH_DESCRIPTION_MAX}`}
        >
          <Textarea
            id="sketch-description"
            rows={4}
            value={description}
            placeholder={t.descriptionPlaceholder}
            onChange={(e) =>
              onDescription(e.target.value.slice(0, SKETCH_DESCRIPTION_MAX))
            }
            disabled={disabled}
          />
        </Field>
      )}

      <div>
        <span className="label">{t.styleLabel}</span>
        <Pills
          value={style}
          ariaLabel={t.styleLabel}
          columns={2}
          onChange={onStyle}
          options={SKETCH_STYLES.map((s) => ({ value: s, label: t.styles[s] }))}
          disabled={disabled}
        />
      </div>

      <div className="space-y-1">
        <span className="label">{t.optionsLabel}</span>
        {isAnonymizeForced(targetType, mode) && (
          <Check
            checked
            locked
            label={t.optAnonymize}
            hint={t.optAnonymizeLocked}
            onChange={() => {}}
          />
        )}
        {supportsRemoveLogos(targetType) && (
          <Check
            checked={options.removeLogos ?? false}
            label={t.optRemoveLogos}
            disabled={disabled}
            onChange={(v) => onOptions((o) => ({ ...o, removeLogos: v }))}
          />
        )}
        <Check
          checked={options.keepColors ?? false}
          label={t.optKeepColors}
          disabled={disabled}
          onChange={(v) => onOptions((o) => ({ ...o, keepColors: v }))}
        />
      </div>

      <div>
        <span className="label">{t.renderingLabel}</span>
        <Pills
          value={options.sketchRendering ?? 'realistic'}
          ariaLabel={t.renderingLabel}
          onChange={(v) => onOptions((o) => ({ ...o, sketchRendering: v }))}
          options={[
            { value: 'realistic' as const, label: t.rendering.realistic },
            { value: 'stylized' as const, label: t.rendering.stylized },
          ]}
          disabled={disabled}
        />
        {showsRealisticNote(options) && (
          <p className="mt-1 text-[11px] text-silver-400">
            {t.renderingRealisticNote}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * Флажок опции. Заблокированный показывается включённым, а не прячется:
 * пользователь должен видеть, что лицо всё равно меняется (§4, п. 3).
 */
function Check({
  checked,
  label,
  hint,
  locked = false,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  locked?: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-[44px] items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        disabled={locked || disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-sky-400 disabled:opacity-60"
      />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-silver-400">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Оригинал и скетч рядом — на широком экране обе половины сразу, на
 * узком переключатель: две картинки в одной строке телефона
 * превращаются в две марки, по которым ничего не решишь.
 *
 * `data-qa-mask` (этап 100) — крон UI-снимков не должен считать
 * сменившееся изображение регрессом вёрстки.
 */
export function SketchPreview({
  originalUrl,
  sketchUrl,
  compare,
  onCompare,
}: {
  originalUrl: string | null;
  sketchUrl: string;
  compare: 'original' | 'sketch';
  onCompare: (v: 'original' | 'sketch') => void;
}) {
  const { dict } = useI18n();
  const t = dict.sketch;

  if (!originalUrl) {
    return (
      <img
        src={sketchUrl}
        alt={t.compareSketch}
        data-qa-mask="sketch-preview"
        className="mx-auto max-h-64 rounded-xl border border-silver-200/70 object-contain dark:border-silver-800"
      />
    );
  }
  return (
    <div className="space-y-2">
      <div className="sm:hidden">
        <Pills
          value={compare}
          ariaLabel={t.compareLabel}
          onChange={onCompare}
          options={[
            { value: 'original' as const, label: t.compareOriginal },
            { value: 'sketch' as const, label: t.compareSketch },
          ]}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <figure className={compare === 'original' ? '' : 'hidden sm:block'}>
          <img
            src={originalUrl}
            alt=""
            data-qa-mask="sketch-original"
            className="max-h-56 w-full rounded-xl border border-silver-200/70 object-contain dark:border-silver-800"
          />
          <figcaption className="mt-1 text-center text-[11px] text-silver-400">
            {t.compareOriginal}
          </figcaption>
        </figure>
        <figure className={compare === 'sketch' ? '' : 'hidden sm:block'}>
          <img
            src={sketchUrl}
            alt=""
            data-qa-mask="sketch-preview"
            className="max-h-56 w-full rounded-xl border border-accent/40 object-contain"
          />
          <figcaption className="mt-1 text-center text-[11px] text-silver-400">
            {t.compareSketch}
          </figcaption>
        </figure>
      </div>
    </div>
  );
}
