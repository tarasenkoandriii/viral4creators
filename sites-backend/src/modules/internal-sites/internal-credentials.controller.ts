/**
 * Внутренний API хранилища учётных данных для обучалки генератора (Э-С
 * Ш2). Отдельный файл маршрутов, та же подпись HMAC, что у Ш1
 * (`tutorial-hmac.guard.ts`, секрет `SITES_TUTORIAL_HMAC_SECRET`), но свой
 * потолок тела (`INTERNAL_CREDENTIALS_BODY_LIMIT` — куки сессии до 256 КБ).
 *
 * Режим A — реестр сайта, от имени `telegramId` (владелец/менеджер кабинета):
 *   POST /internal/sites/credentials/status
 *   POST /internal/sites/credentials/test-accounts/list          { telegramId, hostId }
 *   POST /internal/sites/credentials/test-accounts/upsert        { telegramId, hostId, testAccountId?, clientRef?, account }
 *   POST /internal/sites/credentials/test-accounts/delete        { telegramId, testAccountId }
 *   POST /internal/sites/credentials/test-accounts/put-secret    { telegramId, testAccountId, purpose, secret|null }
 *   POST /internal/sites/credentials/test-accounts/forget-secrets { telegramId, testAccountId }
 *   POST /internal/sites/credentials/lease                       { telegramId, testAccountId, hostId, product, runRef? }
 *   POST /internal/sites/credentials/lease/redeem                { telegramId, leaseId } → секреты (один раз)
 *
 * Режим B — личные записи пользователя генератора (`ownerRef = gen:<userId>`):
 *   POST /internal/sites/credentials/user-sessions/{upsert,list,update,put-secret,read,delete}
 *
 * Секреты в ответе бывают ТОЛЬКО у `lease/redeem` и `user-sessions/read`.
 */
import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { isCredentialPurpose } from '../site-credentials/credential-types';
import {
  SiteCredentialsService,
  normalizeOrigin,
  parseClientRef,
  parseId,
  parseOwnerRef,
} from '../site-credentials/site-credentials.service';
import {
  TEST_ACCOUNT_PRODUCTS,
  TestAccountProduct,
  hasControlChars,
  parseTestAccountInput,
} from '../site-credentials/test-account-input';
import { InternalCredentialsService } from './internal-credentials.service';
import { parseTelegramId } from './internal-sites.service';
import { InternalRequest, TutorialHmacGuard } from './tutorial-hmac.guard';

const InternalBody = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<InternalRequest>().internalBody,
);

function bad(message: string): BadRequestException {
  return new BadRequestException({
    error: 'INTERNAL_BAD_BODY',
    code: 'INTERNAL_BAD_BODY',
    message,
  });
}

/** Объект тела с ровно этими полями (лишнее — 400). */
function fields(
  b: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad('Ожидается JSON-объект');
  }
  const o = b as Record<string, unknown>;
  const known = new Set([...required, ...optional]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) throw bad(`Лишнее поле «${k}»`);
  }
  for (const k of required) {
    if (o[k] === undefined) throw bad(`Нет поля «${k}»`);
  }
  return o;
}

function purposeOf(v: unknown) {
  if (!isCredentialPurpose(v)) {
    throw bad('purpose: password | login-fields | session-cookies');
  }
  return v;
}

function secretOf(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length === 0) {
    throw bad('secret — непустая строка или null (стереть)');
  }
  return v;
}

function productOf(v: unknown): TestAccountProduct {
  if (!(TEST_ACCOUNT_PRODUCTS as readonly unknown[]).includes(v)) {
    throw bad('product: tutorial | qa | assist-admin');
  }
  return v as TestAccountProduct;
}

function runRefOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (
    typeof v !== 'string' ||
    v.length > 80 ||
    !/^[a-z]{1,16}:[A-Za-z0-9_-]{1,64}$/.test(v)
  ) {
    throw bad('runRef — «draft:<id>»');
  }
  return v;
}

function labelOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 80 || hasControlChars(v)) {
    throw bad('label — строка до 80 символов');
  }
  return v.trim() || null;
}

@Controller('internal/sites/credentials')
@PublicRoute(
  'внутренний API обучалки генератора: HMAC с меткой времени и id (SITES_TUTORIAL_HMAC_SECRET)',
)
@UseGuards(TutorialHmacGuard)
export class InternalCredentialsController {
  constructor(
    private readonly svc: InternalCredentialsService,
    private readonly creds: SiteCredentialsService,
  ) {}

  @Post('status')
  @HttpCode(200)
  status(@InternalBody() b: unknown) {
    if (b !== undefined) fields(b, []);
    return this.svc.status();
  }

  // ── A: реестр сайта ──

  @Post('test-accounts/list')
  @HttpCode(200)
  list(@InternalBody() b: unknown) {
    const o = fields(b, ['telegramId', 'hostId']);
    return this.svc.list(
      parseTelegramId(o.telegramId),
      parseId(o.hostId, 'hostId'),
    );
  }

  @Post('test-accounts/upsert')
  @HttpCode(200)
  upsert(@InternalBody() b: unknown) {
    const o = fields(
      b,
      ['telegramId', 'hostId', 'account'],
      ['testAccountId', 'clientRef'],
    );
    const testAccountId =
      o.testAccountId === undefined || o.testAccountId === null
        ? null
        : parseId(o.testAccountId, 'testAccountId');
    return this.svc.upsert(
      parseTelegramId(o.telegramId),
      parseId(o.hostId, 'hostId'),
      {
        testAccountId,
        clientRef: parseClientRef(o.clientRef),
        input: parseTestAccountInput(o.account, { partial: true }),
      },
    );
  }

  @Post('test-accounts/delete')
  @HttpCode(200)
  remove(@InternalBody() b: unknown) {
    const o = fields(b, ['telegramId', 'testAccountId']);
    return this.svc.remove(
      parseTelegramId(o.telegramId),
      parseId(o.testAccountId, 'testAccountId'),
    );
  }

  @Post('test-accounts/put-secret')
  @HttpCode(200)
  putSecret(@InternalBody() b: unknown) {
    const o = fields(b, ['telegramId', 'testAccountId', 'purpose', 'secret']);
    return this.svc.putSecret(
      parseTelegramId(o.telegramId),
      parseId(o.testAccountId, 'testAccountId'),
      purposeOf(o.purpose),
      secretOf(o.secret),
    );
  }

  @Post('test-accounts/forget-secrets')
  @HttpCode(200)
  forgetSecrets(@InternalBody() b: unknown) {
    const o = fields(b, ['telegramId', 'testAccountId']);
    return this.svc.forgetSecrets(
      parseTelegramId(o.telegramId),
      parseId(o.testAccountId, 'testAccountId'),
    );
  }

  @Post('lease')
  @HttpCode(200)
  lease(@InternalBody() b: unknown) {
    const o = fields(
      b,
      ['telegramId', 'testAccountId', 'hostId', 'product'],
      ['runRef'],
    );
    return this.svc.lease(parseTelegramId(o.telegramId), {
      testAccountId: parseId(o.testAccountId, 'testAccountId'),
      hostId: parseId(o.hostId, 'hostId'),
      product: productOf(o.product),
      runRef: runRefOf(o.runRef),
    });
  }

  @Post('lease/redeem')
  @HttpCode(200)
  redeem(@InternalBody() b: unknown) {
    const o = fields(b, ['telegramId', 'leaseId']);
    return this.svc.redeem(
      parseTelegramId(o.telegramId),
      parseId(o.leaseId, 'leaseId'),
    );
  }

  // ── B: личные записи ──

  @Post('user-sessions/upsert')
  @HttpCode(200)
  userUpsert(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef', 'origin'], ['clientRef', 'label']);
    return this.creds.upsertUserSession(parseOwnerRef(o.ownerRef), {
      origin: normalizeOrigin(o.origin),
      clientRef: parseClientRef(o.clientRef),
      ...(o.label !== undefined ? { label: labelOf(o.label) } : {}),
    });
  }

  @Post('user-sessions/list')
  @HttpCode(200)
  userList(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef']);
    return this.creds
      .listUserSessions(parseOwnerRef(o.ownerRef))
      .then((sessions) => ({ sessions }));
  }

  @Post('user-sessions/update')
  @HttpCode(200)
  userUpdate(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef', 'sessionId', 'label']);
    return this.creds.updateUserSession(
      parseOwnerRef(o.ownerRef),
      parseId(o.sessionId, 'sessionId'),
      { label: labelOf(o.label) },
    );
  }

  @Post('user-sessions/put-secret')
  @HttpCode(200)
  userPutSecret(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef', 'sessionId', 'purpose', 'secret']);
    return this.creds.putUserSecret(
      parseOwnerRef(o.ownerRef),
      parseId(o.sessionId, 'sessionId'),
      purposeOf(o.purpose),
      secretOf(o.secret),
    );
  }

  @Post('user-sessions/read')
  @HttpCode(200)
  userRead(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef', 'sessionId'], ['runRef']);
    return this.creds.readUserSecrets(
      parseOwnerRef(o.ownerRef),
      parseId(o.sessionId, 'sessionId'),
      runRefOf(o.runRef),
    );
  }

  @Post('user-sessions/delete')
  @HttpCode(200)
  userDelete(@InternalBody() b: unknown) {
    const o = fields(b, ['ownerRef', 'sessionId']);
    return this.creds.deleteUserSession(
      parseOwnerRef(o.ownerRef),
      parseId(o.sessionId, 'sessionId'),
    );
  }
}
