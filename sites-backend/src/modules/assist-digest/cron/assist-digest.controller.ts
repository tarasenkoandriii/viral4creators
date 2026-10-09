/**
 * GET /cron/assist-digest — A (ТЗ §4.15: 06:30 UTC ежедневно; понедельник —
 * отчёт недели). withCronLock + CRON_SECRET.
 */
import { Controller, Get, Headers } from '@nestjs/common';
import {
  ASSIST_DIGEST_CRON_JOB,
  withCronLock,
} from '../../../common/cron-job-lock';
import { assertCronSecret } from '../../../common/cron-secret';
import { PrismaService } from '../../../prisma/prisma.service';
import { PublicRoute } from '../../telegram-auth/allow-apps.decorator';
import { AssistDigestService } from '../digest.service';

/** Замок длиннее прохода: сайты по очереди, сообщение — по одному получателю. */
const DIGEST_LOCK_MS = 15 * 60 * 1000;

@Controller('cron')
@PublicRoute('крон Vercel: доступ по CRON_SECRET, не по initData')
export class AssistDigestController {
  constructor(
    private readonly digest: AssistDigestService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('assist-digest')
  async run(@Headers('authorization') authHeader?: string): Promise<{
    ran: boolean;
    sites?: number;
    sent?: number;
    weekly?: boolean;
  }> {
    assertCronSecret(authHeader);
    const r = await withCronLock(
      this.prisma,
      ASSIST_DIGEST_CRON_JOB,
      DIGEST_LOCK_MS,
      () => this.digest.run(this.digest.now()),
    );
    return r.ran && r.result ? { ran: true, ...r.result } : { ran: false };
  }
}
