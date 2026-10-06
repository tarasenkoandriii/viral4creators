/**
 * Справка по теме мастера: текст всегда, ролик — если он есть и вычитан.
 *
 * ## Зачем отдельный сервис, а не поле в ответе мастера
 *
 * Спрашивают её РЕДКО и ПО ТРЕБОВАНИЮ — нажатием кнопки (i) или словом
 * «помощь». Класть текст и ссылку на ролик в каждый ответ мастера
 * значило бы возить их всем и всегда ради тех немногих, кто спросит.
 *
 * ## Почему текст отдаётся даже без ролика
 *
 * Человек нажал «помощь» — он не должен получить «ролик ещё не
 * собран». Текст темы есть всегда: он и так лежит в каталоге, из
 * которого собирается озвучка (`GREETING_TUTORIAL_TOPICS`, шаги
 * мастера товара — `ASSISTANT_STEPS`). Ролик — улучшение к нему, а не
 * условие.
 *
 * ## Почему только вычитанный ролик
 *
 * `reviewed` у актива означает «человек посмотрел и допустил»
 * (`tutorial-video-admin.service.ts`: «без `reviewed:true` собранное
 * видео физически недоступно никому, кроме админки»). Реплики пишет
 * модель, и невычитанный ролик — это текст модели, показанный
 * пользователю от имени продукта. Здесь это правило не ослабляется:
 * сервис фильтрует по `reviewed` сам, а не надеется, что вызывающий
 * помнит.
 *
 * ## Метаданные ролика
 *
 * Размер холста, постер, тема, время съёмки и версия интерфейса
 * (`width`/`height`/`posterUrl`/`theme`/`capturedAt`/`captureBuild`)
 * пишет исполнитель обучалки; здесь они только читаются. Лендинг по
 * размеру ставит пропорцию плеера до загрузки ролика, оператор по
 * времени и версии видит, не устарел ли он. Ничего сверх этих полей —
 * ни id строки, ни сценария, ни состояния сборки — наружу не уходит.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { tutorialStepFor } from '../tutorial-scenario/tutorial-locales';
import { DEFAULT_LOCALE, isSupportedLocale } from '../../common/locale';

export interface TutorialHelpView {
  subjectKey: string;
  locale: string;
  title: string;
  text: string;
  /** `null` — ролика пока нет или он не вычитан. Текст всё равно есть. */
  videoUrl: string | null;
  durationMs: number | null;
  /**
   * Размер холста ролика в пикселях — лендинг ставит пропорцию плеера
   * ДО загрузки видео (`preload="none"`: без этого сцена прыгала бы,
   * когда браузер узнаёт настоящий размер). Оба `null`, если ролика
   * нет или размер не записан; половины пары не бывает.
   */
  width: number | null;
  height: number | null;
  /** Первый кадр ролика в постоянном префиксе Blob; `null` — нет. */
  posterUrl: string | null;
  /** Тема интерфейса на съёмке: 'light' | 'dark'; `null` — не записана. */
  theme: TutorialHelpTheme | null;
  /** Когда сняты кадры (ISO-8601), не когда собран ролик. */
  capturedAt: string | null;
  /** Версия фронтенда на съёмке (`<meta name="app-build">`). */
  captureBuild: string | null;
}

export const TUTORIAL_HELP_THEMES = ['light', 'dark'] as const;
export type TutorialHelpTheme = (typeof TUTORIAL_HELP_THEMES)[number];

/** Тема из запроса или из строки базы — только из двух известных. */
export function parseTutorialHelpTheme(raw: unknown): TutorialHelpTheme | null {
  return typeof raw === 'string' &&
    (TUTORIAL_HELP_THEMES as readonly string[]).includes(raw)
    ? (raw as TutorialHelpTheme)
    : null;
}

/** Целое положительное число пикселей или `null`. Ноль, дробь и
 * мусор из базы не должны доехать до `aspect-ratio` лендинга. */
function pixels(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** Строки базы, нужные справке, — и ничего сверх них. */
const ASSET_SELECT = {
  blobUrl: true,
  externalUrl: true,
  durationMs: true,
  width: true,
  height: true,
  posterUrl: true,
  theme: true,
  capturedAt: true,
  captureBuild: true,
} as const;

interface HelpAssetRow {
  blobUrl: string | null;
  externalUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  posterUrl: string | null;
  theme: string | null;
  capturedAt: Date | null;
  captureBuild: string | null;
}

@Injectable()
export class TutorialHelpService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `theme` — пожелание, а не фильтр: есть одобренный ролик этой темы —
   * отдаётся он, нет — самый свежий одобренный любой темы. Справка без
   * ролика из-за того, что не та тема, хуже ролика не той темы.
   */
  async get(
    subjectKey: string,
    rawLocale?: string,
    rawTheme?: string,
  ): Promise<TutorialHelpView> {
    const locale = isSupportedLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
    const topic = tutorialStepFor(subjectKey, locale);
    if (!topic) {
      // 404 именно на ТЕМУ, а не пустой ответ: пустой ответ клиент
      // покажет как «справки нет», и опечатка в ключе будет выглядеть
      // как ненаписанная справка.
      throw new NotFoundException(
        `Справки по теме «${subjectKey}» нет: такой темы обучалки не существует.`,
      );
    }
    const wanted = parseTutorialHelpTheme(rawTheme);
    const asset =
      (wanted ? await this.findApproved(subjectKey, locale, wanted) : null) ??
      (await this.findApproved(subjectKey, locale, null));
    const width = pixels(asset?.width);
    const height = pixels(asset?.height);
    const sized = width !== null && height !== null;
    return {
      subjectKey,
      locale,
      title: topic.title,
      text: topic.text,
      // Своя ссылка важнее внешней: внешняя живёт у подрядчика сборки
      // и переживает нас не дольше договора с ним.
      videoUrl: asset?.blobUrl ?? asset?.externalUrl ?? null,
      durationMs: asset?.durationMs ?? null,
      width: sized ? width : null,
      height: sized ? height : null,
      posterUrl: asset?.posterUrl ?? null,
      theme: parseTutorialHelpTheme(asset?.theme),
      capturedAt: asset?.capturedAt ? asset.capturedAt.toISOString() : null,
      captureBuild: asset?.captureBuild ?? null,
    };
  }

  private async findApproved(
    subjectKey: string,
    locale: string,
    theme: TutorialHelpTheme | null,
  ): Promise<HelpAssetRow | null> {
    return (await this.prisma.tutorialVideoAsset.findFirst({
      where: {
        subjectKey,
        locale,
        reviewed: true,
        ...(theme ? { theme } : {}),
        // Ролик без ссылки — это строка сборки, а не ролик.
        OR: [{ blobUrl: { not: null } }, { externalUrl: { not: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: ASSET_SELECT,
    })) as HelpAssetRow | null;
  }
}
