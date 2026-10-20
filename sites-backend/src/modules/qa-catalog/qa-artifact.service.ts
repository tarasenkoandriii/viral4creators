import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { BrowserArtifactStorage } from '../browser-jobs/artifact-storage';
import { QaCatalogService } from './qa-catalog.service';
import {
  parseArtifactUpload,
  QA_ARTIFACT_TTL_MS,
  QA_ARTIFACT_PENDING_MS,
} from './qa-artifact-input';
@Injectable()
export class QaArtifactStorage extends BrowserArtifactStorage {
  async read(pathname: string): Promise<Buffer> {
    const result = await get(pathname, {
      access: 'private',
      token: this.token(),
      useCache: false,
      abortSignal: AbortSignal.timeout(15000),
    });
    if (
      !result ||
      result.statusCode !== 200 ||
      result.blob.size > 2 * 1024 * 1024
    )
      throw new Error('Private PNG unavailable');
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Private PNG too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  override async put(
    pathname: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    await put(pathname, bytes, {
      token: this.token(),
      access: 'private',
      contentType,
      allowOverwrite: false,
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      abortSignal: AbortSignal.timeout(60000),
    });
  }
}
const missing = () =>
  new NotFoundException({
    code: 'QA_ARTIFACT_NOT_FOUND',
    message: 'Доказательство не найдено или срок хранения истёк.',
  });
const conflict = () =>
  new ConflictException({
    code: 'QA_ARTIFACT_CONFLICT',
    message:
      'Загрузка уже выполняется или ключ использован для другого файла. Обновите список.',
  });
const metadata = (row: {
  id: string;
  findingRevision: number;
  sha256: string;
  bytes: number;
  expiresAt: Date;
  createdAt: Date;
}) => ({
  id: row.id,
  findingRevision: row.findingRevision,
  sha256: row.sha256,
  bytes: row.bytes,
  contentType: 'image/png',
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});
@Injectable()
export class QaArtifactService {
  constructor(
    private readonly catalog: QaCatalogService,
    private readonly db: SitesDb,
    private readonly storage: QaArtifactStorage,
  ) {}
  private async scoped(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    write = false,
  ) {
    const db = await this.catalog.scoped(m, siteId, write);
    if (
      !(await db.qaFinding.findFirst({
        where: { id: findingId, accountId: m.accountId, siteId },
        select: { id: true },
      }))
    )
      throw missing();
    return db;
  }
  async list(m: AccountMembership, siteId: string, findingId: string) {
    const db = await this.scoped(m, siteId, findingId);
    const rows = await db.qaArtifact.findMany({
      where: {
        accountId: m.accountId,
        siteId,
        findingId,
        state: 'ready',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return { items: rows.map(metadata) };
  }
  async upload(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    input: unknown,
  ) {
    const db = await this.scoped(m, siteId, findingId, true);
    const body = parseArtifactUpload(input),
      sha256 = createHash('sha256').update(body.bytes).digest('hex');
    const now = new Date(),
      artifactId = randomUUID();
    if (
      ![m.accountId, siteId, findingId].every((v) =>
        /^[A-Za-z0-9_-]{1,64}$/.test(v),
      )
    )
      throw missing();
    const row = await db.$transaction(async (tx) => {
      // Serialize quota reservations across this account, including concurrent uploads.
      await tx.$queryRaw`SELECT "id" FROM "sites"."site_accounts" WHERE "id"=${m.accountId} FOR UPDATE`;
      const existing = await tx.qaArtifact.findFirst({
        where: { accountId: m.accountId, siteId, requestId: body.requestId },
      });
      if (existing) {
        if (
          existing.findingId !== findingId ||
          existing.sha256 !== sha256 ||
          existing.expiresAt <= now ||
          existing.state !== 'ready'
        )
          throw conflict();
        return { row: existing, replayed: true };
      }
      const finding = await tx.qaFinding.findFirst({
        where: { id: findingId, accountId: m.accountId, siteId },
        select: { revision: true },
      });
      if (!finding) throw missing();
      const count = await tx.qaArtifact.count({
        where: { accountId: m.accountId, siteId, findingId },
      });
      const total = await tx.qaArtifact.aggregate({
        where: { accountId: m.accountId },
        _sum: { bytes: true },
        _count: { id: true },
      });
      if (
        count >= 10 ||
        total._count.id >= 1000 ||
        (total._sum.bytes ?? 0) + body.bytes.length > 100 * 1024 * 1024
      )
        throw new BadRequestException({
          code: 'QA_ARTIFACT_QUOTA',
          message:
            'Лимит: 10 файлов на замечание, 1000 файлов и 100 МБ на кабинет. Удалите ненужные доказательства.',
        });
      const created = await tx.qaArtifact.create({
        data: {
          id: artifactId,
          accountId: m.accountId,
          siteId,
          findingId,
          findingRevision: finding.revision,
          requestId: body.requestId,
          pathname: `qa-evidence/${m.accountId}/${siteId}/${artifactId}.png`,
          sha256,
          bytes: body.bytes.length,
          createdByMemberId: m.memberId,
          expiresAt: new Date(now.getTime() + QA_ARTIFACT_PENDING_MS),
        },
      });
      return { row: created, replayed: false };
    });
    if (row.replayed) return { ...metadata(row.row), replayed: true };
    try {
      await this.storage.put(row.row.pathname, body.bytes, 'image/png');
      const ready = await db.qaArtifact.update({
        where: { id: row.row.id, accountId: m.accountId },
        data: {
          state: 'ready',
          expiresAt: new Date(Date.now() + QA_ARTIFACT_TTL_MS),
        },
      });
      return { ...metadata(ready), replayed: false };
    } catch {
      // A committed DB update with a lost response is success, not permission to delete its bytes.
      let saved;
      try {
        saved = await db.qaArtifact.findFirst({
          where: { id: row.row.id, accountId: m.accountId },
        });
      } catch {
        throw new ServiceUnavailableException({
          code: 'QA_ARTIFACT_UPLOAD_UNKNOWN',
          message:
            'Статус загрузки пока неизвестен. Обновите список; повторный файл не создавайте.',
        });
      }
      if (saved?.state === 'ready')
        return { ...metadata(saved), replayed: true };
      // If cleanup fails, keep the reservation so retention can retry; never lose its pathname.
      try {
        await this.storage.remove(row.row.pathname);
        // Keep the reservation until expiry: an aborted remote upload may still settle late.
      } catch {
        /* bounded retention retry */
      }
      throw new ServiceUnavailableException({
        code: 'QA_ARTIFACT_UPLOAD_FAILED',
        message:
          'Не удалось сохранить доказательство. Обновите список перед повтором.',
      });
    }
  }
  async download(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    id: string,
  ) {
    const db = await this.scoped(m, siteId, findingId);
    const row = await db.qaArtifact.findFirst({
      where: {
        id,
        accountId: m.accountId,
        siteId,
        findingId,
        state: 'ready',
        expiresAt: { gt: new Date() },
      },
    });
    if (!row) throw missing();
    const validUntil = new Date(
      Math.min(Date.now() + 5 * 60000, row.expiresAt.getTime()),
    );
    return {
      url: await this.storage.signedUrl(row.pathname, validUntil),
      validUntil,
    };
  }

  /** Authenticated, non-cacheable content for local report generation; no browser Blob CORS. */
  async content(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    id: string,
  ) {
    const db = await this.scoped(m, siteId, findingId);
    const where = {
      id,
      accountId: m.accountId,
      siteId,
      findingId,
      state: 'ready',
      expiresAt: { gt: new Date() },
    };
    const row = await db.qaArtifact.findFirst({ where });
    if (!row) throw missing();
    let bytes: Buffer;
    try {
      bytes = await this.storage.read(row.pathname);
    } catch {
      throw new ServiceUnavailableException({
        code: 'QA_ARTIFACT_READ_FAILED',
        message: 'Не удалось прочитать приватный PNG.',
      });
    }
    if (
      bytes.length !== row.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      throw new ServiceUnavailableException({
        code: 'QA_ARTIFACT_INTEGRITY',
        message: 'Проверка доказательства не пройдена.',
      });
    if (
      !(await db.qaArtifact.findFirst({
        where: { ...where, expiresAt: { gt: new Date() } },
      }))
    )
      throw missing();
    return { ...metadata(row), contentBase64: bytes.toString('base64') };
  }
  async remove(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    id: string,
  ) {
    const db = await this.scoped(m, siteId, findingId, true);
    const row = await db.qaArtifact.findFirst({
      where: { id, accountId: m.accountId, siteId, findingId },
    });
    if (!row) throw missing();
    if (row.state === 'pending' && row.expiresAt > new Date()) throw conflict();
    await this.storage.remove(row.pathname);
    await db.qaArtifact.deleteMany({
      where: { id, accountId: m.accountId, siteId, findingId },
    });
    return { deleted: true };
  }
  async retain(now = new Date()) {
    const db = this.db.system(
      'QA artifact expiry: remove private bytes before metadata',
    );
    let scanned = 0,
      removed = 0,
      errors = 0,
      after = '';
    for (let page = 0; page < 10; page++) {
      const rows = await db.qaArtifact.findMany({
        where: { expiresAt: { lte: now }, id: { gt: after } },
        orderBy: { id: 'asc' },
        take: 200,
      });
      for (const row of rows) {
        scanned++;
        after = row.id;
        try {
          await this.storage.remove(row.pathname);
          await db.qaArtifact.deleteMany({
            where: {
              id: row.id,
              accountId: row.accountId,
              expiresAt: { lte: now },
            },
          });
          removed++;
        } catch {
          errors++;
        }
      }
      if (rows.length < 200) break;
    }
    if (errors)
      throw new ServiceUnavailableException({
        code: 'QA_ARTIFACT_RETENTION_PARTIAL',
        message: 'Часть файлов не удалена; следующий запуск повторит очистку.',
        details: { scanned, removed, errors },
      });
    if (
      await db.qaArtifact.findFirst({
        where: { expiresAt: { lte: now } },
        select: { id: true },
      })
    )
      throw new ServiceUnavailableException({
        code: 'QA_ARTIFACT_RETENTION_BACKLOG',
        message: 'Очистка не завершена; следующий запуск продолжит обработку.',
        details: { scanned, removed, errors },
      });
    return { scanned, removed, errors };
  }
}
