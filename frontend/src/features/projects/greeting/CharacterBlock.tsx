/**
 * Блок «Характер ролика» — пять карточек настройки (голос, музыка, титры,
 * наклейка, сцены) одной группой со сводкой сверху.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useMemo } from 'react';
import { useI18n } from '../../../lib/i18n-context';
import type { GreetingBriefView } from '../../../types/project';
import { useGreetingPolicy } from '../../../lib/useGreetingPolicy';
import { rulesOf } from '../../../lib/greeting-policy';
import {
  type CharacterSummary,
  type CharacterPart,
  characterRegister,
  characterSummaryLine,
} from '../../../lib/greeting-character';
import { SenderVoiceStep } from './SenderVoiceStep';
import { MusicThemeStep } from './MusicThemeStep';
import { CardsStep } from './CardsStep';
import { StickerStep } from './StickerStep';
import { ScenesStep } from './ScenesStep';

// ── Характер ролика: пять карточек одной группой (этап D, §3.3) ──────────

/**
 * Голос, музыка, титры, наклейка и сцены — одна группа «настройте
 * ролик»: у них и тема справки одна (`greeting-help.ts`). Сводка сверху
 * отвечает «что уже выбрано», не заставляя листать пять карточек.
 *
 * Карточки НЕ сворачиваются: их `data-qa` — хуки сценариев обучалки,
 * и хук, спрятанный за раскрытием, упал бы на `assertVisible`. Шагом
 * степпера блок тоже не становится — степпер остаётся из четырёх.
 *
 * Правила регистра (предупреждение о своей музыке) — по серверной
 * таблице `GET /greeting/policy`; не загрузилась — предупреждений нет,
 * своих правил интерфейс не выдумывает.
 */
export function CharacterBlock({
  sessionId,
  stepKey,
  brief,
}: {
  sessionId: string;
  /** Ключ пересоздания карточек: новая версия сессии — новое состояние. */
  stepKey: string;
  brief: Pick<GreetingBriefView, 'occasion' | 'occasionRegister'>;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  // Та же таблица, что у брифа, через общий хук: второй копии загрузки
  // (и второго толкования «не загрузилась») у экрана быть не должно.
  const policy = useGreetingPolicy();
  const [summary, setSummary] = useState<CharacterSummary>({});

  // Колбэки стабильны: карточки сообщают сводку из эффекта, и новая
  // функция на каждый рендер гоняла бы этот эффект впустую.
  const report = useMemo(() => {
    const one = (part: CharacterPart) => (value: string | null) =>
      setSummary((prev) =>
        prev[part] === value ? prev : { ...prev, [part]: value }
      );
    return {
      voice: one('voice'),
      music: one('music'),
      cards: one('cards'),
      sticker: one('sticker'),
      scenes: one('scenes'),
    };
  }, []);

  const rules = rulesOf(policy, characterRegister(policy, brief));
  const line = characterSummaryLine(summary, w);

  return (
    <section className="space-y-4" data-qa="greeting-character-block">
      <div>
        <h2 className="text-base font-semibold">{w.characterHeading}</h2>
        <p className="mt-0.5 text-xs text-silver-400">{w.characterHint}</p>
        {line && <p className="mt-2 text-sm">{line}</p>}
      </div>
      {/* Ключ у каждой карточки свой, с общим префиксом версии сессии:
          пять братьев с ОДНИМ ключом — это дубликат, на который React
          ругается и при смене версии может потерять или задвоить
          карточку, а её `data-qa` — хук сценария обучалки. */}
      <SenderVoiceStep
        key={`${stepKey}:voice`}
        sessionId={sessionId}
        onSummary={report.voice}
      />
      <MusicThemeStep
        key={`${stepKey}:music`}
        sessionId={sessionId}
        rules={rules}
        onSummary={report.music}
      />
      <CardsStep
        key={`${stepKey}:cards`}
        sessionId={sessionId}
        onSummary={report.cards}
      />
      <StickerStep
        key={`${stepKey}:sticker`}
        sessionId={sessionId}
        onSummary={report.sticker}
      />
      <ScenesStep
        key={`${stepKey}:scenes`}
        sessionId={sessionId}
        onSummary={report.scenes}
      />
    </section>
  );
}
