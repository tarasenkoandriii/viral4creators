/**
 * Внутренний API sites-backend для обучалки генератора (Э-С Ш1; аудит
 * слияния §3.2, вариант A «внутренний API»). Генератор НЕ получает DSN
 * схемы `sites` и ключей `site_*` — только эти два действия по HMAC
 * (tutorial-hmac.guard.ts).
 *
 * Привязка пользователя генератора к кабинету — по `telegramId`, ровно как
 * вход в TMA помощника (account.service.ts): Telegram-id у человека один во
 * всех ботах, поэтому кабинет, который он завёл в помощнике или QA, — тот
 * же, что видит обучалка, и наоборот. Отдельной таблицы связей нет и не
 * нужно: её пришлось бы синхронизировать с членством.
 *
 *  - `hostStatus` ТОЛЬКО ЧИТАЕТ: кабинет не создаётся, хост не заводится.
 *    Режим A (П-Т1) — хост подтверждён (`assertHostVerified(…, 'tutorial')`,
 *    L1 без льготы 72 ч) в кабинете, где человек — владелец или менеджер
 *    (те, кто вправе подтверждать владение, QA §1.5). Оператор кабинета —
 *    режим B: его пригласили отвечать в чате, а не водить наш браузер по
 *    сайту от имени владельца. Иначе — B.
 *  - `registerHost` — по явному действию человека в TMA генератора
 *    («Подтвердить сайт», с согласием на привязку на экране): кабинет
 *    находится или создаётся (как первый вход в TMA помощника), хост
 *    заводится в статусе `pending` тем же кодом, что экран кабинета
 *    (`SitesService`, opt-out и дубли — там же). Само подтверждение
 *    (DNS/файл/мета) — в TMA помощника или веб-кабинете: генератор
 *    подтвердить владение не может, только попросить завести хост.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { SiteHost } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountService } from '../site-core/account/account.service';
import type { AccountMembership } from '../site-core/account/roles';
import {
  HostAddress,
  normalizeHostInput,
  optOutCandidates,
  registrableDomain,
} from '../site-core/hosts/host-normalize';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { HostStatus, siteCoreError } from '../site-core/site-core.constants';
import { effectiveStatus } from '../site-core/sites/host-view';
import { SitesService } from '../site-core/sites/sites.service';

export const TUTORIAL_PURPOSE = 'tutorial' as const;

export type TutorialMode = 'A' | 'B';

export interface TutorialHostStatus {
  mode: TutorialMode;
  host: string;
  registrableDomain: string | null;
  /** Хост в кабинете человека (лучший кандидат) или `null` — не заведён. */
  hostId: string | null;
  status: HostStatus | 'none';
  expiresAt: Date | null;
  /** Домен в реестре отказов: режима A нет, даже если подтверждён. */
  optedOut: boolean;
  /** Почему не A — машинный код для плашки генератора. */
  reason:
    | null
    | 'no_account'
    | 'not_registered'
    | 'not_verified'
    | 'expired'
    | 'revoked'
    | 'role'
    | 'opted_out';
}

export interface TutorialRegisterResult extends TutorialHostStatus {
  hostId: string;
  siteId: string;
  created: boolean;
  accountCreated: boolean;
}

const MANAGE_ROLES = new Set(['owner', 'manager']);

/** telegramId генератора — строка из цифр (у dev-пользователей её нет). */
export function parseTelegramId(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,19}$/.test(raw)) {
    throw siteCoreError(
      ForbiddenException,
      'ACCOUNT_REQUIRED',
      'Нужен Telegram-аккаунт пользователя',
    );
  }
  return BigInt(raw);
}

@Injectable()
export class InternalSitesService {
  private readonly logger = new Logger(InternalSitesService.name);

  constructor(
    private readonly db: SitesDb,
    private readonly accounts: AccountService,
    private readonly access: HostAccessService,
    private readonly sites: SitesService,
  ) {}

  async hostStatus(
    telegramId: bigint,
    url: unknown,
    now = new Date(),
  ): Promise<TutorialHostStatus> {
    const addr = normalizeHostInput(url);
    const base = {
      host: addr.host,
      registrableDomain: registrableDomain(addr.host),
    };
    const optedOut = await this.isOptedOut(addr.host);
    const all = await this.accounts.memberships(telegramId);
    if (all.length === 0) {
      return {
        ...base,
        mode: 'B',
        hostId: null,
        status: 'none',
        expiresAt: null,
        optedOut,
        reason: optedOut ? 'opted_out' : 'no_account',
      };
    }
    const found = await this.findHosts(all, addr);
    const managed = found.filter((f) => MANAGE_ROLES.has(f.m.role));
    for (const f of managed) {
      try {
        await this.access.assertHostVerified(f.host.id, TUTORIAL_PURPOSE, {
          accountId: f.m.accountId,
          now,
        });
        return {
          ...base,
          mode: 'A',
          hostId: f.host.id,
          status: 'verified',
          expiresAt: f.host.expiresAt,
          optedOut: false,
          reason: null,
        };
      } catch {
        // Не подтверждён/истёк/отозван/opt-out — следующий кандидат; итог
        // ниже по лучшему из оставшихся.
      }
    }
    const best = managed[0] ?? found[0] ?? null;
    if (!best) {
      return {
        ...base,
        mode: 'B',
        hostId: null,
        status: 'none',
        expiresAt: null,
        optedOut,
        reason: optedOut ? 'opted_out' : 'not_registered',
      };
    }
    const status = effectiveStatus(best.host, now);
    return {
      ...base,
      mode: 'B',
      hostId: best.host.id,
      status,
      expiresAt: best.host.expiresAt,
      optedOut,
      reason: optedOut
        ? 'opted_out'
        : !MANAGE_ROLES.has(best.m.role)
          ? 'role'
          : best.host.reverifyBlockedAt || status === 'revoked'
            ? 'revoked'
            : status === 'expired'
              ? 'expired'
              : 'not_verified',
    };
  }

  async registerHost(
    telegramId: bigint,
    url: unknown,
    now = new Date(),
  ): Promise<TutorialRegisterResult> {
    const addr = normalizeHostInput(url);
    const all = await this.accounts.memberships(telegramId);
    const existing = (await this.findHosts(all, addr)).find((f) =>
      MANAGE_ROLES.has(f.m.role),
    );
    if (existing) {
      const status = await this.hostStatus(telegramId, url, now);
      return {
        ...status,
        hostId: existing.host.id,
        siteId: existing.host.siteId,
        created: false,
        accountCreated: false,
      };
    }
    // Кабинет: СВОЙ (владелец), иначе тот, где человек менеджер; нет
    // такого — как при первом входе в TMA помощника (последний, куда
    // добавили, иначе новый; advisory-lock по telegramId — там же).
    // Свой — первым (аудит Ш1): членства идут «последний добавленный —
    // первым», и менеджер чужого кабинета, у которого есть и свой, иначе
    // заводил бы личный сайт из генератора в кабинет клиента — владелец
    // того кабинета видел бы чужой сайт, а подтверждение владения жило бы
    // там, откуда человека могут убрать.
    let membership =
      all.find((m) => m.role === 'owner') ??
      all.find((m) => MANAGE_ROLES.has(m.role));
    let accountCreated = false;
    if (!membership) {
      const ensured = await this.accounts.ensureAccount({
        app: 'assist',
        telegramId,
        username: null,
        firstName: null,
        languageCode: null,
      });
      membership = ensured.membership;
      accountCreated = ensured.created;
    }
    if (!MANAGE_ROLES.has(membership.role)) {
      throw siteCoreError(
        ForbiddenException,
        'ACCOUNT_ROLE_REQUIRED',
        'В кабинете сайтов вы оператор — добавить сайт может владелец или менеджер',
      );
    }
    const host = await this.addToAccount(membership, addr, url);
    const status = await this.hostStatus(telegramId, url, now);
    this.logger.log(
      `обучалка: хост заведён в кабинет ${membership.accountId}${accountCreated ? ' (кабинет создан)' : ''}`,
    );
    return {
      ...status,
      hostId: host.id,
      siteId: host.siteId,
      created: true,
      accountCreated,
    };
  }

  /** Сайт того же регистрируемого домена в кабинете — хост к нему, иначе новый сайт. */
  private async addToAccount(
    m: AccountMembership,
    addr: HostAddress,
    url: unknown,
  ): Promise<{ id: string; siteId: string }> {
    const db = this.db.forAccount(m.accountId);
    const domain = registrableDomain(addr.host);
    const rows = await db.siteHost.findMany({
      select: { host: true, siteId: true },
      orderBy: { createdAt: 'asc' },
    });
    const sibling = domain
      ? rows.find((r) => registrableDomain(r.host) === domain)
      : undefined;
    try {
      if (sibling) {
        const view = await this.sites.addHost(m, sibling.siteId, String(url));
        return { id: view.id, siteId: view.siteId };
      }
      const site = await this.sites.createSite(m, {
        name: domain ?? addr.host,
        url: String(url),
      });
      return { id: site.hosts[0].id, siteId: site.id };
    } catch (e) {
      // Гонка двух нажатий: хост уже есть — отдаём его, а не 409.
      const again = await db.siteHost.findFirst({
        where: { scheme: addr.scheme, host: addr.host, port: addr.port },
      });
      if (again) return { id: again.id, siteId: again.siteId };
      throw e;
    }
  }

  private async findHosts(
    memberships: AccountMembership[],
    addr: HostAddress,
  ): Promise<Array<{ m: AccountMembership; host: SiteHost }>> {
    const out: Array<{ m: AccountMembership; host: SiteHost }> = [];
    for (const m of memberships) {
      const host = await this.db.forAccount(m.accountId).siteHost.findFirst({
        where: { scheme: addr.scheme, host: addr.host, port: addr.port },
      });
      if (host) out.push({ m, host });
    }
    return out;
  }

  private async isOptedOut(host: string): Promise<boolean> {
    const hit = await this.db.guarded.siteOptOutDomain.findFirst({
      where: { domain: { in: optOutCandidates(host) } },
    });
    return !!hit;
  }
}
