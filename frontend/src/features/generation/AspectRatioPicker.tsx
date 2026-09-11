/**
 * AspectRatioPicker — spec §16: choose the ad's picture format from the
 * standard set or type a custom W:H. Starts from the reference video's
 * detected frame. Veo renders natively only 16:9 / 9:16 — for anything
 * else the picker says plainly what will happen (rendered in the nearest
 * native frame, composed for a center-crop; the crop itself arrives with
 * the media worker of the voice-over ТЗ).
 */

import { useEffect, useState } from 'react';
import { Crop, Lock, Scan, Star } from 'lucide-react';
import { Alert, Field, Input, Pills } from '../../components/ui';
import {
  isVeoNative,
  normaliseAspectRatio,
  STANDARD_ASPECT_RATIOS,
  veoFrameFor,
} from '../../lib/aspect-ratio';
import { usePlanState } from '../../lib/plan-context';
import { allowsAspectRatio } from '../../lib/plan';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';

const CUSTOM = 'custom';

export function AspectRatioPicker({
  value,
  onChange,
  referenceAspectRatio,
  referenceSource,
  disabled,
}: {
  value: string;
  onChange: (ratio: string) => void;
  referenceAspectRatio: string | null;
  referenceSource: 'file' | 'gemini' | 'manual' | null;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const isStandard = STANDARD_ASPECT_RATIOS.some((s) => s.value === value);
  const [mode, setMode] = useState<string>(isStandard ? value : CUSTOM);
  const [custom, setCustom] = useState(isStandard ? '' : value);
  const [customError, setCustomError] = useState<string | null>(null);

  /**
   * ТЗ §23: в Lite доступны только те два формата, которые Veo рендерит
   * нативно (16:9 и 9:16). Всё остальное требует обрезки — это и есть
   * возможность старших режимов. Пустой список у режима = любые форматы.
   */
  const planState = usePlanState();
  const allowed = planState?.plans[planState.plan]?.aspectRatios ?? [];
  const restricted = allowed.length > 0;
  const ratioAllowed = (r: string) =>
    !planState || allowsAspectRatio(planState, r);

  // Формат мог прийти от референса (например, 4:5 у файла) и оказаться
  // закрытым — переводим на ближайший родной, иначе кнопка генерации
  // упрётся в 403 сервера уже после загрузки фото товара.
  useEffect(() => {
    if (!planState || ratioAllowed(value)) return;
    const fallback = veoFrameFor(value);
    setMode(fallback);
    onChange(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planState, value]);

  const options = [
    ...STANDARD_ASPECT_RATIOS.map((s) => {
      const sub = dict.aspectRatio.subLabels[s.subKey];
      return {
        value: s.value,
        label: ratioAllowed(s.value) ? (
          s.label
        ) : (
          <span className="inline-flex items-center gap-1">
            <Lock size={9} /> {s.label}
          </span>
        ),
        sub:
          s.value === referenceAspectRatio ? (
            <span className="inline-flex items-center gap-0.5">
              <Star size={9} /> {sub}
            </span>
          ) : (
            sub
          ),
        disabled: !ratioAllowed(s.value),
      };
    }),
    {
      value: CUSTOM,
      label: restricted ? (
        <span className="inline-flex items-center gap-1">
          <Lock size={9} /> {dict.aspectRatioPicker.custom}
        </span>
      ) : (
        dict.aspectRatioPicker.custom
      ),
      sub: 'W:H',
      disabled: restricted,
    },
  ];

  return (
    <div className="space-y-2">
      <span className="label">{dict.aspectRatioPicker.title}</span>
      {referenceAspectRatio && (
        <p className="-mt-1 mb-1 inline-flex items-center gap-1 text-[11px] text-silver-400">
          <Scan size={11} />
          {dict.aspectRatioPicker.referenceBadge.replace(
            '{{ratio}}',
            referenceAspectRatio
          )}
          {referenceSource === 'file'
            ? dict.aspectRatioPicker.fileSuffix
            : referenceSource === 'gemini'
              ? dict.aspectRatioPicker.geminiSuffix
              : ''}
        </p>
      )}
      <Pills
        value={mode}
        onChange={(v) => {
          setMode(v);
          if (v !== CUSTOM) {
            setCustomError(null);
            onChange(v);
          } else if (custom) {
            const n = normaliseAspectRatio(custom);
            if (n) onChange(n);
          }
        }}
        options={options}
        columns={4}
      />
      {mode === CUSTOM && (
        <Field
          htmlFor="aspect-custom"
          error={customError ?? undefined}
          hint={dict.aspectRatioPicker.customHint}
        >
          <Input
            id="aspect-custom"
            value={custom}
            placeholder="21:9"
            disabled={disabled}
            invalid={!!customError}
            onChange={(e) => {
              const raw = e.target.value;
              setCustom(raw);
              const n = normaliseAspectRatio(raw);
              if (n) {
                setCustomError(null);
                onChange(n);
              } else {
                setCustomError(
                  raw.trim() ? dict.aspectRatioPicker.customError : null
                );
              }
            }}
          />
        </Field>
      )}
      {restricted && (
        <p className="inline-flex items-start gap-1.5 text-[11px] text-silver-400">
          <Lock size={11} className="mt-0.5 shrink-0" />
          <span>
            {dict.aspectRatioPicker.restrictedBefore}{' '}
            <span className="font-mono tabular">16:9</span>{' '}
            {dict.aspectRatioPicker.restrictedBetween}{' '}
            <span className="font-mono tabular">9:16</span>
            {dict.aspectRatioPicker.restrictedAfter}{' '}
            <button
              type="button"
              className="underline hover:text-accent"
              onClick={() => navigate(routes.plan())}
            >
              {dict.common.comparePlans}
            </button>
          </span>
        </p>
      )}
      {!isVeoNative(value) && (
        <Alert tone="info">
          <span className="inline-flex items-start gap-1.5">
            <Crop size={14} className="mt-0.5 shrink-0" />
            <span>
              {dict.aspectRatioPicker.cropPrefix} <b>{veoFrameFor(value)}</b>{' '}
              {dict.aspectRatioPicker.cropMiddle} <b>{value}</b>{' '}
              {dict.aspectRatioPicker.cropSuffix} {veoFrameFor(value)}{' '}
              {dict.aspectRatioPicker.cropEnd}
            </span>
          </span>
        </Alert>
      )}
    </div>
  );
}
