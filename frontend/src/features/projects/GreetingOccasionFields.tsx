/**
 * Повод → настроение → тон — общий блок экрана создания проекта и брифа
 * мастера (этап D ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`
 * §3.4 п. 1, §3.5).
 *
 * Почему один компонент, а не две копии разметки: до этапа D оба экрана
 * держали по своей копии сброса тона при смене повода, и правило жило ещё
 * в третьей — `allowedTonesFor` во `types/project.ts`, которую Т-18
 * удалил. Теперь выбор строится по таблице сервера, и строится в одном
 * месте.
 *
 * Компонент управляемый: состояние держит экран (ему его сохранять), сюда
 * приходят значения и уходят правки. Своё здесь — только строка
 * «Тон: … → …»: это отчёт о последнем действии, а не данные брифа.
 * После сохранения он устарел — экран брифа сбрасывает его, меняя `key`
 * блока на счётчик сохранений.
 *
 * Логика без разметки — в `lib/greeting-occasion-fields.ts` (с тестом).
 */

import { useEffect, useId, useState } from 'react';
import { Button, Field, Input, Pills, Select } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import {
  GREETING_REGISTER_ORDER,
  recommendedTone,
  toneOptions,
  type GreetingPolicyView,
  type ToneChange,
} from '../../lib/greeting-policy';
import {
  applyOccasionPatch,
  fieldsRegister,
  formatToneChange,
  raisedMoodToShow,
  type OccasionFieldsState,
} from '../../lib/greeting-occasion-fields';
import {
  GREETING_OCCASIONS,
  MAX_CUSTOM_OCCASION_LENGTH,
  type GreetingOccasion,
  type GreetingRegister,
} from '../../types/project';

export function GreetingOccasionFields({
  value,
  onChange,
  policy,
  serverRegister = null,
  serverRegisterFor,
  disabled,
  announcedToneChange,
}: {
  value: OccasionFieldsState;
  onChange: (patch: Partial<OccasionFieldsState>) => void;
  /** `null` — таблица не загрузилась: все тоны доступны, решает сервер. */
  policy: GreetingPolicyView | null;
  /**
   * Регистр сохранённого брифа, поднятый проверкой сервера (ключевые
   * слова, классификатор), пока описание не переписано, —
   * `effectiveServerRegister`. На экране создания брифа ещё нет, и его
   * нет.
   */
  serverRegister?: GreetingRegister | null;
  /**
   * То же для БУДУЩЕГО состояния — чтобы правка повода, настроения или
   * описания сверяла тон с регистром, который получится после неё. Нет —
   * берётся `serverRegister` как есть (экран создания).
   */
  serverRegisterFor?: (next: OccasionFieldsState) => GreetingRegister | null;
  disabled?: boolean;
  /**
   * Сброс тона, случившийся НЕ здесь, — голосом (этап K3): карточка «я
   * понял так» применила повод, и строку «Тон: … → …» надо назвать так
   * же, как при выборе в списке. `seq` — чтобы одно и то же изменение,
   * пришедшее дважды, показалось дважды.
   */
  announcedToneChange?: { change: ToneChange | null; seq: number };
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const customId = useId();
  const [toneChange, setToneChange] = useState<ToneChange | null>(null);
  const announcedSeq = announcedToneChange?.seq;
  const announced = announcedToneChange?.change ?? null;
  // Номер на момент монтирования — уже показанное: после сохранения блок
  // перемонтируется (`key`), и прежняя строка не должна вернуться.
  const [mountedSeq] = useState(announcedSeq);
  useEffect(() => {
    if (announcedSeq !== undefined && announcedSeq !== mountedSeq) {
      setToneChange(announced);
    }
    // Только по номеру: объект изменения новый на каждом рендере экрана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcedSeq]);

  const register = fieldsRegister(policy, value, serverRegister);
  const recommended = recommendedTone(policy, value.occasion, register);
  const raisedMood = raisedMoodToShow(
    policy,
    value.occasion,
    value.mood,
    serverRegister
  );

  /**
   * Повод и настроение меняют регистр, а с ним — допустимые тоны. Тон,
   * ставший недопустимым, сбрасывается на умолчание регистра, и экран
   * называет замену (§3.5), а не меняет молча: раньше «С юмором» просто
   * исчезал из списка, и человек не понимал, куда делся его выбор.
   */
  const changeRegisterInput = (
    patch: Partial<
      Pick<OccasionFieldsState, 'occasion' | 'mood' | 'customOccasionText'>
    >
  ) => {
    const result = applyOccasionPatch(
      policy,
      value,
      patch,
      serverRegisterFor ?? serverRegister
    );
    setToneChange(result.change);
    onChange(result.patch);
  };

  return (
    <>
      <Field label={w.occasionLabel}>
        <Select
          data-qa="greeting-field-occasion"
          value={value.occasion}
          onChange={(e) =>
            changeRegisterInput({
              occasion: e.target.value as GreetingOccasion,
            })
          }
          disabled={disabled}
        >
          {GREETING_OCCASIONS.map((o) => (
            <option key={o} value={o}>
              {w.occasion[o]}
            </option>
          ))}
        </Select>
      </Field>

      {value.occasion === 'OTHER' && (
        <>
          <Field label={w.customOccasionLabel} htmlFor={customId}>
            <Input
              data-qa="greeting-field-custom-occasion"
              id={customId}
              value={value.customOccasionText}
              // Через тот же сброс, что повод и настроение: переписанное
              // описание снимает (или возвращает) подъём регистра сервером.
              onChange={(e) =>
                changeRegisterInput({
                  customOccasionText: e.target.value.slice(
                    0,
                    MAX_CUSTOM_OCCASION_LENGTH
                  ),
                })
              }
              placeholder={w.customOccasionPlaceholder}
              disabled={disabled}
            />
          </Field>

          {/* §3.4 п. 1: один обязательный вопрос сразу после «Особого
              повода». Регистр по тексту угадывают и сервер, и
              классификатор, но только вверх — мягче ответа человека
              ролик не станет, а без ответа не с чего начинать. */}
          <div data-qa="greeting-field-mood">
            <span className="label">{w.moodLabel}</span>
            <Pills
              value={value.mood ?? ('' as GreetingRegister)}
              onChange={(mood) => changeRegisterInput({ mood })}
              disabled={disabled}
              ariaLabel={w.moodLabel}
              options={GREETING_REGISTER_ORDER.map((r) => ({
                value: r,
                label: w.mood[r],
              }))}
            />
            {!value.mood && (
              <p className="mt-1 text-xs text-silver-400">{w.moodRequired}</p>
            )}
            {raisedMood && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {w.registerRaisedNote.replace('{mood}', w.mood[raisedMood])}
              </p>
            )}
          </div>
        </>
      )}

      <div data-qa="greeting-field-tone">
        <span className="label">{w.toneLabel}</span>
        {/* Недоступный тон виден серым с подписью, а не пропадает (§3.5):
            пропавшего варианта для человека не существует, и он не
            узнает, почему его выбор исчез. */}
        <Pills
          value={value.tone}
          onChange={(tone) => {
            setToneChange(null);
            onChange({ tone });
          }}
          disabled={disabled}
          ariaLabel={w.toneLabel}
          options={toneOptions(policy, value.occasion, register).map((o) => ({
            value: o.tone,
            label: w.tone[o.tone],
            disabled: !o.allowed,
            sub: o.allowed ? undefined : w.toneUnavailable,
          }))}
        />
        {toneChange && (
          <p className="mt-1 text-xs text-silver-400" role="status">
            {formatToneChange(w.toneChangedNote, toneChange, w.tone)}
          </p>
        )}
        {/* Кнопка — только когда есть что ставить: умолчание регистра
            известно (таблица пришла, настроение отвечено) и отличается
            от выбранного. Иначе она ничего не делала бы. */}
        {recommended && recommended !== value.tone && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1"
            disabled={disabled}
            onClick={() => {
              setToneChange(null);
              onChange({ tone: recommended });
            }}
          >
            {w.recommendedSettings}
          </Button>
        )}
      </div>
    </>
  );
}
