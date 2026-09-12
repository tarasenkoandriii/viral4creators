/**
 * AdminGenerationRetryController — операторские действия над готовым/
 * проваленным роликом прямо из админки, минуя `SessionOwnerGuard`.
 *
 * Изначально «Рендер не удался — попробовать ещё раз» (доп. запрос
 * владельца продукта: причина провала и кнопка повтора в списке
 * сессий), затем сюда же добавлена «Проверить на артефакты» (тот же
 * запрос: аудит должен быть виден и клиенту).
 *
 * ## Почему прокси, а не прямой вызов публичного `/sessions/:id/...`
 *
 * Первая версия кнопки аудита звала ровно тот же публичный маршрут
 * (`POST /sessions/:sessionId/audit`), которым пользуется визард —
 * логика была «раз оба пишут в одну и ту же `Session.data`, результат
 * и так увидит клиент». Это сломалось на первой же сессии с реальным
 * (не анонимным) владельцем: `SessionOwnerGuard` — глобальный гвард,
 * требующий, чтобы запрос к сессии С ВЛАДЕЛЬЦЕМ пришёл от его же
 * Telegram-личности (`req.telegramUserId`, из initData) — у браузера
 * оператора её нет и быть не может, поэтому гвард стабильно отвечал
 * `FOREIGN_SESSION_MESSAGE` («сессия принадлежит другому аккаунту»).
 * Спасало это только сессии анонимных гостей (`userId === null`).
 *
 * Гвард сам объясняет, почему `/admin/*` его не касается: параметр
 * маршрута там называется `id`, а не `sessionId` — `sessionIdFromRequest`
 * не находит его и гвард молча пропускает запрос. Отсюда правило этого
 * контроллера: КАЖДОЕ действие оператора над сессией — маршрут вида
 * `/admin/sessions/:id/...`, вызывающий нужный сервис (`GenerationService`,
 * `VideoAuditService`) НАПРЯМУЮ, в обход HTTP-уровня публичного
 * `/sessions/:sessionId/...` и его гварда. Сами проверки владельца
 * сессии (тариф/бюджет/блокировка) при этом никуда не деваются — они
 * живут внутри вызываемого сервиса и по-прежнему считаются по
 * ВЛАДЕЛЬЦУ сессии, не по оператору (см. `retry` ниже).
 *
 * Живёт В GenerationModule, а не в admin-panel — единственная причина
 * чисто техническая: `AdminPanelModule` не может импортировать
 * `GenerationModule` напрямую — тот тянет `SharedVideoModule`, а она
 * сама импортирует `AdminPanelModule` (ради `AdminSharedVideoController`)
 * — обратный импорт замкнул бы цикл AdminPanelModule → GenerationModule
 * → SharedVideoModule → AdminPanelModule. Тот же самый прецедент уже
 * решён в проекте односторонне: admin-контроллер конкретной фичи живёт
 * в модуле этой фичи и импортирует `AdminPanelModule` сам (см.
 * `AdminSharedVideoController` в `shared-video.module.ts`) — этот
 * контроллер следует тому же правилу. `VideoAuditModule` добавлен той
 * же логикой — он тянет только `StorageModule`, цикла не создаёт.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { GenerationService } from './generation.service';
import { VideoAuditService } from '../video-audit/video-audit.service';
import { PromptService } from '../prompt/prompt.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GeneratedVideo,
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';
import { VideoAudit } from '../../common/types/audit.types';

@Controller('admin/sessions')
@UseGuards(AdminSessionGuard)
export class AdminGenerationRetryController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly generation: GenerationService,
    private readonly videoAudit: VideoAuditService,
    private readonly prompt: PromptService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':id/retry')
  async retry(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);

    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    const data = (row.data as Record<string, unknown>) ?? {};
    const generatedVideo = data.generatedVideo as
      | { quality?: VideoQuality; aspectRatio?: string; status?: string }
      | undefined;
    // Качество/формат — те, что были в упавшей попытке, а не по
    // умолчанию: повтор должен воспроизводить тот же рендер, а не тихо
    // подменять его настройки.
    if (generatedVideo?.status !== GenerationStatus.FAILED) {
      throw new ForbiddenException(
        `Сессия ${id}: повтор доступен только для проваленного рендера (сейчас: ${generatedVideo?.status ?? 'рендера не было'})`,
      );
    }
    await this.generation.generateVideo(
      id,
      generatedVideo.quality,
      generatedVideo.aspectRatio,
    );
    return this.adminPanel.getSession(id);
  }

  /**
   * Опрос статуса из админки — без него запущенный отсюда рендер
   * никогда не сдвинется дальше 'processing': обычно статус
   * продвигает опрос клиентского визарда пользователя
   * (`GET /sessions/:id/generate`, каждые 4 с), а у оператора,
   * запустившего повтор ЗА пользователя, своего клиента для этого нет.
   * Зовёт ту же `GenerationService.getVideoStatus`, что и обычный
   * визард — она и только она умеет забрать готовый файл у Veo,
   * положить в Blob и пометить сессию завершённой/упавшей; простое
   * чтение строки (`AdminPanelService.getSession`) само по себе ничего
   * не продвигает. Список сессий в админке зовёт этот маршрут по
   * таймеру, пока статус 'pending'/'processing'.
   */
  @Get(':id/status')
  async pollStatus(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.generation.getVideoStatus(id);
    return this.adminPanel.getSession(id);
  }

  /**
   * «Проверить на артефакты», но из админки — доп. запрос владельца
   * продукта, с явным условием: результат должен быть виден и клиенту.
   * Он и виден — `VideoAuditService.run()` пишет в ту же
   * `Session.data.videoAudit`, которую читает собственный визард
   * пользователя (`GET /sessions/:id/audit`); отдельной синхронизации
   * не потребовалось. Пустой DTO — тот же путь, что у обычной
   * автоматической проверки (не «пользователь сам описал баг»).
   */
  @Post(':id/audit')
  async audit(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.videoAudit.run(id, {});
  }

  /**
   * «Виправити і перегенерувати» — доп. запрос владельца продукта после
   * реального случая: аудит нашёл артефакты (пролив пива, битый
   * текстовый оверлей, лишний звук, обрыв в конце), и простое
   * «Повторить» с ТЕМ ЖЕ промптом просто воспроизвело бы их снова.
   *
   * Три шага одним кликом — то же, что пользователь сделал бы сам через
   * визард (§11.2: правка ложится в PromptEditor как черновик, «Применить»
   * → одобрение → генерация), но за него:
   *  1. `VideoAuditService.applyFix` — текст последнего аудита с
   *     `promptFix` становится черновиком промпта; это ЖЕ действие
   *     сбрасывает `approvedAt` (тот же путь, что ручная правка текста
   *     пользователем) — без шага 2 `generateVideo` откажет с «промпт не
   *     одобрен».
   *  2. `PromptService.approvePrompt` — за пользователя одобряет
   *     применённый черновик; это ЕДИНСТВЕННОЕ место во всём контроллере,
   *     где оператор решает ЗА владельца сессии, а не просто повторяет
   *     его же действие — обосновано тем, что чинить конкретно эти
   *     артефакты и так его работа (найдены его же аудитом), а держать
   *     ролик сломанным в ожидании, что автор зайдёт и нажмёт
   *     «одобрить» сам, хуже.
   *  3. `GenerationService.generateVideo` — тот же платный повтор, что и
   *     `retry()` выше, с теми же качеством/форматом.
   */
  @Post(':id/apply-fix-and-retry')
  async applyFixAndRetry(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);

    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    const data = (row.data as Record<string, unknown>) ?? {};
    const videoAuditState = data.videoAudit as
      | { history?: Array<{ auditId: string; promptFix?: unknown }> }
      | undefined;
    // Newest first (см. VideoAuditState) — последний прогон, не первый.
    const latestAudit = videoAuditState?.history?.[0];
    if (!latestAudit?.promptFix) {
      throw new ForbiddenException(
        `Сессия ${id}: нет свежего аудита с предложенным исправлением — сначала запустите проверку на артефакты`,
      );
    }

    await this.videoAudit.applyFix(id, { auditId: latestAudit.auditId });
    await this.prompt.approvePrompt(id);

    const generatedVideo = data.generatedVideo as
      | { quality?: VideoQuality; aspectRatio?: string }
      | undefined;
    await this.generation.generateVideo(
      id,
      generatedVideo?.quality,
      generatedVideo?.aspectRatio,
    );
    return this.adminPanel.getSession(id);
  }

  /**
   * Полная история версий (доп. запрос владельца продукта: «должно
   * быть несколько кнопок для каждой версии») — до этого каждая
   * попытка молча перезаписывала файл предыдущей в Blob по
   * фиксированному пути; посмотреть старую версию было физически
   * нечем (см. доккомментарий `pathname` в generation.service.ts).
   * Каждая версия — с её собственными аудитами (сверка по
   * `generatedVideoId`, который `VideoAuditService` пишет в каждую
   * запись истории уже сейчас, без доп. правок).
   */
  @Get(':id/versions')
  async versions(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<VideoVersionView[]> {
    await this.adminPanel.assertOperator(req.userId);

    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }
    const data = (row.data as Record<string, unknown>) ?? {};
    const current = data.generatedVideo as GeneratedVideo | undefined;
    const history = (data.videoHistory as GeneratedVideo[] | undefined) ?? [];
    const audits =
      (data.videoAudit as { history?: VideoAudit[] } | undefined)?.history ??
      [];

    const versions: Array<GeneratedVideo & { isCurrent: boolean }> = [
      ...(current ? [{ ...current, isCurrent: true }] : []),
      ...history.map((v) => ({ ...v, isCurrent: false })),
    ];

    return versions.map((v) => ({
      generatedVideoId: v.generatedVideoId,
      status: v.status,
      downloadUrl: v.downloadUrl ?? null,
      quality: v.quality ?? null,
      aspectRatio: v.aspectRatio ?? null,
      initiatedAt: v.initiatedAt,
      completedAt: v.completedAt ?? null,
      isCurrent: v.isCurrent,
      audits: audits
        .filter((a) => a.generatedVideoId === v.generatedVideoId)
        .map((a) => ({
          auditId: a.auditId,
          verdict: a.verdict,
          summary: a.summary,
          hasPromptFix: a.promptFix != null,
        })),
    }));
  }
}

export interface VideoVersionAuditView {
  auditId: string;
  verdict: 'clean' | 'issues' | 'unknown';
  summary: string;
  hasPromptFix: boolean;
}

export interface VideoVersionView {
  generatedVideoId: string;
  status: string;
  downloadUrl: string | null;
  quality: string | null;
  aspectRatio: string | null;
  initiatedAt: unknown;
  completedAt: unknown;
  /** Действующая (последняя) попытка — `session.generatedVideo`, а не
   * архивная запись в `videoHistory`. */
  isCurrent: boolean;
  audits: VideoVersionAuditView[];
}
