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
 *
 * ## Обе темы одним запросом (заход 3 «Актуального демо», 06.10.2026)
 *
 * Светлый и тёмный ролики — отдельные ролики пары, и лендинг со
 * светлой/тёмной страницей должен уметь переключать плеер без второго
 * запроса. Поэтому, кроме верхних полей (как раньше: ролик по `?theme=`
 * или самый свежий), ответ несёт `variants` — по одобренному ролику на
 * каждую тему, у которой он есть. Темы без одобренного ролика в
 * `variants` нет вовсе (не `null`): «ключ есть» значит «можно играть».
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
  /**
   * Одобренный ролик КАЖДОЙ темы — у которой он есть. Верхние поля
   * ответа — один из них (по `?theme=`) или самый свежий; здесь — оба,
   * чтобы лендинг переключал тему без второго запроса.
   */
  variants: Partial<Record<TutorialHelpTheme, TutorialHelpVariant>>;
}

/** Ролик одной темы — без `theme` (она в ключе) и без текста справки. */
export interface TutorialHelpVariant {
  videoUrl: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  capturedAt: string | null;
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

/** Размер холста — парой или никак: половины пары не бывает. */
function canvas(asset: HelpAssetRow | null): {
  width: number | null;
  height: number | null;
} {
  const width = pixels(asset?.width);
  const height = pixels(asset?.height);
  return width !== null && height !== null
    ? { width, height }
    : { width: null, height: null };
}

/** Строка базы → ролик темы; без ссылки или ЧУЖОЙ темы — не ролик
 *  этой темы (вторая проверка поверх фильтра запроса: ключ `variants`
 *  обещает тему, и обещание держится в коде, а не только в `where`).
 *  Набор полей — ровно `TutorialHelpVariant`, ничего сверх. */
function toVariant(
  asset: HelpAssetRow | null,
  theme: TutorialHelpTheme,
): TutorialHelpVariant | null {
  const videoUrl = asset?.blobUrl ?? asset?.externalUrl ?? null;
  if (!asset || !videoUrl || asset.theme !== theme) return null;
  return {
    videoUrl,
    posterUrl: asset.posterUrl ?? null,
    ...canvas(asset),
    durationMs: asset.durationMs ?? null,
    capturedAt: asset.capturedAt ? asset.capturedAt.toISOString() : null,
    captureBuild: asset.captureBuild ?? null,
  };
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
    // По одобренному ролику на тему — они же `variants` и они же
    // кандидаты в верхние поля по `?theme=`.
    const byTheme = await Promise.all(
      TUTORIAL_HELP_THEMES.map((theme) =>
        this.findApproved(subjectKey, locale, theme),
      ),
    );
    const variants: TutorialHelpView['variants'] = {};
    TUTORIAL_HELP_THEMES.forEach((theme, i) => {
      const variant = toVariant(byTheme[i], theme);
      if (variant) variants[theme] = variant;
    });
    // Верхние поля — как до `variants`: ролик заказанной темы, а нет
    // его — самый свежий одобренный ЛЮБОЙ темы (и без темы тоже: строка,
    // собранная до тем, — светлая, но могла остаться без отметки).
    const wantedRow =
      wanted && variants[wanted]
        ? byTheme[TUTORIAL_HELP_THEMES.indexOf(wanted)]
        : null;
    const asset =
      wantedRow ?? (await this.findApproved(subjectKey, locale, null));
    const { width, height } = canvas(asset);
    return {
      subjectKey,
      locale,
      title: topic.title,
      text: topic.text,
      // Своя ссылка важнее внешней: внешняя живёт у подрядчика сборки
      // и переживает нас не дольше договора с ним.
      videoUrl: asset?.blobUrl ?? asset?.externalUrl ?? null,
      durationMs: asset?.durationMs ?? null,
      width,
      height,
      posterUrl: asset?.posterUrl ?? null,
      theme: parseTutorialHelpTheme(asset?.theme),
      capturedAt: asset?.capturedAt ? asset.capturedAt.toISOString() : null,
      captureBuild: asset?.captureBuild ?? null,
      variants,
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
