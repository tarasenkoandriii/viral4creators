/**
 * Сайты и хосты кабинета (ТЗ помощника §3.3, §4.16; QA-ТЗ §2.2).
 *
 * Все запросы к таблицам кабинета — через `SitesDb.forAccount(accountId)`:
 * кабинет подставляет Prisma-extension тенанта, и забытое
 * `where: { accountId }` здесь не превращается в чужие сайты.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, SiteHost } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { AccountMembership } from '../account/roles';
import {
  HostAddress,
  hostOrigin,
  isPublicPlatformHost,
  normalizeHostInput,
  optOutCandidates,
  registrableDomain,
} from '../hosts/host-normalize';
import { OwnershipChecker } from '../ownership/ownership-checker';
import { releaseLapsedBlock } from '../ownership/reverify-block';
import { fetchSameOrigin, readPrefix } from '../ownership/safe-http';
import {
  SUGGEST_BODY_LIMIT_BYTES,
  SUGGEST_MAX_HOSTS,
  duplicateHost,
  forbidden,
  notFoundHost,
  notFoundSite,
  siteCoreError,
} from '../site-core.constants';
import { HostView, effectiveStatus, toHostView } from './host-view';
import { suggestFromHtml, twinSuggestions } from './suggest-hosts';

export interface SiteView {
  id: string;
  name: string;
  hosts: HostView[];
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError
    ? e.code === 'P2002'
    : (e as { code?: unknown } | null)?.code === 'P2002';
}

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);

  constructor(
    private readonly db: SitesDb,
    private readonly checker: OwnershipChecker,
  ) {}

  async listSites(m: AccountMembership, now = new Date()): Promise<SiteView[]> {
    const db = this.db.forAccount(m.accountId);
    const sites = await db.site.findMany({ orderBy: { createdAt: 'asc' } });
    if (sites.length === 0) return [];
    const rows = await db.siteHost.findMany({
      where: { siteId: { in: sites.map((s) => s.id) } },
      orderBy: { createdAt: 'asc' },
    });
    // Экран прячет «Проверить»/«Удалить» у заблокированного хоста, поэтому
    // осиротевшая блокировка (ownership/reverify-block.ts) снимается уже
    // здесь — иначе снять её было бы нечем. Запрос — только для строк с
    // блокировкой (редкость).
    const hosts = await Promise.all(
      rows.map((h) =>
        h.reverifyBlockedAt ? releaseLapsedBlock(this.db, h, now) : h,
      ),
    );
    return sites.map((s) => ({
      id: s.id,
      name: s.name,
      hosts: hosts
        .filter((h) => h.siteId === s.id)
        .map((h) => toHostView(h, now)),
    }));
  }

  async getSite(m: AccountMembership, siteId: string, now = new Date()) {
    const site = await this.db
      .forAccount(m.accountId)
      .site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    const hosts = await this.db
      .forAccount(m.accountId)
      .siteHost.findMany({ where: { siteId }, orderBy: { createdAt: 'asc' } });
    return {
      id: site.id,
      name: site.name,
      hosts: hosts.map((h) => toHostView(h, now)),
    };
  }

  /** Отказ домена от любых наших проверок/обходов (глобальный справочник). */
  async assertNotOptedOut(host: string): Promise<void> {
    const hit = await this.db.guarded.siteOptOutDomain.findFirst({
      where: { domain: { in: optOutCandidates(host) } },
    });
    if (hit) {
      throw forbidden(
        'HOST_OPTED_OUT',
        'Владелец этого домена отказался от проверок — добавить его нельзя',
      );
    }
  }

  /** Создать сайт (имя) + первый хост. */
  async createSite(
    m: AccountMembership,
    input: { name: string; url: string },
    now = new Date(),
  ): Promise<SiteView> {
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException('Укажите название сайта');
    }
    const addr = normalizeHostInput(input.url);
    await this.assertNotOptedOut(addr.host);
    const db = this.db.forAccount(m.accountId);
    await this.assertNoDuplicate(m, addr);
    const site = await db.site.create({
      data: { accountId: m.accountId, name },
    });
    try {
      const host = await this.insertHost(m, site.id, addr);
      return { id: site.id, name: site.name, hosts: [toHostView(host, now)] };
    } catch (e) {
      // Сайт без хоста — мусор в списке: откатываем руками (интерактивная
      // транзакция через пулер Supabase в transaction-режиме не нужна ради
      // двух строк).
      await db.site.delete({ where: { id: site.id } }).catch(() => undefined);
      throw e;
    }
  }

  async addHost(
    m: AccountMembership,
    siteId: string,
    url: string,
    now = new Date(),
  ): Promise<HostView> {
    const db = this.db.forAccount(m.accountId);
    const site = await db.site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    const addr = normalizeHostInput(url);
    await this.assertNotOptedOut(addr.host);
    await this.assertNoDuplicate(m, addr);
    return toHostView(await this.insertHost(m, siteId, addr), now);
  }

  /**
   * Дубль хоста в кабинете (в том числе в ДРУГОМ сайте кабинета или
   * добавленный в другом продукте) — ошибка, а не второй Site (QA §2.2).
   * Проверка до вставки — ради понятного ответа; гарантия — уникальный
   * индекс (accountId, scheme, host, port), см. insertHost.
   */
  private async assertNoDuplicate(
    m: AccountMembership,
    addr: HostAddress,
  ): Promise<void> {
    const dup = await this.db.forAccount(m.accountId).siteHost.findFirst({
      where: { scheme: addr.scheme, host: addr.host, port: addr.port },
    });
    if (dup) throw duplicateHost();
  }

  private async insertHost(
    m: AccountMembership,
    siteId: string,
    addr: HostAddress,
  ): Promise<SiteHost> {
    try {
      return await this.db.forAccount(m.accountId).siteHost.create({
        data: {
          accountId: m.accountId,
          siteId,
          scheme: addr.scheme,
          host: addr.host,
          port: addr.port,
          publicPlatform: isPublicPlatformHost(addr.host),
          status: 'pending',
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateHost();
      throw e;
    }
  }

  async deleteHost(
    m: AccountMembership,
    siteId: string,
    hostId: string,
  ): Promise<{ deleted: true }> {
    const db = this.db.forAccount(m.accountId);
    const found = await db.siteHost.findFirst({
      where: { id: hostId, siteId },
    });
    if (!found) throw notFoundHost();
    // Блокировка, которую уже никто не держит, удалению не мешает
    // (ownership/reverify-block.ts).
    const host = await releaseLapsedBlock(this.db, found, new Date());
    if (host.reverifyBlockedAt) {
      // Иначе «удалить и добавить заново» снимало бы блокировку, которую
      // поставил подтвердивший хост кабинет (QA §5.1).
      throw siteCoreError(
        ConflictException,
        'HOST_BLOCKED',
        'Подтверждение этого хоста отозвал его владелец — удалить хост нельзя, пока он не снимет блокировку',
      );
    }
    await db.siteHost.delete({ where: { id: hostId } });
    return { deleted: true };
  }

  /**
   * Подсказка хостов: ссылки главной (первый подтверждённый хост сайта,
   * иначе первый) того же регистрируемого домена + пары `www`/apex. Сбой
   * загрузки главной — не ошибка маршрута: пары всё равно полезны.
   */
  async suggestHosts(
    m: AccountMembership,
    siteId: string,
    now = new Date(),
  ): Promise<{ hosts: string[] }> {
    const db = this.db.forAccount(m.accountId);
    const site = await db.site.findFirst({ where: { id: siteId } });
    if (!site) throw notFoundSite();
    const siteHosts = await db.siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    const accountHosts = await db.siteHost.findMany({
      select: { host: true },
    });
    const known = new Set(accountHosts.map((h) => h.host));
    const names = siteHosts.map((h) => h.host);
    const twins = twinSuggestions(names, known);
    const base =
      siteHosts.find((h) => effectiveStatus(h, now) === 'verified') ??
      siteHosts[0];
    let fromPage: string[] = [];
    if (base && registrableDomain(base.host)) {
      const addr: HostAddress = {
        scheme: 'https',
        host: base.host,
        port: base.port,
      };
      const url = `${hostOrigin(addr)}/`;
      try {
        const { res, finalUrl } = await fetchSameOrigin(
          url,
          this.checker.httpDeps,
          { headers: { accept: 'text/html' } },
        );
        if (res.status >= 200 && res.status < 300) {
          const html = (
            await readPrefix(res, SUGGEST_BODY_LIMIT_BYTES)
          ).toString('utf8');
          fromPage = suggestFromHtml(
            html,
            finalUrl,
            base.host,
            new Set([...known, ...twins]),
            SUGGEST_MAX_HOSTS,
          );
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
      } catch (e) {
        this.logger.debug(
          `suggest ${base.host}: ${e instanceof Error ? e.name : 'error'}`,
        );
      }
    }
    return { hosts: [...twins, ...fromPage].slice(0, SUGGEST_MAX_HOSTS) };
  }
}
