/**
 * AI Publisher — раскрытие контакта заявителя и заметок (P-D, проектный
 * документ §1 п.7, §8.1, §11.3; аудит P1-3; ТЗ §21; AT-CORE-09).
 *
 * `POST` (Р-PUB-Z2-25, предаудит D1-02): раскрытие пишет журнал доступа к
 * ПД, а `GET` — «безопасный» метод: барьеры CSRF веб-кабинета (`X-Telegram-App`,
 * Origin из `WEB_CABINET_ORIGINS`) его пропускают, и навигация с чужого сайта
 * по cookie раскрывала контакт с записью в журнал. `POST` барьеры проходит
 * только из кабинета; прежний `GET` — 405 (`Allow: POST`) без записи.
 * Без `opKey`, без ключа идемпотентности и без хранения ответа
 * (расшифрованные данные нигде не оседают). Порядок: роль (PO, SA
 * — матрица `lead.contact.reveal`; аналитик, оператор, редактор, админ —
 * 403) → заявка продукта и не удалена → запись аудита `reveal_contact`
 * (без содержимого, с целью) ОТДЕЛЬНОЙ короткой транзакцией → расшифровка
 * → ответ с `Cache-Control: private, no-store`. Нет записи аудита — нет
 * раскрытия. Без ключа — 503 `PUB_CONTACT_KEY_MISSING`, текстом ничего не
 * отдаётся.
 */
import {
  Body,
  Get,
  HttpCode,
  MethodNotAllowedException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  CONTACT_PURPOSES,
  type LeadContactView,
  type LeadNotesView,
} from '../contracts/leads-api';
import type { LeadStatus } from '../contracts/states';
import {
  openContact,
  openNote,
  openText,
  publisherKeys,
} from '../core/contact-crypto';
import { PUB_NO_STORE, PubError, validationError } from '../core/errors';
import { PubOperations } from '../core/operation';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { LeadsService } from './leads.service';

/**
 * Версия уведомления о данных из шифра заявки (аудит P-D S3-4): что видел
 * заявитель и что действовало у продукта при приёме. Заявки до поправки
 * следа не несут — null.
 */
export function noticeOf(plain: string | null): LeadContactView['dataNotice'] {
  if (!plain) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.dataNoticeVersion !== 'string') return null;
  const expected =
    typeof o.dataNoticeExpected === 'string' ? o.dataNoticeExpected : null;
  return {
    version: o.dataNoticeVersion,
    expected,
    matches: expected !== null && expected === o.dataNoticeVersion,
  };
}

function methodNotAllowed(res: Response): never {
  res.setHeader('Allow', 'POST');
  res.setHeader('Cache-Control', PUB_NO_STORE);
  throw new MethodNotAllowedException(
    'раскрытие контакта и заметок — только POST из кабинета',
  );
}

@PubCabinetController('products/:pid')
export class PublisherLeadContactsController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly leads: LeadsService,
  ) {}

  /** Прежний `GET` раскрытия — 405 без записи в журнал (D1-02). */
  @Get('leads/:id/contact')
  @PubAllow('lead.contact.reveal')
  contactGet(@Res({ passthrough: true }) res: Response): never {
    return methodNotAllowed(res);
  }

  @Get('leads/:id/notes')
  @PubAllow('lead.contact.reveal')
  notesGet(@Res({ passthrough: true }) res: Response): never {
    return methodNotAllowed(res);
  }

  @Post('leads/:id/contact')
  @HttpCode(200)
  @PubAllow('lead.contact.reveal')
  async contact(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadContactView> {
    res.setHeader('Cache-Control', PUB_NO_STORE);
    const purpose =
      body && typeof body === 'object'
        ? (body as { purpose?: unknown }).purpose
        : undefined;
    if (!(CONTACT_PURPOSES as readonly unknown[]).includes(purpose)) {
      throw validationError([
        { field: 'purpose', code: purpose === undefined ? 'required' : 'enum' },
      ]);
    }
    const p = ctx.product;
    if (!p) throw new PubError('PUB_NOT_FOUND');
    const db = this.db.forAccount(ctx.m.accountId);
    const lead = await this.leads.row(db, p.id, id);
    if (lead.erasedAt)
      throw new PubError('PUB_NOT_FOUND', { reason: 'erased' });
    const keys = publisherKeys('leadContact');
    if (!keys) throw new PubError('PUB_CONTACT_KEY_MISSING');
    const row = await db.pubLeadContact.findFirst({
      where: { leadId: id, productId: p.id },
      select: { contactEnc: true },
    });
    if (!row) throw new PubError('PUB_NOT_FOUND', { reason: 'erased' });
    await this.ops.recordRead(ctx.m, ctx.access, p, 'lead.contact.reveal', {
      objectType: 'lead',
      objectId: id,
      action: 'reveal_contact',
      meta: { what: 'contact', purpose: purpose as string },
    });
    const opened = openContact(row.contactEnc, id, keys);
    if (!opened)
      throw new PubError('PUB_CONTACT_KEY_MISSING', {
        reason: 'decrypt_failed',
      });
    return {
      leadId: id,
      publicRef: lead.publicRef,
      name: opened.value.name,
      contactMethod: opened.value.contactMethod,
      contact: opened.value.contact,
      business: opened.value.business,
      task: opened.value.task,
      selfReported: opened.value.selfReported,
      dataNotice: noticeOf(openText(row.contactEnc, id, keys)?.value ?? null),
    };
  }

  @Post('leads/:id/notes')
  @HttpCode(200)
  @PubAllow('lead.contact.reveal')
  async notes(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadNotesView> {
    res.setHeader('Cache-Control', PUB_NO_STORE);
    const p = ctx.product;
    if (!p) throw new PubError('PUB_NOT_FOUND');
    const db = this.db.forAccount(ctx.m.accountId);
    const lead = await this.leads.row(db, p.id, id);
    const keys = publisherKeys('leadNotes');
    if (!keys) throw new PubError('PUB_CONTACT_KEY_MISSING');
    const [decisions, prospect] = await Promise.all([
      db.pubLeadDecision.findMany({
        where: { leadId: id, productId: p.id, noteEnc: { not: null } },
        orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, toStatus: true, decidedAt: true, noteEnc: true },
      }),
      lead.prospectId
        ? db.pubProspect.findFirst({
            where: {
              id: lead.prospectId,
              productId: p.id,
              noteEnc: { not: null },
            },
            select: { id: true, noteEnc: true },
          })
        : Promise.resolve(null),
    ]);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'lead.contact.reveal', {
      objectType: 'lead',
      objectId: id,
      action: 'reveal_contact',
      meta: {
        what: 'notes',
        decisions: decisions.length,
        prospectNote: !!prospect,
      },
    });
    return {
      leadId: id,
      decisions: decisions.map((d) => ({
        decisionId: d.id,
        toStatus: d.toStatus as LeadStatus,
        decidedAt: d.decidedAt.toISOString(),
        note: openNote(d.noteEnc, d.id, keys)?.value ?? '',
      })),
      prospect: prospect?.noteEnc
        ? {
            prospectId: prospect.id,
            note: openNote(prospect.noteEnc, prospect.id, keys)?.value ?? '',
          }
        : null,
    };
  }
}
