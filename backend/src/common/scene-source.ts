/**
 * Откуда промпт берёт описание сцены (этап 152).
 *
 * ## Зачем отдельный модуль
 *
 * У промпта два входа: разбор чужого ролика или готовый приём (этап
 * 149, TODO §III п.11). Подменять один другим нужно НЕ в одном месте, а
 * в четырёх: текст описания, вводная строка, естественная ориентация
 * кадра и блок «какие сцены оставить». Этап 149 правил их по одной — и
 * аудит нашёл пропущенную четвёртую (`PICTURE FORMAT: the reference
 * is …`): та же неправда, сказанная модели третий раз, в единственном
 * месте, где её не поискали.
 *
 * А точек сборки промпта в сервисе ДВЕ — обычная и A/B-варианты, — и
 * каждая новая означала бы ещё четыре места, где можно забыть одно.
 * Поэтому решение одно и здесь: чистая функция, которую обе точки
 * зовут целиком.
 */

import {
  SceneTemplateSpec,
  sceneTemplate,
  templateBreakdown,
  templateFraming,
  usesTemplate,
} from './scene-templates';

export interface SceneSourceInput {
  videoAnalysis?: {
    status?: string;
    sceneBreakdown?: string;
    userEdits?: string;
  } | null;
  sceneTemplate?: { templateId?: string } | null;
  originalVideo?: { frame?: { aspectRatio?: string } | null } | null;
}

export interface SceneSource {
  /** Текст, занимающий в промпте место разбора. */
  text: string;
  /** Строка, которой промпт представляет этот текст модели. */
  framing: string;
  /**
   * Формат кадра. У приёма — его собственная ориентация: пустое
   * значение здесь не «нет данных», а тихая порча, потому что
   * `cameraBriefText` считает неизвестный формат неродным и срезает
   * амплитуду наезда вдвое.
   */
  frame: string | undefined;
  /** Собрано по приёму. Сцены и массовка разбора при этом неприменимы. */
  fromTemplate: boolean;
  /** Сам приём — когда он и есть источник. */
  spec: SceneTemplateSpec | null;
}

/** Вводная строка для разбора — ровно та, что стояла в промпте до этапа 149. */
export const ANALYSIS_FRAMING =
  'Below is a detailed description of an existing viral UGC video which includes scene breakdown and Dialogue/voiceover.';

/**
 * Есть ли у сессии источник сцены вообще. Барьеры обеих точек сборки
 * спрашивают именно это, а не «есть ли разбор».
 */
export function hasSceneSource(input: SceneSourceInput): boolean {
  const status = input.videoAnalysis?.status;
  return (
    !!input.videoAnalysis ||
    usesTemplate(status, input.sceneTemplate?.templateId)
  );
}

export function sceneSource(input: SceneSourceInput): SceneSource {
  const templateId = input.sceneTemplate?.templateId;
  if (usesTemplate(input.videoAnalysis?.status, templateId)) {
    const spec = sceneTemplate(templateId);
    return {
      text: templateBreakdown(spec),
      framing: templateFraming(),
      frame: spec.frame,
      fromTemplate: true,
      spec,
    };
  }
  return {
    text:
      input.videoAnalysis?.userEdits ||
      input.videoAnalysis?.sceneBreakdown ||
      '',
    framing: ANALYSIS_FRAMING,
    frame: input.originalVideo?.frame?.aspectRatio,
    fromTemplate: false,
    spec: null,
  };
}
