import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  countPostprodVideoSummaries,
  PostprodVideoSummaryRow,
  selectPostprodVideoSummaries,
} from '../../common/postprod-video-summary';
import { isVoiceMode, VoiceMode } from '../../common/voice-mode';
import { revoiceBlock, RevoiceBlock } from '../../common/revoice-eligibility';

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
  /** `revoiceBlock === null` — то же правило, по которому отказывает
   * `PostProductionService.reVoice` (common/revoice-eligibility.ts). */
  canRevoice: boolean;
  /** Почему нельзя: фронтенду нужна причина, чтобы погасить кнопку с
   * объяснением, а не просто спрятать её (П-8). */
  revoiceBlock: RevoiceBlock | null;
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
        // Найдено доп. аудитом (MEDIUM): в отличие от session-summary.ts
        // и admin-generation-retry.controller.ts's `versions()`
        // (`provider: v.provider ?? 'veo'`), это единственное место в
        // проекте, где `provider` из БД отдавался как есть — Veo-путь
        // (`GenerationService`) вообще не пишет это поле, так что для
        // подавляющего большинства роликов оно `null`. Сейчас это
        // безобидно (см. её же доккомментарий — фронт это поле пока не
        // отрисовывает), но ловушка на будущее: подключить бейдж без
        // этого дефолта значит показать «неизвестно» вместо «Veo» почти
        // всегда.
        provider: row.provider ?? 'veo',
        resolution: row.resolution,
        ...this.revoiceFields(row),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Оба поля из одного вызова правила — чтобы `canRevoice` не мог
   * разойтись с причиной отказа. */
  private revoiceFields(
    row: Pick<
      PostprodVideoSummaryRow,
      'voiceMode' | 'hasBrandSnapshot' | 'hasGreetingSnapshot'
    >,
  ): Pick<PostprodVideoSummary, 'canRevoice' | 'revoiceBlock'> {
    const block = revoiceBlock({
      voiceMode: row.voiceMode,
      // `=== true`: драйвер отдаёт boolean, но строка из старой проекции
      // или мока без поля не должна читаться как «снимок есть».
      hasBrandSnapshot: row.hasBrandSnapshot === true,
      hasGreetingSnapshot: row.hasGreetingSnapshot === true,
    });
    return { canRevoice: block === null, revoiceBlock: block };
  }
}
