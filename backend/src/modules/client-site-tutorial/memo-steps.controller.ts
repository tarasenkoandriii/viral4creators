/**
 * Э6-тер (к): шаги одобренной обучалки для черновика мемо помощника (ТЗ
 * помощника §5-бис.17 п.6). Зовёт ТОЛЬКО sites-backend
 * (`assist-site-voice-control/cabinet/generator-memo-steps.client.ts`), когда
 * владелец/менеджер помощника нажал в TMA «Из обучалки → создать черновик».
 *
 *   GET /api/internal/client-site-tutorial/memo-steps/:siteId/:draftId
 *       → { draftId, siteId, title, host, startPath, endPath, view,
 *           requiresLogin, steps[], dropped }
 *
 * Подпись — `SitesMemoHmacGuard` (вызывающий `sites-memo`, секрет
 * `SITES_TUTORIAL_HMAC_SECRET`). Отказы — машинным кодом:
 *   404 MEMO_STEPS_NOT_FOUND    нет черновика, он не этого сайта (одним кодом)
 *   422 MEMO_STEPS_NOT_ELIGIBLE `reason`: not_approved | mode_b | no_steps
 * Что уходит и что нет — шапка `memo-steps-export.ts`.
 */
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesMemoHmacGuard } from '../sites-internal/sites-memo-hmac.guard';
import {
  exportMemoSteps,
  type MemoExportDraft,
  type MemoStepsExport,
} from './memo-steps-export';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const notFound = () =>
  new HttpException(
    {
      error: 'MEMO_STEPS_NOT_FOUND',
      code: 'MEMO_STEPS_NOT_FOUND',
      message: 'Обучалка этого сайта не найдена',
    },
    HttpStatus.NOT_FOUND,
  );

@Controller('internal/client-site-tutorial')
@UseGuards(SitesMemoHmacGuard)
export class MemoStepsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('memo-steps/:siteId/:draftId')
  async memoSteps(
    @Param('siteId') siteId: string,
    @Param('draftId') draftId: string,
  ): Promise<MemoStepsExport> {
    if (!ID.test(siteId) || !ID.test(draftId)) throw notFound();
    const draft = (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { id: draftId },
      select: {
        id: true,
        status: true,
        siteMode: true,
        clientSiteId: true,
        baseUrl: true,
        lastUrl: true,
        steps: true,
        stepsPerRound: true,
        title: true,
        loginUsedAt: true,
        requiresLiveLoginReplay: true,
        storeHasCredentials: true,
        // Признак «данные входа есть» — только на пустоту (не читаются).
        credentialsEnc: true,
      },
    })) as MemoExportDraft | null;
    const r = exportMemoSteps(draft, siteId);
    if (r.ok) return r.value;
    if (r.reason === 'not_found') throw notFound();
    throw new HttpException(
      {
        error: 'MEMO_STEPS_NOT_ELIGIBLE',
        code: 'MEMO_STEPS_NOT_ELIGIBLE',
        reason: r.reason,
        message:
          r.reason === 'mode_b'
            ? 'Обучалка снята на неподтверждённом сайте (режим B) — не источник мемо'
            : r.reason === 'not_approved'
              ? 'Обучалка ещё не одобрена'
              : 'В обучалке нет шагов для мемо (после входа ничего не осталось)',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
