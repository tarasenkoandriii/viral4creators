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
}

@Injectable()
export class TutorialHelpService {
  constructor(private readonly prisma: PrismaService) {}

  async get(subjectKey: string, rawLocale?: string): Promise<TutorialHelpView> {
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
    const asset = (await this.prisma.tutorialVideoAsset.findFirst({
      where: {
        subjectKey,
        locale,
        reviewed: true,
        // Ролик без ссылки — это строка сборки, а не ролик.
        OR: [{ blobUrl: { not: null } }, { externalUrl: { not: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { blobUrl: true, externalUrl: true, durationMs: true },
    })) as {
      blobUrl: string | null;
      externalUrl: string | null;
      durationMs: number | null;
    } | null;
    return {
      subjectKey,
      locale,
      title: topic.title,
      text: topic.text,
      // Своя ссылка важнее внешней: внешняя живёт у подрядчика сборки
      // и переживает нас не дольше договора с ним.
      videoUrl: asset?.blobUrl ?? asset?.externalUrl ?? null,
      durationMs: asset?.durationMs ?? null,
    };
  }
}
