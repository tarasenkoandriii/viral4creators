import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  countPostprodVideoSummaries,
  selectPostprodVideoSummaries,
} from '../../common/postprod-video-summary';
import { isVoiceMode, usesOwnVoice, VoiceMode } from '../../common/voice-mode';

export interface PostprodVideoSummary {
  sessionId: string;
  createdAt: string;
  productName: string | null;
  generatedVideoId: string | null;
  downloadUrl: string | null;
  renderedUrl: string | null;
  postStatus: 'pending' | 'complete' | 'failed' | 'skipped' | null;
  voiceMode: VoiceMode | null;
  aspectRatio: string | null;
  quality: string | null;
  provider: string | null;
  resolution: string | null;
  /** У Veo-озвучки своей звуковой дорожки нет — переозвучить нечего
   * (то же условие, что `RevoicePanel`/`PostProductionService.reVoice`
   * проверяют на конкретном ролике, см. их доккомментарии). */
  canRevoice: boolean;
}

export interface PostprodVideoListResult {
  items: PostprodVideoSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Список «моих готовых роликов» для вкладки «Постпрод» (этап 88). Отдаёт
 * ВСЕ завершённые ролики пользователя — экспорт/публикация/шаринг
 * применимы к любому из них независимо от режима озвучки, поэтому список
 * не фильтруется по `canRevoice`, только помечает им каждую строку.
 */
@Injectable()
export class PostprodVideosService {
  constructor(private readonly prisma: PrismaService) {}

  async listFinishedVideos(
    userId: string,
    page: number,
    pageSize: number,
    // `offset` (найдено доп. аудитом, HIGH) — явный сдвиг для «Показать
    // ещё» вместо расчёта `(page - 1) * pageSize`: PostprodScreen.tsx
    // удаляет строку локально сразу после успешного DELETE, не
    // перезагружая список — а `total`/фактически загруженное количество
    // после этого меньше, чем `page * pageSize`. Номинальный расчёт по
    // page тянул бы следующую порцию С ПРОБЕЛОМ на границе страниц —
    // один ролик молча пропадал бы из списка (не 404, не ошибка — просто
    // никогда не показывался). Когда offset не передан (первая загрузка
    // страницы, `PostprodScreen`'а начальный useAsync-вызов) — старый
    // расчёт по page как раньше.
    offset?: number,
  ): Promise<PostprodVideoListResult> {
    const skip = offset ?? (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      selectPostprodVideoSummaries(this.prisma, userId, skip, pageSize),
      countPostprodVideoSummaries(this.prisma, userId),
    ]);
    return {
      items: rows.map((row) => ({
        sessionId: row.sessionId,
        createdAt: row.createdAt.toISOString(),
        productName: row.productName,
        generatedVideoId: row.generatedVideoId,
        downloadUrl: row.downloadUrl,
        renderedUrl: row.renderedUrl,
        postStatus: row.postStatus as PostprodVideoSummary['postStatus'],
        voiceMode: isVoiceMode(row.voiceMode) ? row.voiceMode : null,
        aspectRatio: row.aspectRatio,
        quality: row.quality,
        provider: row.provider,
        resolution: row.resolution,
        canRevoice: isVoiceMode(row.voiceMode) && usesOwnVoice(row.voiceMode),
      })),
      total,
      page,
      pageSize,
    };
  }
}
