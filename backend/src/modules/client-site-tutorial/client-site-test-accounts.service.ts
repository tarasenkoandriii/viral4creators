/**
 * Экран «Тестовые учётные записи» в TMA генератора (Э-С Ш2) — мастер
 * обучалки по сайту заказчика.
 *
 *  - **режим A** (сайт черновика подтверждён в кабинете, где человек
 *    владелец или менеджер) — реестр учёток сайта в sites-backend, тот же,
 *    что видит QA-TMA и TMA помощника: список, завести, изменить, «Забыть»;
 *    роли, пакеты, хосты, продукты (обучалка/QA). Пароль — только на запись.
 *  - **режим B** — личные записи пользователя по сайту черновика: список,
 *    подпись, «Забыть». Заводятся сами при входе в мастере (`/login`).
 *
 * Хранилище не включено (`SITE_TUTORIAL_CREDENTIALS_STORE` ≠ `sites` или
 * нет канала в sites-backend) — экран честно говорит, что данные входа
 * лежат в черновике, как до Ш2.
 */
import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PROJECT_NOT_FOUND } from '../../common/user-facing-errors';
import {
  SitesInternalClient,
  SitesRejectedError,
  SitesTestAccount,
  SitesTestAccountInput,
  SitesUserSession,
  sitesTelegramId,
} from '../sites-internal/sites-internal.client';
import { credentialsStoreMode, ownerRefOf } from './draft-secrets-store';

export interface TestAccountsView {
  /** `off` — хранилище не включено: данные входа в черновике. */
  store: 'on' | 'off';
  mode: 'A' | 'B';
  /** Черновика ещё нет — нечего показывать (сайт не выбран). */
  hasDraft: boolean;
  /** Режим A: учётки реестра сайта, хосты сайта. */
  accounts: SitesTestAccount[];
  hosts: Array<{ id: string; host: string; verified: boolean }>;
  /** Режим B: личные записи по сайту черновика. */
  sessions: SitesUserSession[];
  /** Какая запись — данные входа ЭТОГО черновика. */
  draftRecordId: string | null;
}

interface DraftRefs {
  id: string;
  baseUrl: string;
  siteMode: string | null;
  siteHostId: string | null;
  siteTestAccountId: string | null;
  userSiteSessionId: string | null;
}

const INPUT_KEYS = new Set([
  'label',
  'role',
  'plan',
  'username',
  'password',
  'loginMethod',
  'hostIds',
  'products',
  'lifetimeDays',
  'status',
  'confirmedTestAccount',
]);

/** Белый список полей — строгую проверку значений делает sites-backend. */
export function testAccountInput(body: unknown): SitesTestAccountInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('ожидается учётная запись');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!INPUT_KEYS.has(k)) {
      throw new BadRequestException(`лишнее поле «${k}»`);
    }
    // Пустой пароль — «не менять» (экран не знает и не показывает старый).
    if (k === 'password' && v === '') continue;
    out[k] = v;
  }
  return out as SitesTestAccountInput;
}

@Injectable()
export class ClientSiteTestAccountsService {
  /** Тесты подменяют env. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
  ) {}

  async view(userId: string, projectId: string): Promise<TestAccountsView> {
    const draft = await this.draftOf(userId, projectId);
    const empty: TestAccountsView = {
      store: this.storeOn() ? 'on' : 'off',
      mode: 'B',
      hasDraft: !!draft,
      accounts: [],
      hosts: [],
      sessions: [],
      draftRecordId: null,
    };
    if (!draft || !this.storeOn()) {
      return { ...empty, mode: draft?.siteMode === 'A' ? 'A' : 'B' };
    }
    const a = await this.modeA(userId, draft);
    if (a) {
      try {
        const list = await this.sites.listTestAccounts(a.telegramId, a.hostId);
        return {
          ...empty,
          mode: 'A',
          accounts: list.accounts,
          hosts: list.hosts,
          draftRecordId: draft.siteTestAccountId,
        };
      } catch (err) {
        // Кабинет не даёт (роль, хост не его) — личные записи, как в B.
        if (!(err instanceof SitesRejectedError)) throw this.mapError(err);
      }
    }
    try {
      const { sessions } = await this.sites.listUserSessions(
        ownerRefOf(userId),
      );
      return {
        ...empty,
        mode: 'B',
        sessions: sessions.filter((s) => s.origin === draft.baseUrl),
        draftRecordId: draft.userSiteSessionId,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** Режим A: завести учётку в реестре сайта черновика. */
  async create(
    userId: string,
    projectId: string,
    body: unknown,
  ): Promise<SitesTestAccount> {
    const input = testAccountInput(body);
    const a = await this.requireA(userId, projectId);
    try {
      return await this.sites.upsertTestAccount(a.telegramId, {
        hostId: a.hostId,
        account: {
          products: ['tutorial'],
          ...input,
          hostIds: input.hostIds?.length ? input.hostIds : [a.hostId],
        },
      });
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async update(
    userId: string,
    projectId: string,
    id: string,
    body: unknown,
  ): Promise<SitesTestAccount | SitesUserSession> {
    const draft = await this.requireDraft(userId, projectId);
    const a = await this.modeA(userId, draft);
    try {
      if (a) {
        return await this.sites.upsertTestAccount(a.telegramId, {
          hostId: a.hostId,
          testAccountId: id,
          account: testAccountInput(body),
        });
      }
      const label = (body as { label?: unknown } | null)?.label;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some((k) => k !== 'label') ||
        (label !== null && typeof label !== 'string')
      ) {
        throw new BadRequestException(
          'у личной записи меняется только подпись',
        );
      }
      return await this.sites.updateUserSession(
        ownerRefOf(userId),
        id,
        (label as string | null) ?? null,
      );
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** «Забыть»: учётка реестра (A) или личная запись (B) — вместе с секретами. */
  async remove(
    userId: string,
    projectId: string,
    id: string,
  ): Promise<{ deleted: boolean }> {
    const draft = await this.requireDraft(userId, projectId);
    const a = await this.modeA(userId, draft);
    let deleted: boolean;
    try {
      deleted =
        a && draft.userSiteSessionId !== id
          ? (await this.sites.deleteTestAccount(a.telegramId, id)).deleted !==
            false
          : (await this.sites.deleteUserSession(ownerRefOf(userId), id))
              .deleted;
    } catch (err) {
      throw this.mapError(err);
    }
    // Забыли данные входа ЭТОГО черновика — ссылка больше никуда не ведёт.
    if (draft.siteTestAccountId === id || draft.userSiteSessionId === id) {
      await this.prisma.clientSiteTutorialDraft.updateMany({
        where: { id: draft.id },
        data: {
          ...(draft.siteTestAccountId === id
            ? { siteTestAccountId: null }
            : {}),
          ...(draft.userSiteSessionId === id
            ? { userSiteSessionId: null }
            : {}),
          storeHasCredentials: false,
        },
      });
    }
    return { deleted };
  }

  // ── внутреннее ──

  private storeOn(): boolean {
    return (
      credentialsStoreMode(this.env) === 'sites' && this.sites.configured()
    );
  }

  private async draftOf(
    userId: string,
    projectId: string,
  ): Promise<DraftRefs | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!project) throw new NotFoundException(PROJECT_NOT_FOUND);
    if (project.type !== 'CLIENT_SITE') {
      throw new BadRequestException(
        'обучалка по сайту доступна только в проектах типа «сайт заказчика»',
      );
    }
    return (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
      select: {
        id: true,
        baseUrl: true,
        siteMode: true,
        siteHostId: true,
        siteTestAccountId: true,
        userSiteSessionId: true,
      },
    })) as DraftRefs | null;
  }

  private async requireDraft(
    userId: string,
    projectId: string,
  ): Promise<DraftRefs> {
    const d = await this.draftOf(userId, projectId);
    if (!d) throw new NotFoundException('черновик обучалки ещё не начат');
    if (!this.storeOn()) {
      throw new ServiceUnavailableException(
        'хранилище учётных записей не подключено — данные входа хранятся в черновике',
      );
    }
    return d;
  }

  private async requireA(
    userId: string,
    projectId: string,
  ): Promise<{ telegramId: string; hostId: string }> {
    const a = await this.modeA(
      userId,
      await this.requireDraft(userId, projectId),
    );
    if (!a) {
      throw new BadRequestException(
        'учётки реестра — для подтверждённого сайта (режим A); здесь сохраняется ваш вход в мастере',
      );
    }
    return a;
  }

  private async modeA(
    userId: string,
    d: DraftRefs,
  ): Promise<{ telegramId: string; hostId: string } | null> {
    if (d.siteMode !== 'A' || !d.siteHostId) return null;
    const u = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    })) as { telegramId: string | null } | null;
    const telegramId = sitesTelegramId(u?.telegramId);
    return telegramId ? { telegramId, hostId: d.siteHostId } : null;
  }

  private mapError(err: unknown): Error {
    if (err instanceof HttpException) return err;
    if (err instanceof SitesRejectedError) {
      return new HttpException(
        { error: err.code, code: err.code, message: err.message },
        err.status,
      );
    }
    if (
      err instanceof Error &&
      /^Sites(NotConfigured|Unavailable)Error$/.test(err.name)
    ) {
      return new ServiceUnavailableException(
        'кабинет сайтов сейчас не отвечает — повторите через минуту',
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
