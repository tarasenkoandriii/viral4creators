/**
 * Подтверждение владения хостом: выдача инструкции, проверка, пакетная
 * проверка, чужие авторизации и их отзыв (ТЗ помощника §3.3, §4.16; QA-ТЗ
 * §2.4, §5.1).
 *
 * Подтверждение — запись ядра на пару (кабинет, хост): строка `SiteHost`
 * ЭТОГО кабинета. Токен — токен ЭТОГО кабинета (`SiteAccount.verifyToken`).
 */

import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import type { SiteHost } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  VERIFY_FILE_PATH,
  VERIFY_TXT_KEY,
  verifyMetaTag,
  verifyTxtName,
  verifyTxtValue,
} from '../../../brand';
import type { AccountMembership } from '../account/roles';
import { HostAddress, hostOrigin } from '../hosts/host-normalize';
import {
  OWNERSHIP_TTL_MS,
  VerifyMethod,
  forbidden,
  notFoundHost,
  notFoundSite,
  siteCoreError,
} from '../site-core.constants';
import {
  HostView,
  checkJson,
  effectiveStatus,
  toHostView,
} from '../sites/host-view';
import { evaluateHostAccess } from './host-access';
import { CheckResult, OwnershipChecker } from './ownership-checker';
import { releaseLapsedBlock } from './reverify-block';

export interface VerifyOutcome {
  host: HostView;
  ok: boolean;
  code?: string;
  message?: string;
}

export type Instruction =
  | { method: 'dns'; recordType: 'TXT'; name: string; value: string }
  | { method: 'file'; url: string; content: string }
  | { method: 'meta'; pageUrl: string; tag: string };

export function buildInstruction(
  method: VerifyMethod,
  host: HostAddress,
  token: string,
): Instruction {
  switch (method) {
    case 'dns':
      return {
        method,
        recordType: 'TXT',
        name: verifyTxtName(host.host),
        value: verifyTxtValue(token),
      };
    case 'file':
      return {
        method,
        url: `${hostOrigin(host)}${VERIFY_FILE_PATH}`,
        content: token,
      };
    case 'meta':
      return {
        method,
        pageUrl: `${hostOrigin(host)}/`,
        tag: verifyMetaTag(token),
      };
  }
}

const addrOf = (h: Pick<SiteHost, 'host' | 'port'>): HostAddress => ({
  scheme: 'https',
  host: h.host,
  port: h.port,
});

const BATCH_CONCURRENCY = 4;

/** Машинный код исключения ядра (`siteCoreError` кладёт его в `code`). */
function codeOf(e: HttpException): unknown {
  const body = e.getResponse();
  return typeof body === 'object' && body !== null
    ? (body as { code?: unknown }).code
    : undefined;
}

/** `items` по `limit` параллельно, порядок результатов — как у входа. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

@Injectable()
export class OwnershipService {
  constructor(
    private readonly db: SitesDb,
    private readonly checker: OwnershipChecker,
  ) {}

  private async loadHost(
    m: AccountMembership,
    hostId: string,
  ): Promise<SiteHost> {
    const host = await this.db
      .forAccount(m.accountId)
      .siteHost.findFirst({ where: { id: hostId } });
    if (!host) throw notFoundHost();
    return host;
  }

  private async accountToken(m: AccountMembership): Promise<string> {
    const acc = await this.db
      .forAccount(m.accountId)
      .siteAccount.findUnique({ where: { id: m.accountId } });
    if (!acc) throw forbidden('ACCOUNT_REQUIRED', 'Кабинет не найден');
    return acc.verifyToken;
  }

  /** Способ, допустимый для хоста: публичные платформы — только DNS. */
  private assertMethodAllowed(host: SiteHost, method: VerifyMethod): void {
    if (host.publicPlatform && method !== 'dns') {
      throw siteCoreError(
        ConflictException,
        'METHOD_NOT_ALLOWED',
        'Хост на публичной платформе подтверждается только DNS-записью. Если доступа к DNS платформы нет — подключите собственный домен',
      );
    }
  }

  private assertNotBlocked(host: SiteHost): void {
    if (host.reverifyBlockedAt) {
      throw forbidden(
        'REVERIFY_BLOCKED',
        'Владелец хоста отозвал подтверждение вашего кабинета. Повторное подтверждение недоступно, пока он не снимет блокировку',
      );
    }
  }

  /** Выдать токен/инструкцию (`POST /sites/hosts/:hostId/challenge`). */
  async challenge(
    m: AccountMembership,
    hostId: string,
    method: VerifyMethod,
    now = new Date(),
  ) {
    const host = await releaseLapsedBlock(
      this.db,
      await this.loadHost(m, hostId),
      now,
    );
    this.assertNotBlocked(host);
    this.assertMethodAllowed(host, method);
    const token = await this.accountToken(m);
    await this.db.forAccount(m.accountId).siteOwnershipChallenge.create({
      data: {
        accountId: m.accountId,
        hostId,
        method,
        token,
        status: 'pending',
      },
    });
    return {
      token,
      method,
      instruction: buildInstruction(method, addrOf(host), token),
    };
  }

  /** Проверить один хост сейчас (`POST /sites/hosts/:hostId/verify`). */
  async verify(
    m: AccountMembership,
    hostId: string,
    method: VerifyMethod | undefined,
    now = new Date(),
  ): Promise<VerifyOutcome> {
    const host = await releaseLapsedBlock(
      this.db,
      await this.loadHost(m, hostId),
      now,
    );
    this.assertNotBlocked(host);
    const chosen = method ?? (await this.defaultMethod(m, host));
    this.assertMethodAllowed(host, chosen);
    return this.runCheck(m, host, chosen, await this.accountToken(m), now);
  }

  /** Способ по умолчанию: последний выданный, иначе прежний, иначе DNS. */
  private async defaultMethod(
    m: AccountMembership,
    host: SiteHost,
  ): Promise<VerifyMethod> {
    if (host.publicPlatform) return 'dns';
    const last = await this.db
      .forAccount(m.accountId)
      .siteOwnershipChallenge.findFirst({
        where: { hostId: host.id },
        orderBy: { createdAt: 'desc' },
      });
    const v = last?.method ?? host.method;
    return v === 'file' || v === 'meta' ? v : 'dns';
  }

  private async runCheck(
    m: AccountMembership,
    host: SiteHost,
    method: VerifyMethod,
    token: string,
    now: Date,
  ): Promise<VerifyOutcome> {
    const r = await this.checker.check(method, addrOf(host), token);
    const updated = await this.persist(m, host, r, now);
    return {
      host: toHostView(updated, now),
      ok: r.ok,
      ...(r.ok ? {} : { code: r.code }),
      message: r.message,
    };
  }

  /**
   * Итог ручной проверки → строка хоста и challenge. Успех — `verified`
   * на 90 дней от сейчас (повторная проверка продлевает срок). Неуспех
   * статус НЕ меняет: «не нашли запись сейчас» — повод показать причину,
   * а отзыв — дело крона по однозначному «токена нет».
   */
  private async persist(
    m: AccountMembership,
    host: SiteHost,
    r: CheckResult,
    now: Date,
  ): Promise<SiteHost> {
    const db = this.db.forAccount(m.accountId);
    const last = checkJson(r, now);
    let updated: SiteHost;
    if (r.ok) {
      // Условие `reverifyBlockedAt: null` — в самой записи, а не только в
      // assertNotBlocked до сети: проверка идёт до 10 с, и если за это
      // время подтвердивший хост кабинет отозвал нас (revokeForeign),
      // безусловный UPDATE вернул бы `verified` поверх `revoked` +
      // блокировки — выдворенный кабинет снова получил бы L1.
      const { count } = await db.siteHost.updateMany({
        where: { id: host.id, reverifyBlockedAt: null },
        data: {
          status: 'verified',
          method: r.method,
          verifiedAt: now,
          expiresAt: new Date(now.getTime() + OWNERSHIP_TTL_MS),
          lastRecheckAt: now,
          revokedAt: null,
          lastCheck: last,
        },
      });
      if (count !== 1) {
        const current = await db.siteHost.findFirst({ where: { id: host.id } });
        if (!current) throw notFoundHost();
        this.assertNotBlocked(current);
        throw notFoundHost();
      }
      const fresh = await db.siteHost.findFirst({ where: { id: host.id } });
      if (!fresh) throw notFoundHost();
      updated = fresh;
    } else {
      updated = await db.siteHost.update({
        where: { id: host.id },
        data: { lastCheck: last },
      });
    }
    await db.siteOwnershipChallenge.updateMany({
      where: { hostId: host.id, method: r.method, status: 'pending' },
      data: r.ok
        ? {
            status: 'verified',
            checkedAt: now,
            expiresAt: new Date(now.getTime() + OWNERSHIP_TTL_MS),
          }
        : { checkedAt: now },
    });
    return updated;
  }

  /**
   * «Проверить все» (`POST /sites/:id/verify-all`): все НЕ подтверждённые
   * хосты сайта (pending, а также expired/revoked — им нужен повтор), кроме
   * заблокированных. Способ — последний выданный для хоста.
   */
  async verifyAll(
    m: AccountMembership,
    siteId: string,
    now = new Date(),
  ): Promise<{ results: VerifyOutcome[] }> {
    const db = this.db.forAccount(m.accountId);
    const site = await db.site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    const rows = await db.siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    const hosts: SiteHost[] = [];
    for (const row of rows) {
      if (effectiveStatus(row, now) === 'verified') continue;
      const h = await releaseLapsedBlock(this.db, row, now);
      if (!h.reverifyBlockedAt) hosts.push(h);
    }
    if (hosts.length === 0) return { results: [] };
    const token = await this.accountToken(m);
    const results = await mapLimit(hosts, BATCH_CONCURRENCY, async (h) => {
      try {
        return await this.runCheck(
          m,
          h,
          await this.defaultMethod(m, h),
          token,
          now,
        );
      } catch (e) {
        // Хост заблокировали, пока шла проверка (см. persist), — он выпадает
        // из пачки так же, как заблокированные до неё; остальные итоги
        // пакета не теряются из-за одного.
        if (e instanceof HttpException && codeOf(e) === 'REVERIFY_BLOCKED') {
          return null;
        }
        throw e;
      }
    });
    return {
      results: results.filter((r): r is VerifyOutcome => r !== null),
    };
  }

  /** Наш хост подтверждён сейчас (L1, без льготы) — иначе 403. */
  private async assertOwnVerified(
    m: AccountMembership,
    hostId: string,
    now: Date,
  ): Promise<SiteHost> {
    const host = await this.loadHost(m, hostId);
    const d = evaluateHostAccess(host, 'assist-admin', now);
    if (!d.ok) {
      throw forbidden(
        'HOST_NOT_VERIFIED',
        'Чужие подтверждения видит и отзывает только кабинет, подтвердивший этот хост',
      );
    }
    return host;
  }

  private foreignWhere(m: AccountMembership, host: SiteHost) {
    return {
      scheme: host.scheme,
      host: host.host,
      port: host.port,
      accountId: { not: m.accountId },
    };
  }

  /** Кто ещё подтвердил/добавил этот хост (`GET …/authorizations`). */
  async authorizations(m: AccountMembership, hostId: string, now = new Date()) {
    const host = await this.assertOwnVerified(m, hostId, now);
    const rows = await this.db
      .system('чужие авторизации хоста: видит подтвердивший кабинет (QA §5.1)')
      .siteHost.findMany({
        where: this.foreignWhere(m, host),
        orderBy: { createdAt: 'asc' },
      });
    return {
      host: toHostView(host, now),
      others: rows.map((r) => ({
        hostId: r.id,
        status: effectiveStatus(r, now),
        method: r.method,
        verifiedAt: r.verifiedAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        reverifyBlocked: r.reverifyBlockedAt !== null,
      })),
    };
  }

  /**
   * «Отозвать все чужие» (QA §5.1): чужие строки этого хоста → `revoked` +
   * блокировка повторного подтверждения. Если чужой токен всё ещё лежит в
   * DNS/файле, тот кабинет подтвердил бы хост заново — поэтому ответ
   * показывает найденные чужие TXT/файл с подсказкой «удалите их».
   */
  async revokeForeign(m: AccountMembership, hostId: string, now = new Date()) {
    const host = await this.assertOwnVerified(m, hostId, now);
    const system = this.db.system('отзыв чужих авторизаций хоста (QA §5.1)');
    const { count } = await system.siteHost.updateMany({
      where: { ...this.foreignWhere(m, host), reverifyBlockedAt: null },
      data: {
        status: 'revoked',
        revokedAt: now,
        reverifyBlockedAt: now,
        reverifyBlockedByAccountId: m.accountId,
      },
    });
    const token = await this.accountToken(m);
    const ours = verifyTxtValue(token);
    const addr = addrOf(host);
    const [txt, file] = await Promise.all([
      this.checker.txtValues(addr),
      this.checker.fileFirstLine(addr),
    ]);
    return {
      revoked: count,
      foreignMarkers: {
        dnsName: verifyTxtName(host.host),
        dns: txt.filter(
          (v) => v !== ours && v.startsWith(`${VERIFY_TXT_KEY}=`),
        ),
        file: file && file !== token ? file : null,
        hint: 'Удалите чужие записи и файлы — иначе их владельцы увидят, что подтверждение снято, но DNS/файл всё ещё указывают на них',
      },
    };
  }

  /** Снять блокировку с чужой строки хоста (владелец, подтвердивший хост). */
  async unblockForeign(
    m: AccountMembership,
    hostId: string,
    foreignHostId: string,
    now = new Date(),
  ) {
    const host = await this.assertOwnVerified(m, hostId, now);
    const { count } = await this.db
      .system('снятие блокировки повторного подтверждения (QA §5.1)')
      .siteHost.updateMany({
        where: { ...this.foreignWhere(m, host), id: foreignHostId },
        data: { reverifyBlockedAt: null, reverifyBlockedByAccountId: null },
      });
    if (count !== 1) throw notFoundHost();
    return { unblocked: true };
  }
}
