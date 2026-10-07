/**
 * Карточка «Обучалка по сайту: выключатель и суточные потолки» на
 * вкладке /settings (П-Т9, заход 7 — 07.10.2026).
 *
 * Тонкая обёртка над `PlatformSettingsService` и теми же ключами, что
 * читает `ClientSiteTutorialUsageService` (`client-site-tutorial-usage.
 * service.ts`): выключатель `site_tutorial_paused` и общие на ВСЕХ
 * пользователей суточные потолки раундов и живых сессий. Грамматика
 * чтения — та же, что у потребителя (`true/1/on/yes`; потолок — целое > 0,
 * иначе env, иначе умолчание кода): админка показывает ровно то, что
 * действует. Потребитель держит кэш 15 с — изменение доходит до тёплых
 * инстансов в течение 15 с, не мгновенно.
 *
 * «Пусто» = вернуть умолчание: пишется пустая строка, потребитель читает её
 * как «не задано». Ноль НЕ принимается: потребитель считает его «не
 * задано» и молча взял бы умолчание — остановить обучалку целиком можно
 * выключателем. Журнал — как у соседних настроек: кто и когда менял
 * (`PlatformSetting.updatedBy/updatedAt`) плюс строка в логе.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
  DEFAULT_GLOBAL_ROUNDS_PER_DAY,
  SETTINGS_CACHE_MS,
  SITE_TUTORIAL_GLOBAL_LIVE_KEY,
  SITE_TUTORIAL_GLOBAL_ROUNDS_KEY,
  SITE_TUTORIAL_PAUSED_KEY,
} from '../client-site-tutorial/client-site-tutorial-usage.service';

/** Верхняя граница — от опечатки на лишний ноль, не бизнес-правило. */
export const SITE_TUTORIAL_CAP_MAX = 1_000_000;

const KEYS = [
  SITE_TUTORIAL_PAUSED_KEY,
  SITE_TUTORIAL_GLOBAL_ROUNDS_KEY,
  SITE_TUTORIAL_GLOBAL_LIVE_KEY,
] as const;

/** Та же грамматика, что у потребителя: целое > 0, иначе «не задано». */
export function parseStoredCap(raw: string | null | undefined): number | null {
  const t = raw?.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parsePaused(raw: string | null | undefined): boolean {
  const t = raw?.trim().toLowerCase();
  return t === 'true' || t === '1' || t === 'on' || t === 'yes';
}

export function isValidSiteTutorialCap(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= SITE_TUTORIAL_CAP_MAX
  );
}

export interface SiteTutorialCapView {
  /** Действующий потолок. */
  value: number;
  /** Что задано в админке; `null` — не задано (действует env/код). */
  stored: number | null;
  /** Потолок без настройки админки: env, иначе умолчание кода. */
  defaultValue: number;
  source: 'admin' | 'env' | 'default';
  /** Расход за текущие UTC-сутки по всем пользователям; `null` — не прочитан. */
  usedToday: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SiteTutorialSettingsView {
  paused: boolean;
  pausedUpdatedAt: string | null;
  pausedUpdatedBy: string | null;
  rounds: SiteTutorialCapView;
  liveSessions: SiteTutorialCapView;
  /** UTC-сутки, за которые посчитан расход. */
  day: string;
  /** Через сколько секунд изменение доходит до всех инстансов. */
  cacheSeconds: number;
}

/** Не присланное не трогается; `null` у потолка — вернуть умолчание. */
export interface SetSiteTutorialSettingsInput {
  paused?: boolean;
  roundsPerDay?: number | null;
  liveSessionsPerDay?: number | null;
}

@Injectable()
export class AdminSiteTutorialSettingsService {
  private readonly logger = new Logger(AdminSiteTutorialSettingsService.name);
  /** Тесты подменяют env. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async view(now: Date = new Date()): Promise<SiteTutorialSettingsView> {
    // Мимо кэша `PlatformSettingsService`: оператор должен видеть то, что
    // записано, вместе с автором и временем.
    const rows = (await this.prisma.platformSetting.findMany({
      where: { key: { in: [...KEYS] } },
    })) as Array<{
      key: string;
      value: string;
      updatedAt: Date;
      updatedBy: string | null;
    }>;
    const row = (k: string) => rows.find((r) => r.key === k) ?? null;
    const day = now.toISOString().slice(0, 10);
    const used = await this.usedToday(day);
    const cap = (
      key: string,
      envName: string,
      codeDefault: number,
      usedToday: number | null,
    ): SiteTutorialCapView => {
      const r = row(key);
      const stored = parseStoredCap(r?.value);
      const fromEnv = parseStoredCap(this.env[envName]);
      const defaultValue = fromEnv ?? codeDefault;
      return {
        value: stored ?? defaultValue,
        stored,
        defaultValue,
        source:
          stored !== null ? 'admin' : fromEnv !== null ? 'env' : 'default',
        usedToday,
        updatedAt: r ? new Date(r.updatedAt).toISOString() : null,
        updatedBy: r?.updatedBy ?? null,
      };
    };
    const paused = row(SITE_TUTORIAL_PAUSED_KEY);
    return {
      paused: parsePaused(paused?.value),
      pausedUpdatedAt: paused ? new Date(paused.updatedAt).toISOString() : null,
      pausedUpdatedBy: paused?.updatedBy ?? null,
      rounds: cap(
        SITE_TUTORIAL_GLOBAL_ROUNDS_KEY,
        'SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY',
        DEFAULT_GLOBAL_ROUNDS_PER_DAY,
        used?.rounds ?? null,
      ),
      liveSessions: cap(
        SITE_TUTORIAL_GLOBAL_LIVE_KEY,
        'SITE_TUTORIAL_GLOBAL_LIVE_SESSIONS_PER_DAY',
        DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
        used?.live ?? null,
      ),
      day,
      cacheSeconds: Math.round(SETTINGS_CACHE_MS / 1000),
    };
  }

  /** Тот же счёт, что у потолка (`availability`), одним запросом на оба. */
  private async usedToday(
    day: string,
  ): Promise<{ rounds: number; live: number } | null> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ rounds: number | bigint | null; live: number | bigint | null }>
      >`
        SELECT COALESCE(SUM("rounds"), 0)::int AS "rounds",
               COALESCE(SUM("liveSessions"), 0)::int AS "live"
        FROM "client_site_tutorial_usage" WHERE "day" = ${day}
      `;
      return {
        rounds: Number(rows[0]?.rounds ?? 0),
        live: Number(rows[0]?.live ?? 0),
      };
    } catch (err) {
      this.logger.warn(
        `расход обучалки по сайту не прочитан (${(err as Error)?.name ?? 'Error'})`,
      );
      return null;
    }
  }

  async set(
    input: SetSiteTutorialSettingsInput,
    updatedBy: string,
  ): Promise<SiteTutorialSettingsView> {
    // Весь ввод проверяется до первой записи: половина сохранённого
    // запроса хуже отказа целиком.
    const writes: Array<[string, string]> = [];
    if (input.paused !== undefined) {
      if (typeof input.paused !== 'boolean') {
        throw new BadRequestException('Выключатель — true или false');
      }
      writes.push([SITE_TUTORIAL_PAUSED_KEY, input.paused ? 'true' : 'false']);
    }
    const caps: Array<[keyof SetSiteTutorialSettingsInput, string, string]> = [
      ['roundsPerDay', SITE_TUTORIAL_GLOBAL_ROUNDS_KEY, 'раундов'],
      ['liveSessionsPerDay', SITE_TUTORIAL_GLOBAL_LIVE_KEY, 'живых сессий'],
    ];
    for (const [field, key, label] of caps) {
      const v = input[field];
      if (v === undefined) continue;
      if (v === null) {
        writes.push([key, '']);
        continue;
      }
      if (!isValidSiteTutorialCap(v)) {
        throw new BadRequestException(
          `Суточный потолок ${label} — целое от 1 до ${SITE_TUTORIAL_CAP_MAX} или пусто (умолчание); остановить обучалку — выключателем`,
        );
      }
      writes.push([key, String(v)]);
    }
    for (const [key, value] of writes) {
      await this.settings.set(key, value, updatedBy);
      this.logger.log(
        `настройка ${key} = «${value || 'умолчание'}» (оператор ${updatedBy})`,
      );
    }
    return this.view();
  }
}
