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
import {
  derivedKeys,
  openWithKeys,
  type DerivedKeys,
} from '../../common/secrets-keyring';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { analyticsError, forbidden, notFoundSite } from './analytics-errors';
import type { IntegrationsView, SecretIssuedView } from './api-types';

/**
 * Э-С Ш5: `knowledge_api` — ключ системного API знаний
 * (`PUT /assist/v1/sites/:id/knowledge/site/documents/:key`, модуль
 * assist-site-knowledge-api): документы из кода владельца — в базу знаний
 * сайта. Тот же выпуск/отзыв владельцем, тот же шифр и показ один раз.
 */
export type IntegrationKind = 'goal_webhook' | 'identity' | 'knowledge_api';
export const INTEGRATION_KINDS: readonly IntegrationKind[] = [
  'goal_webhook',
  'identity',
  'knowledge_api',
];

const SECRET_KEY_LABEL = 'assist-site-integration-secret-v1';
const PREFIX: Record<IntegrationKind, string> = {
  goal_webhook: 'whsec_',
  identity: 'idsec_',
  knowledge_api: 'knsec_',
};

/** №60: ключи всех версий связки ASSIST_SECRETS_KEY; null — ключа нет. */
export function integrationsKey(
  env: NodeJS.ProcessEnv = process.env,
): DerivedKeys | null {
  return derivedKeys(env, SECRET_KEY_LABEL);
}

export function encryptSecret(
  secret: string,
  aad: string,
  keys: DerivedKeys,
): string {
  return sealSecret(secret, aad, keys.currentKey);
}

function sealSecret(secret: string, aad: string, key: Buffer): string {
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
  keys: DerivedKeys,
): string | null {
  return openIntegrationSecret(blob, aad, keys)?.value ?? null;
}

/** Как decrypt, но с версией ключа, которым открылось (ротация, №60). */
export function openIntegrationSecret(
  blob: string,
  aad: string,
  keys: DerivedKeys,
): { value: string; version: string } | null {
  if (typeof blob !== 'string') return null;
  return openWithKeys(keys, blob, (body, key) => openSecret(body, aad, key));
}

function openSecret(blob: string, aad: string, key: Buffer): string | null {
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

/** Э-С Ш5: база путей системного API знаний сайта (без origin, как вебхук). */
export function knowledgeApiEndpoint(siteId: string): string {
  return `/assist/v1/sites/${encodeURIComponent(siteId)}/knowledge/site/documents`;
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
    const kn = rows.find((r) => r.kind === 'knowledge_api');
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
      knowledgeApi: {
        active: !!kn,
        createdAt: kn ? (kn.rotatedAt ?? kn.createdAt).toISOString() : null,
        lastUsedAt: kn?.lastUsedAt?.toISOString() ?? null,
        endpoint: knowledgeApiEndpoint(siteId),
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
    if (!INTEGRATION_KINDS.includes(kind)) {
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

  /** Э-С Ш5: расшифрованный ключ API знаний (только assist-site-knowledge-api). */
  knowledgeApiSecret(siteId: string): Promise<string | null> {
    return this.secretOf(siteId, 'knowledge_api');
  }

  /** Отметка «API знаний пользовались» — для экрана интеграций. */
  async touchKnowledgeApi(siteId: string): Promise<void> {
    await this.prisma.assistSiteIntegration.updateMany({
      where: { siteId, kind: 'knowledge_api', status: 'active' },
      data: { lastUsedAt: this.now() },
    });
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
