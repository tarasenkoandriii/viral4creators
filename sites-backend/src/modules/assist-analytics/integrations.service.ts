/**
 * Секреты интеграций сайта — A (ТЗ §5-тер.1 «Вебхук s2s», §3-бис.2
 * identify с userHash). assist_site_integrations, шифр ASSIST_SECRETS_KEY
 * (производный ключ, как lead-crypto/token-crypto — без нового секрета),
 * показ ОДИН раз, ротация = новый секрет (старый недействителен сразу).
 * Права: выпуск/отзыв — владелец кабинета; просмотр статуса — manager.
 *
 * `verifyUserHash` — для СИСТЕМНОГО кода (доставка лида — A, карточка
 * передачи — H): HMAC-SHA256(секрет идентичности, externalId) hex,
 * timingSafeEqual. Секрета нет — `null` («заявлено», не «проверено»).
 *
 * Уточнения A: секрет `whsec_…`/`idsec_…` (32 байта случайности),
 * шифр AES-256-GCM, AAD = `<siteId>:<kind>` — шифр одного сайта не
 * подложить другому (§5-тер.16 п.18 «подпись чужим секретом — 401»).
 * Отозванный секрет — строка `revoked` с затёртым шифром. `endpoint` — путь
 * без origin: TMA знает свой адрес API (отдельной переменной окружения
 * «origin API» в проекте нет — контракт Э2: новых env агенты не вводят).
 * В лог — только id сайта и вид секрета.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { analyticsError, forbidden, notFoundSite } from './analytics-errors';
import type { IntegrationsView, SecretIssuedView } from './api-types';

export type IntegrationKind = 'goal_webhook' | 'identity';

const SECRET_KEY_LABEL = 'assist-site-integration-secret-v1';
const PREFIX: Record<IntegrationKind, string> = {
  goal_webhook: 'whsec_',
  identity: 'idsec_',
};

export function integrationsKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const secret = env.ASSIST_SECRETS_KEY?.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update(SECRET_KEY_LABEL).digest();
}

export function encryptSecret(
  secret: string,
  aad: string,
  key: Buffer,
): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

export function decryptSecret(
  blob: string,
  aad: string,
  key: Buffer,
): string | null {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64url'),
    );
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([
      d.update(Buffer.from(parts[3], 'base64url')),
      d.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** hex HMAC-SHA256(секрет идентичности, externalId) — те же векторы, что плагин и npm. */
export function userHashOf(secret: string, externalId: string): string {
  return createHmac('sha256', secret).update(externalId, 'utf8').digest('hex');
}

export function goalWebhookEndpoint(siteId: string): string {
  return `/assist/v1/sites/${encodeURIComponent(siteId)}/goal-events`;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    return db;
  }

  async view(m: AccountMembership, siteId: string): Promise<IntegrationsView> {
    const db = await this.site(m, siteId);
    const rows = await db.assistSiteIntegration.findMany({
      where: { siteId, status: 'active' },
      select: {
        kind: true,
        createdAt: true,
        rotatedAt: true,
        lastUsedAt: true,
      },
    });
    const hook = rows.find((r) => r.kind === 'goal_webhook');
    const id = rows.find((r) => r.kind === 'identity');
    return {
      goalWebhook: {
        active: !!hook,
        createdAt: hook
          ? (hook.rotatedAt ?? hook.createdAt).toISOString()
          : null,
        lastUsedAt: hook?.lastUsedAt?.toISOString() ?? null,
        endpoint: goalWebhookEndpoint(siteId),
      },
      identity: {
        active: !!id,
        createdAt: id ? (id.rotatedAt ?? id.createdAt).toISOString() : null,
      },
    };
  }

  async issue(
    m: AccountMembership,
    siteId: string,
    kind: IntegrationKind,
  ): Promise<SecretIssuedView> {
    if (m.role !== 'owner') {
      throw forbidden('Секреты интеграций выпускает только владелец кабинета');
    }
    if (kind !== 'goal_webhook' && kind !== 'identity') {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'INTEGRATION_NOT_FOUND',
        'Нет такой интеграции',
      );
    }
    const db = await this.site(m, siteId);
    const key = integrationsKey(this.env);
    if (!key) {
      this.logger.error('секрет не выпущен: нет ASSIST_SECRETS_KEY');
      throw analyticsError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'BAD_REQUEST',
        'Хранилище секретов не настроено',
      );
    }
    const secret = `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
    const secretEnc = encryptSecret(secret, `${siteId}:${kind}`, key);
    const now = this.now();
    const row = await db.assistSiteIntegration.upsert({
      where: { siteId_kind: { siteId, kind } },
      create: {
        accountId: m.accountId,
        siteId,
        kind,
        secretEnc,
        status: 'active',
        createdByTelegramId: m.telegramId,
        createdAt: now,
      },
      update: {
        secretEnc,
        status: 'active',
        keyVersion: { increment: 1 },
        createdByTelegramId: m.telegramId,
        rotatedAt: now,
        lastUsedAt: null,
      },
      select: { createdAt: true, rotatedAt: true },
    });
    this.logger.log(`секрет ${kind} выпущен (site ${siteId})`);
    return {
      kind,
      secret,
      createdAt: (row.rotatedAt ?? row.createdAt).toISOString(),
    };
  }

  async revoke(
    m: AccountMembership,
    siteId: string,
    kind: IntegrationKind,
  ): Promise<void> {
    if (m.role !== 'owner') {
      throw forbidden('Секреты интеграций отзывает только владелец кабинета');
    }
    const db = await this.site(m, siteId);
    const r = await db.assistSiteIntegration.updateMany({
      where: { siteId, kind, status: 'active' },
      data: { status: 'revoked', secretEnc: '', rotatedAt: this.now() },
    });
    if (r.count === 0) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'INTEGRATION_NOT_FOUND',
        'Интеграция не подключена',
      );
    }
    this.logger.log(`секрет ${kind} отозван (site ${siteId})`);
  }

  private async secretOf(
    siteId: string,
    kind: IntegrationKind,
  ): Promise<string | null> {
    if (typeof siteId !== 'string' || !siteId) return null;
    const row = await this.prisma.assistSiteIntegration.findUnique({
      where: { siteId_kind: { siteId, kind } },
      select: { secretEnc: true, status: true },
    });
    if (!row || row.status !== 'active' || !row.secretEnc) return null;
    const key = integrationsKey(this.env);
    return key ? decryptSecret(row.secretEnc, `${siteId}:${kind}`, key) : null;
  }

  /** Расшифрованный секрет вебхука (только goal-webhook.service). */
  webhookSecret(siteId: string): Promise<string | null> {
    return this.secretOf(siteId, 'goal_webhook');
  }

  /** Отметка «вебхук пользовались» — для экрана интеграций. */
  async touchWebhook(siteId: string): Promise<void> {
    await this.prisma.assistSiteIntegration.updateMany({
      where: { siteId, kind: 'goal_webhook', status: 'active' },
      data: { lastUsedAt: this.now() },
    });
  }

  async verifyUserHash(
    siteId: string,
    externalId: string,
    userHash: string,
  ): Promise<boolean | null> {
    const secret = await this.secretOf(siteId, 'identity');
    if (!secret) return null;
    if (
      typeof externalId !== 'string' ||
      !externalId ||
      typeof userHash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(userHash)
    ) {
      return false;
    }
    const expected = Buffer.from(userHashOf(secret, externalId), 'hex');
    return timingSafeEqual(
      Buffer.from(userHash.toLowerCase(), 'hex'),
      expected,
    );
  }
}
