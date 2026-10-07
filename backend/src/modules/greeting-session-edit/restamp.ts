/**
 * Перештамповка сценария поздравления после смены голоса (CONTRACT6, G-B1,
 * регрессия проверочного аудита).
 *
 * ## Зачем
 *
 * Карточка голоса стоит в мастере ПОСЛЕ сценария. Голос (клон, пресет xAI)
 * и режим озвучки бренда входят в отпечаток сценария
 * (`greetingScriptInputs`), потому что меняют сцену: `<AUDIO_0>` у пресета,
 * «ведущий молчит» при своей озвучке. Без перештамповки любой выбор голоса
 * после сценария давал `GREETING_SCRIPT_STALE` на рендере — человек
 * выбирал голос ровно там, где его просят, и получал отказ.
 *
 * Перестроить сцену можно без модели: реплика уже есть
 * (`finalVoiceoverScript`), а сцена — детерминированная функция брифа,
 * фото, голоса и бренда (`buildSceneDescription`), та же, что у правки
 * сценария. Модерация — та же, что у правки: ключевые слова по готовой
 * сцене.
 *
 * ## Когда НЕ перештамповывается
 *
 * - Сценарий уже был устаревшим ДО смены голоса (фото или образ сменили
 *   в обход интерфейса): тихо «починить» его здесь значило бы отправить в
 *   рендер метки, которые никто не пересобирал. Он остаётся устаревшим, и
 *   рендер честно просит собрать заново.
 * - Сценарий без отпечатка (собран до волны) — сверки нет, трогать нечего.
 * - Ролик готов: сценарий принадлежит готовому ролику (§3.6), другой
 *   ролик делается новой версией.
 * - Реплики нет — пересобрать сцену не из чего.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GenerationPrompt,
  ModerationStatus,
} from '../../common/types/prompt.types';
import { editModeOf } from '../../common/greeting-session-edit';
import { findModerationFlags } from '../../common/text-moderation';
import { normalizeVoiceMode } from '../../common/voice-mode';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';
import { GREETING_PROMPT_IN_FLIGHT_MESSAGE } from '../greeting-prompt/greeting-prompt.service';
import {
  GREETING_PROMPT_LOCK_TTL_MS,
  editDuringRender,
  greetingScriptInputs,
  greetingScriptStale,
} from '../greeting-prompt/script-inputs';
import { composeEditedPrompt } from './greeting-session-edit.service';
import {
  GreetingSnapshotDb,
  MAX_SNAPSHOT_WRITE_ATTEMPTS,
  applyGreetingSnapshotChange,
  diffGreetingSnapshot,
  greetingSnapshotBusy,
} from '../../common/greeting-snapshot-write';

/**
 * Сценарий под новые входы или `null` — перештамповка не нужна или не
 * положена (см. доккомментарий файла). `before` — сессия до смены,
 * `after` — с применённой сменой.
 */
export function restampedGreetingPrompt(
  before: Session,
  after: Session,
): GenerationPrompt | null {
  const prev = after.generationPrompt;
  const brief = after.greetingBriefSnapshot;
  if (!prev || !brief || !prev.greetingScriptInputs) return null;
  if (editModeOf(after.generatedVideo) !== 'in-place') return null;
  // Устаревший до смены — остаётся устаревшим: чинить его молча нельзя.
  if (greetingScriptStale(prev, before)) return null;
  if (!greetingScriptStale(prev, after)) return null;
  const speech = prev.finalVoiceoverScript?.trim();
  if (!speech) return null;
  const composed = composeEditedPrompt(
    prev,
    brief,
    speech,
    after.greetingReferenceImages ?? [],
    normalizeVoiceMode(after.brandManifestSnapshot?.voiceMode),
    (text) => {
      const flags = findModerationFlags(text);
      return {
        status: flags.length
          ? ModerationStatus.FLAGGED
          : ModerationStatus.APPROVED,
        flags,
      };
    },
    after.brandManifestSnapshot ?? null,
  );
  return {
    ...composed,
    // Текст реплики не менялся — поля озвучки остаются как были, а
    // «правлено человеком» сцена только если была такой и раньше.
    generatedText: prev.generatedText,
    userEditedText:
      prev.userEditedText !== undefined ? composed.finalText : undefined,
    voiceoverScript: prev.voiceoverScript,
    voiceoverScriptEdited: prev.voiceoverScriptEdited,
    greetingScriptInputs: greetingScriptInputs(after),
  };
}

/**
 * Запись смены голоса/режима озвучки под замком 'prompt' — тем же, что у
 * правки брифа, сборки сценария и старта ролика. Смена строится по
 * сессии, перечитанной под замком (`buildPatch`), и вместе с ней, одной
 * записью, уходит перештампованный сценарий, если он положен.
 *
 * Снимок брифа (если правка его меняет) пишется точечно через
 * `greeting-snapshot-write` с CAS по всему снимку и до
 * `MAX_SNAPSHOT_WRITE_ATTEMPTS` пересчётов (C2).
 */
export async function writeWithGreetingRestamp(
  sessions: Pick<
    SessionService,
    'claimWork' | 'releaseWork' | 'getSession' | 'updateSession'
  >,
  sessionId: string,
  buildPatch: (fresh: Session) => Partial<Session> | Promise<Partial<Session>>,
  /** Обязателен, если правка пишет `greetingBriefSnapshot` (C2). */
  db?: GreetingSnapshotDb,
): Promise<Session> {
  const claimed = await sessions.claimWork(
    sessionId,
    'prompt',
    GREETING_PROMPT_LOCK_TTL_MS,
  );
  if (!claimed) {
    throw new ConflictException(
      greetingError(
        GREETING_ERROR_CODES.GREETING_EDIT_IN_PROGRESS,
        GREETING_PROMPT_IN_FLIGHT_MESSAGE,
      ),
    );
  }
  try {
    for (let attempt = 1; ; attempt++) {
      const fresh = await sessions.getSession(sessionId);
      if (!fresh) throw new NotFoundException(SESSION_NOT_FOUND);
      if (editModeOf(fresh.generatedVideo) === 'busy') {
        throw editDuringRender();
      }
      const patch = await buildPatch(fresh);
      const restamped = restampedGreetingPrompt(fresh, {
        ...fresh,
        ...patch,
      } as Session);
      const full = restamped
        ? { ...patch, generationPrompt: restamped }
        : patch;
      if (!('greetingBriefSnapshot' in full)) {
        const updated = await sessions.updateSession(sessionId, full);
        return (updated ?? { ...fresh, ...full }) as Session;
      }
      // C2: замок 'prompt' разводит голос с правкой брифа и сборкой, но
      // наклейка, музыка, сцены и карточки пишут снимок без него. Поэтому
      // снимок пишется только изменёнными ключами, а CAS — по снимку
      // целиком: смена голоса и перештамповка решены по всему снимку, и
      // если его успели тронуть — решаем заново по свежему.
      if (!db || !fresh.greetingBriefSnapshot) {
        throw new Error('запись снимка поздравления требует db и снимок');
      }
      const { greetingBriefSnapshot: nextSnapshot, ...rest } = full;
      const written = await applyGreetingSnapshotChange(
        db,
        sessionId,
        fresh.greetingBriefSnapshot,
        {
          set: diffGreetingSnapshot(fresh.greetingBriefSnapshot, nextSnapshot!),
          expect: 'all',
          data: rest,
        },
      );
      if (written) {
        return { ...fresh, ...rest, greetingBriefSnapshot: written } as Session;
      }
      if (attempt >= MAX_SNAPSHOT_WRITE_ATTEMPTS) throw greetingSnapshotBusy();
    }
  } finally {
    await sessions.releaseWork(sessionId, 'prompt');
  }
}
