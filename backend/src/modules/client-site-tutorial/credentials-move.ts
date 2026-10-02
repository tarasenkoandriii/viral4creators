/**
 * Перенос данных входа черновиков обучалки из колонок `credentialsEnc` /
 * `cookiesEnc` в хранилище sites-backend (Э-С Ш2; аудит слияния §3.2, Ш2:
 * «каждый черновик → учётка „как было“, расшифровать старым ключом,
 * зашифровать в хранилище, обнулить колонки»).
 *
 * «Как было» = ЛИЧНАЯ запись пользователя (режим B), даже если черновик
 * сейчас в режиме A: до Ш2 данные входа принадлежали только автору
 * черновика; перенос в реестр сайта показал бы их метаданные другим
 * менеджерам кабинета и открыл бы аренду для QA без согласия автора. Новые
 * данные входа черновика A после включения хранилища пойдут в реестр сами.
 *
 * Скрипт `backend/scripts/move-client-site-credentials.ts`: по умолчанию
 * dry-run (только читает и проверяет, что колонки расшифровываются), с
 * `--apply` — пишет. Идемпотентно: перенесённый черновик (есть ссылка на
 * запись хранилища) повторно не трогается; запись в хранилище — по ключу
 * черновика (`draft:<id>`), обрыв на середине и повтор не плодят записей.
 * Строка черновика обновляется условием «колонки не изменились»: черновик,
 * по которому прямо сейчас идёт раунд, пропускается до следующего прогона.
 *
 * Отчёт — только счётчики и id черновиков, без секретов и без доменов.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { decryptCookieJar } from '../../common/cookie-jar';
import { decryptCredentials } from './draft-credentials';
import type { DraftSecretsStore } from './draft-secrets-store';

export interface MoveReport {
  apply: boolean;
  /** Черновиков с данными в колонках и без ссылки на хранилище. */
  candidates: number;
  moved: number;
  /** dry-run: перенеслись бы. */
  wouldMove: number;
  /** Колонки не расшифровываются старым ключом — не трогаем, нужен разбор. */
  unreadable: string[];
  /** Ссылка на хранилище есть, а колонки не пусты — не трогаем. */
  conflicts: string[];
  /** Раунд изменил строку во время переноса — повторить прогон. */
  changed: string[];
  failed: Array<{ draftId: string; error: string }>;
}

interface Row {
  id: string;
  projectId: string;
  baseUrl: string;
  credentialsEnc: string | null;
  cookiesEnc: string | null;
  siteMode: string | null;
  siteHostId: string | null;
  siteTestAccountId: string | null;
  userSiteSessionId: string | null;
  project: { userId: string } | null;
}

export async function moveClientSiteCredentials(opts: {
  prisma: PrismaService;
  store: Pick<DraftSecretsStore, 'moveFromColumns' | 'userOf'>;
  /** Старый ключ колонок (`SITE_TUTORIAL_TOKEN_KEY`). */
  columnKey: string;
  apply: boolean;
  batch?: number;
  log?: (line: string) => void;
}): Promise<MoveReport> {
  const log = opts.log ?? (() => undefined);
  const report: MoveReport = {
    apply: opts.apply,
    candidates: 0,
    moved: 0,
    wouldMove: 0,
    unreadable: [],
    conflicts: [],
    changed: [],
    failed: [],
  };
  const take = opts.batch ?? 100;
  const seen = new Set<string>();
  const hasColumns = {
    OR: [{ credentialsEnc: { not: null } }, { cookiesEnc: { not: null } }],
  };

  for (;;) {
    const rows = (await opts.prisma.clientSiteTutorialDraft.findMany({
      where: { AND: [hasColumns, { id: { notIn: [...seen] } }] },
      select: {
        id: true,
        projectId: true,
        baseUrl: true,
        credentialsEnc: true,
        cookiesEnc: true,
        siteMode: true,
        siteHostId: true,
        siteTestAccountId: true,
        userSiteSessionId: true,
        project: { select: { userId: true } },
      },
      orderBy: { id: 'asc' },
      take,
    })) as Row[];
    if (rows.length === 0) break;

    for (const r of rows) {
      seen.add(r.id);
      if (r.siteTestAccountId || r.userSiteSessionId) {
        report.conflicts.push(r.id);
        continue;
      }
      report.candidates++;
      try {
        if (r.credentialsEnc)
          decryptCredentials(r.credentialsEnc, opts.columnKey);
        if (r.cookiesEnc) decryptCookieJar(r.cookiesEnc, opts.columnKey);
      } catch {
        report.unreadable.push(r.id);
        continue;
      }
      if (!r.project) {
        report.failed.push({ draftId: r.id, error: 'нет проекта' });
        continue;
      }
      if (!opts.apply) {
        report.wouldMove++;
        continue;
      }
      try {
        const user = await opts.store.userOf(r.project.userId);
        const { moved: _moved, ...patch } = await opts.store.moveFromColumns(
          user,
          r,
        );
        void _moved;
        const { count } = await opts.prisma.clientSiteTutorialDraft.updateMany({
          where: {
            id: r.id,
            credentialsEnc: r.credentialsEnc,
            cookiesEnc: r.cookiesEnc,
            siteTestAccountId: null,
            userSiteSessionId: null,
          },
          data: patch,
        });
        if (count === 1) {
          report.moved++;
          log(`перенесён черновик ${r.id}`);
        } else {
          report.changed.push(r.id);
        }
      } catch (err) {
        report.failed.push({
          draftId: r.id,
          error: err instanceof Error ? err.name : 'error',
        });
      }
    }
  }
  return report;
}
