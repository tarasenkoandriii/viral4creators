import {
  storyAudioReservation,
  STORY_SPEECH_CHARS_PER_SECOND,
} from './story-budget';
import { storyVideoReserve } from './story-video-plan';
import { storyVideoBaseFor } from './story-video-base';
import type { StoryEdition } from './story-editions';
import type { StoryReferenceAssessment } from './story-references.service';

/** Longest preamble the wizard accepts — used for a conservative reserve. */
export const STORY_PLAN_PREAMBLE_MAX = 180;

export interface StoryReferencePlanLine {
  key: 'narration' | 'assembly' | 'illustrations' | 'animation';
  label: string;
  microUsd: number;
  note: string;
}
export interface StoryReferencePlannedScene {
  index: number;
  kind: 'preamble' | 'story';
  /** Timecodes in OUR video, seconds (estimate until narration is synthesized). */
  start: number;
  end: number;
  /** Reference scene that inspired the staging (only for story scenes). */
  reference: { start: number; end: number; confidence: string } | null;
  chapterIndex: number | null;
  chapterTitle: string;
  staging: string;
}
export interface StoryReferencePlan {
  referenceId: string;
  editionId: string;
  editionKind: StoryEdition['kind'];
  editionTitle: string;
  textSha256: string;
  baseRevision: string | null;
  introSeconds: number;
  narrationSeconds: number;
  scenes: StoryReferencePlannedScene[];
  lines: StoryReferencePlanLine[];
  totalMicroUsd: number;
  totalUsd: number;
  budgetUsd: number;
  fits: boolean;
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Own staging plan inside the budget (spec §23.5 «Выход»): reference scene
 * timecodes → proportional scenes of OUR approved edition, priced with the
 * existing conservative reserves (no provider call, no new prices).
 *
 * The reference only lends rhythm and staging ideas. Text is always the
 * registered edition; foreign frames, music and voice are never reused.
 */
export function planStoryReferenceProduction(input: {
  reference: {
    id: string;
    durationSeconds: number;
    assessment: StoryReferenceAssessment;
  };
  edition: StoryEdition;
  budgetUsd: number;
  preambleText?: string;
}): StoryReferencePlan {
  const { reference, edition } = input;
  const assessment = reference.assessment;
  if (!assessment.observed || !assessment.scenes.length)
    throw new Error('Reference has no observed scenes');
  if (
    !Number.isFinite(input.budgetUsd) ||
    input.budgetUsd < 1 ||
    input.budgetUsd > 1000
  )
    throw new Error('Invalid budget');
  const preamble = (input.preambleText ?? '').trim();
  if (preamble.length > STORY_PLAN_PREAMBLE_MAX)
    throw new Error('Preamble too long');
  const warnings: string[] = [];
  const duration = Math.max(
    reference.durationSeconds,
    ...assessment.scenes.map((s) => s.end),
  );
  // Preamble length unknown → reserve for the longest allowed one.
  const reservePreamble = preamble || 'x'.repeat(STORY_PLAN_PREAMBLE_MAX);
  const introSeconds = round2(
    Math.min(
      20,
      Math.max(1, reservePreamble.length / STORY_SPEECH_CHARS_PER_SECOND),
    ),
  );
  const narrationSeconds = edition.targetSeconds;
  const lengths = edition.chapters.map((c) => c.text.length);
  const totalChars = lengths.reduce((a, b) => a + b, 0) || 1;
  const chapterAt = (fraction: number) => {
    let acc = 0;
    for (let i = 0; i < lengths.length; i++) {
      acc += lengths[i] / totalChars;
      if (fraction < acc || i === lengths.length - 1) return i;
    }
    return lengths.length - 1;
  };
  const scenes: StoryReferencePlannedScene[] = [
    {
      index: 0,
      kind: 'preamble',
      start: 0,
      end: introSeconds,
      reference: null,
      chapterIndex: null,
      chapterTitle: 'Персональная преамбула',
      staging:
        'Статичная обложка и голос выбранного рассказчика; текст преамбулы виден до синтеза.',
    },
  ];
  const ordered = [...assessment.scenes].sort((a, b) => a.start - b.start);
  ordered.forEach((s, i) => {
    const from = s.start / duration;
    const to = s.end / duration;
    const chapterIndex = chapterAt((from + to) / 2);
    scenes.push({
      index: i + 1,
      kind: 'story',
      start: round2(introSeconds + from * narrationSeconds),
      end: round2(introSeconds + to * narrationSeconds),
      reference: { start: s.start, end: s.end, confidence: s.confidence },
      chapterIndex,
      chapterTitle: edition.chapters[chapterIndex].title,
      staging: s.observation,
    });
  });
  if (ordered.some((s) => s.confidence === 'low'))
    warnings.push(
      'Часть сцен референса с низкой уверенностью модели — сверьте таймкоды при просмотре.',
    );
  if (assessment.timelineWarnings)
    warnings.push(
      'Разбор частичный: пересечения/отброшенные сегменты перенесены в план без исправления.',
    );
  if (!assessment.audioObserved)
    warnings.push(
      'Звук референса не подтверждён: темп и паузы оценены только по изображению.',
    );
  // Registry of published packages per edition (WP4), bound to the text hash.
  const published = storyVideoBaseFor(edition.id);
  const base =
    published && published.textSha256 === edition.textSha256 ? published : null;
  const hasMaster = !!base;
  if (!base)
    warnings.push(
      published
        ? 'Опубликованный базовый видеоряд собран для другой версии текста этой редакции: план без базового видео. До выпуска совместимого пакета — аудио с иллюстрациями.'
        : 'Для этой редакции нет базового видеоряда: план без базового видео. До выпуска пакета этой редакции — аудио с иллюстрациями.',
    );
  if (edition.kind === 'adaptation')
    warnings.push(
      'Выбрана адаптация, а не точная классика: отличия от источника показываются взрослому до синтеза.',
    );
  // Same narrated string as storyText()/create(): title + chapter texts.
  const narration = storyAudioReservation(
    `${edition.title}.\n\n${edition.chapters.map((c) => c.text).join('\n\n')}`,
  );
  const assembly = storyVideoReserve(reservePreamble);
  const lines: StoryReferencePlanLine[] = [
    {
      key: 'narration',
      label: 'Озвучка точного текста редакции и проверка речи',
      microUsd: narration,
      note: 'Резерв ×4 к внутренней ставке TTS + одна проверка Soniox; голос по умолчанию — Nova.',
    },
    {
      key: 'assembly',
      label: 'Преамбула, сборка MP4 и проверка видео',
      microUsd: assembly,
      note: preamble
        ? 'Резерв по фактическому тексту преамбулы.'
        : `Резерв на преамбулу максимальной длины (${STORY_PLAN_PREAMBLE_MAX} символов).`,
    },
    {
      key: 'illustrations',
      label: 'Иллюстрации и видеоряд',
      microUsd: 0,
      note: hasMaster
        ? `Переиспользуется собственный мастер ${base.revision}; кадры референса не копируются.`
        : 'Нужен собственный векторный мастер (локальная работа, без платной модели изображений).',
    },
    {
      key: 'animation',
      label: 'Анимация рассказчика',
      microUsd: 0,
      note: 'Не входит в план: платная анимация выключена, движение — собственные иллюстрации.',
    },
  ];
  const totalMicroUsd = lines.reduce((a, l) => a + l.microUsd, 0);
  const fits = totalMicroUsd <= Math.round(input.budgetUsd * 1e6);
  if (!fits)
    warnings.push(
      'Резерв превышает бюджет: увеличьте бюджет или выберите более короткую редакцию. Превышение не допускается.',
    );
  return {
    referenceId: reference.id,
    editionId: edition.id,
    editionKind: edition.kind,
    editionTitle: edition.title,
    textSha256: edition.textSha256,
    baseRevision: base?.revision ?? null,
    introSeconds,
    narrationSeconds,
    scenes,
    lines,
    totalMicroUsd,
    totalUsd: Math.ceil(totalMicroUsd / 10_000) / 100,
    budgetUsd: input.budgetUsd,
    fits,
    warnings,
  };
}
