/**
 * Личный бренд-бук «Я в кадре» (ТЗ Greeting 2.0 §4.1 п. 7, §4.7): вид
 * бренд-бука и поля, которые есть только у личного, — образ по
 * умолчанию, подпись «от кого», тон по умолчанию и стиль карточек.
 *
 * Отдельным файлом, а не ещё сотней строк в `ManifestScreen.tsx`: форма
 * стиля там и так самая длинная, а эти поля появляются только при
 * персоне. Состояние держит форма-хозяин (она же сохраняет одним PATCH).
 */

import { Field, Input, Pills, Select } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  type BrandManifestKind,
  type CardStyle,
  CARD_STYLE_COLORS,
  CARD_STYLE_COLOR_HEX,
  CARD_STYLE_FONTS,
  type CardStyleFont,
  DEFAULT_CARD_STYLE,
  type PersonaState,
  SIGNATURE_MAX,
  defaultLookOption,
  readyLooks,
} from '../../lib/persona-greeting';
import { lookDisplayLabel } from '../../lib/persona-flow';
import { GREETING_TONES } from '../../types/project';

/** CSS-семейство для предпросмотра — то же деление, что у сервера. */
const FONT_CSS: Record<CardStyleFont, string> = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: '"DejaVu Serif", Georgia, serif',
  condensed: '"DejaVu Sans Condensed", "Arial Narrow", sans-serif',
  mono: '"DejaVu Sans Mono", "Courier New", monospace',
};

export function KindSwitch({
  value,
  onChange,
  companyAllowed,
  disabled,
}: {
  value: BrandManifestKind;
  onChange: (kind: BrandManifestKind) => void;
  /** Корпоративный закрыт режимом (§23) — вариант виден, но погашен. */
  companyAllowed: boolean;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const pg = dict.personaGreeting;
  return (
    <Field
      label={pg.kindLabel}
      hint={value === 'PERSONAL' ? pg.kindPersonalHint : pg.kindCompanyHint}
    >
      <Pills
        value={value}
        onChange={onChange}
        disabled={disabled}
        columns={2}
        ariaLabel={pg.kindLabel}
        options={[
          {
            value: 'COMPANY' as BrandManifestKind,
            label: pg.kindCompany,
            disabled: !companyAllowed && value !== 'COMPANY',
          },
          { value: 'PERSONAL' as BrandManifestKind, label: pg.kindPersonal },
        ]}
      />
    </Field>
  );
}

export interface PersonalFieldsValue {
  defaultLookId: string;
  signature: string;
  defaultTone: string;
  cardStyle: CardStyle | null;
}

export function PersonalBrandFields({
  value,
  onChange,
  persona,
  disabled,
}: {
  value: PersonalFieldsValue;
  onChange: (patch: Partial<PersonalFieldsValue>) => void;
  /** Персона (общий кеш): готовые образы и загружена ли она вообще. */
  persona: PersonaState;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const pg = dict.personaGreeting;
  const tones = dict.greetingVideoWizard.tone as Record<string, string>;
  const style = value.cardStyle ?? DEFAULT_CARD_STYLE;
  const looks = readyLooks(persona);
  // Выбранный образ, которого нет среди готовых, остаётся в списке с
  // пометкой, а не пропадает молча; «удалён» — только когда персона
  // загружена (`defaultLookOption`).
  const lookOption = defaultLookOption(value.defaultLookId, persona);

  return (
    <div className="space-y-4 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <Field
        label={pg.defaultLookLabel}
        hint={pg.defaultLookHint}
        htmlFor="pb-default-look"
      >
        <Select
          id="pb-default-look"
          value={value.defaultLookId}
          onChange={(e) => onChange({ defaultLookId: e.target.value })}
          disabled={disabled}
        >
          <option value="">{pg.defaultLookNone}</option>
          {looks.map((l) => (
            <option key={l.id} value={l.id}>
              {lookDisplayLabel(l, dict.persona)}
            </option>
          ))}
          {(lookOption === 'missing' || lookOption === 'pending') && (
            <option value={value.defaultLookId}>
              {lookOption === 'missing'
                ? pg.presenterMissing
                : pg.defaultLookPending}
            </option>
          )}
        </Select>
      </Field>

      <Field
        label={pg.signatureLabel}
        hint={pg.signatureHint}
        counter={`${value.signature.length}/${SIGNATURE_MAX}`}
        htmlFor="pb-signature"
      >
        <Input
          id="pb-signature"
          value={value.signature}
          maxLength={SIGNATURE_MAX}
          onChange={(e) =>
            onChange({ signature: e.target.value.slice(0, SIGNATURE_MAX) })
          }
          placeholder={pg.signaturePlaceholder}
          disabled={disabled}
        />
      </Field>

      <Field
        label={pg.defaultToneLabel}
        hint={pg.defaultToneHint}
        htmlFor="pb-default-tone"
      >
        <Select
          id="pb-default-tone"
          value={value.defaultTone}
          onChange={(e) => onChange({ defaultTone: e.target.value })}
          disabled={disabled}
        >
          <option value="">{pg.defaultToneNone}</option>
          {GREETING_TONES.map((t) => (
            <option key={t} value={t}>
              {tones[t] ?? t}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={pg.cardStyleLabel} hint={pg.cardStyleHint}>
        <div className="space-y-2">
          <Pills
            value={value.cardStyle ? value.cardStyle.font : 'default'}
            onChange={(font) =>
              onChange({
                cardStyle:
                  font === 'default'
                    ? null
                    : { ...style, font: font as CardStyleFont },
              })
            }
            disabled={disabled}
            columns={4}
            ariaLabel={pg.cardStyleLabel}
            options={[
              { value: 'default', label: pg.cardStyleDefault },
              ...CARD_STYLE_FONTS.map((f) => ({
                value: f as string,
                label: pg.cardFonts[f],
              })),
            ]}
          />
          {value.cardStyle && (
            <>
              <div
                role="radiogroup"
                aria-label={pg.cardColorLabel}
                className="flex flex-wrap gap-2"
              >
                {CARD_STYLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={style.color === c}
                    aria-label={pg.cardColors[c]}
                    disabled={disabled}
                    onClick={() =>
                      onChange({ cardStyle: { ...style, color: c } })
                    }
                    className={`h-9 w-9 rounded-full border-2 ${
                      style.color === c
                        ? 'border-accent'
                        : 'border-silver-300 dark:border-silver-700'
                    }`}
                    style={{ backgroundColor: `#${CARD_STYLE_COLOR_HEX[c]}` }}
                  />
                ))}
              </div>
              {/* Предпросмотр плашки: тёмная подложка, как у карточки в кадре. */}
              <p
                className="rounded-lg bg-silver-950/80 px-3 py-2 text-center text-sm"
                style={{
                  fontFamily: FONT_CSS[style.font],
                  color: `#${CARD_STYLE_COLOR_HEX[style.color]}`,
                }}
              >
                {value.signature.trim() || pg.cardPreviewSample}
              </p>
            </>
          )}
        </div>
      </Field>
    </div>
  );
}
