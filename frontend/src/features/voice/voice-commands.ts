/**
 * Реестр голосовых обработчиков экрана — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2, §4А.7.
 *
 * Поля живут в состоянии своих карточек (`BriefStep` держит повод, имя,
 * тон), и применить к ним голос можно только ИЗНУТРИ карточки — через
 * те же setState, что у ручного ввода. Поэтому карточка сама
 * регистрирует здесь, какие хуки полей она умеет заполнить
 * (`useVoiceFieldApplier`) и какие команды выполнить (`useVoiceCommand`),
 * а помощник (`VoiceAssistant`) только спрашивает реестр. Снялась
 * карточка — снялась и регистрация: голос не пишет в поле, которого нет
 * на экране.
 *
 * Файл `.ts` без JSX — по образцу `lib/i18n-context.ts`: провайдер
 * (`VoiceCommandsProvider.tsx`) отдельно, и правило
 * `react-refresh/only-export-components` не спорит с экспортом хуков.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import type {
  VoiceApplyOutcome,
  VoiceCard,
  VoiceFieldApplyEffect,
} from '../../lib/voice-confirm';
import type { VoiceCommandOutcome } from '../../lib/voice-intents';
import type { VoiceCommand, VoiceField } from '../../lib/voice-types';

/**
 * Отчёт владельца полей (K5): отказы — по одной строке на НЕ применённое
 * поле; `effects` — что стало с применёнными (сохранено тем же
 * обработчиком / ждёт кнопку / не сохранилось).
 */
export interface VoiceFieldApplyReport {
  refusals: string[];
  effects: VoiceFieldApplyEffect[];
}

export interface VoiceFieldApplier {
  /** Хуки `data-qa` полей, которые карточка заполняет. */
  targets: readonly string[];
  /** Значение для карточки «я понял так» человеческими словами. */
  describe: (field: VoiceField) => string;
  /**
   * Применить подтверждённые поля теми же обработчиками, что ручной
   * ввод. Массив строк — старый контракт (только отказы); отчёт — с тем,
   * что стало с применённым; промис — если обработчик сохраняет, и
   * «Готово» должно дождаться ответа сервера (аудит волны 2).
   */
  apply: (
    fields: VoiceField[]
  ) => string[] | VoiceFieldApplyReport | Promise<VoiceFieldApplyReport>;
}

export interface VoiceCommandHandler {
  /** Что показать на карточке — или отказ с причиной. */
  propose: (args: Record<string, string> | undefined) => VoiceCommandOutcome;
  /** Действие карточки `action` — после «Да». */
  run?: () => void;
}

type Getter<T> = () => T;

export class VoiceCommandRegistry {
  private readonly appliers = new Set<Getter<VoiceFieldApplier>>();
  private readonly commands = new Map<
    VoiceCommand,
    Getter<VoiceCommandHandler | null>
  >();

  addApplier(get: Getter<VoiceFieldApplier>): () => void {
    this.appliers.add(get);
    return () => {
      this.appliers.delete(get);
    };
  }

  addCommand(
    command: VoiceCommand,
    get: Getter<VoiceCommandHandler | null>
  ): () => void {
    this.commands.set(command, get);
    return () => {
      if (this.commands.get(command) === get) this.commands.delete(command);
    };
  }

  /** Регистрация владельца поля — ключ группировки, а не объект: геттер
   * может отдавать новый объект на каждый вызов. */
  private ownerOf(target: string): Getter<VoiceFieldApplier> | null {
    for (const get of this.appliers) {
      if (get().targets.includes(target)) return get;
    }
    return null;
  }

  private applierFor(target: string): VoiceFieldApplier | null {
    return this.ownerOf(target)?.() ?? null;
  }

  canFill(target: string): boolean {
    return this.applierFor(target) !== null;
  }

  describe(field: VoiceField): string {
    return (
      this.applierFor(field.target)?.describe(field) ?? String(field.value)
    );
  }

  command(
    command: VoiceCommand,
    args: Record<string, string> | undefined
  ): VoiceCommandOutcome | null {
    return this.commands.get(command)?.()?.propose(args) ?? null;
  }

  /**
   * «Да» на карточке: поля — владельцам, по одному вызову на владельца
   * (порядок полей внутри карточки решает сам владелец, см.
   * `applyBriefVoiceFields`); действие — его обработчику.
   *
   * Итог — что применилось НА САМОМ ДЕЛЕ: карточка могла пережить своих
   * владельцев (сценарий собрали руками, кнопка исчезла), и «Готово» на
   * то, что никуда не попало, было бы неправдой (аудит волны 1).
   */
  async applyCard(card: VoiceCard): Promise<VoiceApplyOutcome> {
    if (card.kind === 'action') {
      const run = this.commands.get(card.command)?.()?.run;
      if (run) run();
      return { kind: 'action', ran: !!run, label: card.label };
    }
    const byOwner = new Map<Getter<VoiceFieldApplier>, VoiceField[]>();
    for (const f of card.fields) {
      const owner = this.ownerOf(f.target);
      if (!owner) continue;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), f]);
    }
    // Все владельцы зовутся СРАЗУ (каждый читает состояние экрана в
    // момент «Да»), а ждём уже их сохранений: «Готово» — после ответа
    // сервера, а не до него (аудит волны 2).
    const pending = [...byOwner].map(async ([owner, fields]) => {
      const r = owner().apply(fields);
      return { fields, report: Array.isArray(r) ? r : await r };
    });
    const refusals: string[] = [];
    const needsSave: string[] = [];
    const failures: string[] = [];
    let saved = false;
    let applied = 0;
    for (const { fields, report } of await Promise.all(pending)) {
      // Отказ — одна строка на поле (контракт `VoiceFieldApplier.apply`).
      const refused = Array.isArray(report) ? report : report.refusals;
      refusals.push(...refused);
      applied += Math.max(0, fields.length - refused.length);
      if (Array.isArray(report)) continue;
      for (const e of report.effects) {
        if (e.kind === 'saved') saved = true;
        else if (e.kind === 'failed') failures.push(e.reason);
        else if (!needsSave.includes(e.button)) needsSave.push(e.button);
      }
    }
    return {
      kind: 'fill',
      applied,
      refusals,
      ...(saved ? { saved: true as const } : {}),
      ...(needsSave.length > 0 ? { needsSave } : {}),
      ...(failures.length > 0 ? { failures } : {}),
    };
  }
}

export const VoiceCommandsContext = createContext<VoiceCommandRegistry | null>(
  null
);

/** Реестр мастера; вне провайдера — `null` (голос выключен, экран создания). */
export function useVoiceCommands(): VoiceCommandRegistry | null {
  return useContext(VoiceCommandsContext);
}

/**
 * Зарегистрировать поля карточки. Обработчик читается через ref — в
 * момент «Да» применяется к ТЕКУЩЕМУ состоянию карточки, а не к тому,
 * что было при монтировании.
 */
export function useVoiceFieldApplier(applier: VoiceFieldApplier): void {
  const registry = useVoiceCommands();
  const ref = useRef(applier);
  ref.current = applier;
  useEffect(() => registry?.addApplier(() => ref.current), [registry]);
}

/** Зарегистрировать команду; `null` — команды сейчас нет на экране. */
export function useVoiceCommand(
  command: VoiceCommand,
  handler: VoiceCommandHandler | null
): void {
  const registry = useVoiceCommands();
  const ref = useRef(handler);
  ref.current = handler;
  const active = handler !== null;
  useEffect(() => {
    if (!registry || !active) return;
    return registry.addCommand(command, () => ref.current);
  }, [registry, command, active]);
}

// ── K7: согласие на генерацию голосом (§4А.7.4) ─────────────────────────

/** Что сказать после реплики, обращённой к сводке перед генерацией. */
export interface VoiceConsentLine {
  text: string;
  tone: 'info' | 'warning' | 'success';
}

/**
 * Кнопка генерации мастера (`VideoStep`) — единственный, кто может
 * запустить рендер голосом, и запускает его ТЕМ ЖЕ обработчиком, что
 * нажатие. Автомат (сводка → согласие) — `lib/voice-consent.ts`.
 */
export interface VoiceConsentTarget {
  /** Сводка на экране — «нет» относится к ней. */
  isOpen: () => boolean;
  /** Сервер отдал `consent`: показать сводку или нажать кнопку. */
  consent: (
    confidence: number,
    hasPendingCard: boolean,
    /** Реплика ещё актуальна (не выключили микрофон, не сказали другое). */
    isCurrent: () => boolean
  ) => Promise<VoiceConsentLine | null>;
  /** «Нет»/«отмена» — закрыть сводку. */
  cancel: () => VoiceConsentLine | null;
  /** Другое действие голосом — цепочка прервана, сводка закрыта. */
  interrupt: () => void;
}

// Отдельно от класса реестра: согласие — не поле и не команда, у него
// один владелец и нет карточки «я понял так» (подтверждение — сама
// сводка с ценой). WeakMap — реестр живёт, пока жив мастер.
const consentTargets = new WeakMap<
  VoiceCommandRegistry,
  () => VoiceConsentTarget | null
>();

/** Владелец кнопки генерации, если она сейчас на экране. */
export function voiceConsentTarget(
  registry: VoiceCommandRegistry | null
): VoiceConsentTarget | null {
  if (!registry) return null;
  return consentTargets.get(registry)?.() ?? null;
}

/**
 * Зарегистрировать кнопку генерации как цель согласия.
 *
 * @returns «я всё ещё текущая цель»: снятый с экрана или вытесненный
 * новой сессией шаг «Видео» не должен запустить рендер по ответу,
 * который ждал сети, пока шаг сменился (аудит волны 2).
 */
export function useVoiceConsentTarget(
  target: VoiceConsentTarget
): () => boolean {
  const registry = useVoiceCommands();
  const ref = useRef(target);
  ref.current = target;
  const getRef = useRef<(() => VoiceConsentTarget) | null>(null);
  useEffect(() => {
    if (!registry) return;
    const get = () => ref.current;
    getRef.current = get;
    consentTargets.set(registry, get);
    return () => {
      getRef.current = null;
      if (consentTargets.get(registry) === get) consentTargets.delete(registry);
    };
  }, [registry]);
  return () =>
    !!registry &&
    getRef.current !== null &&
    consentTargets.get(registry) === getRef.current;
}
