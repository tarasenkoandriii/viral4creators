import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { head } from '@vercel/blob';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { activeRowImage } from '../../common/active-image';
import { readBodyWithLimit } from '../../common/external-url-guard';
import { parseNarratorPreamble, preambleMp4Seconds } from './narrator-preamble';
import { PreambleConfirmDto } from './dto/narrator-preamble.dto';

@Injectable()
export class NarratorPreambleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}
  private async own(userId: string, id: string) {
    const row = await this.prisma.brandManifest.findFirst({
      where: { id, userId },
      include: { characters: { include: { activeSketch: true } } },
    });
    if (!row) throw new NotFoundException('Бренд-бук не найден');
    return row;
  }
  async upload(userId: string, id: string) {
    await this.own(userId, id);
    const pathname = `brand-manifests/${id}/preamble-uploads/${randomUUID()}.mp4`;
    return {
      ...(await this.blob.createUploadUrl(
        pathname,
        'video/mp4',
        20 * 1024 * 1024,
      )),
      pathname,
    };
  }
  async confirm(userId: string, id: string, dto: PreambleConfirmDto) {
    const row = await this.own(userId, id);
    if (
      dto.approved !== true ||
      !dto.pathname.startsWith(`brand-manifests/${id}/preamble-uploads/`)
    )
      throw new BadRequestException('Подтвердите просмотр своей записи');
    const existing = parseNarratorPreamble(row.tutorialPreamble);
    if (
      existing?.sourcePathname === dto.pathname &&
      existing.locale === dto.locale
    )
      return existing;
    const meta = await head(dto.pathname);
    if (meta.size > 20 * 1024 * 1024 || meta.contentType !== 'video/mp4')
      throw new BadRequestException('Нужен MP4 до 20 МБ');
    const response = await fetch(meta.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new BadRequestException('Не удалось прочитать запись');
    const bytes = await readBodyWithLimit(response, 20 * 1024 * 1024);
    const seconds = preambleMp4Seconds(bytes);
    if (!seconds)
      throw new BadRequestException(
        'Нужен обычный MP4 со звуком и видео длительностью 5–10 секунд',
      );
    // The PUT token can overwrite its upload pathname until it expires.
    // Publish a separate content-addressed copy which no upload token can write.
    const pathname = `brand-manifests/${id}/preambles/${createHash('sha256').update(bytes).digest('hex')}.mp4`;
    const { url } = await this.blob.uploadBuffer(pathname, bytes, 'video/mp4');
    const character = row.characters.find(
      (c) => c.id === row.narratorCharacterId,
    );
    const value = {
      version: 1 as const,
      pathname,
      sourcePathname: dto.pathname,
      url,
      seconds,
      locale: dto.locale,
      approvedAt: new Date().toISOString(),
      manifestId: id,
      characterId: character?.id ?? null,
      imageUrl: character ? (activeRowImage(character)?.url ?? null) : null,
      voiceId: row.ttsVoiceId,
      voiceProvider: row.ttsProvider,
    };
    if (!parseNarratorPreamble(value))
      throw new BadRequestException('Запись имеет неподдерживаемый адрес');
    await this.prisma.brandManifest.update({
      where: { id },
      data: { tutorialPreamble: value as unknown as Prisma.InputJsonValue },
    });
    await this.blob.deleteBlob(dto.pathname).catch(() => undefined);
    return value;
  }
  async forProject(
    userId: string,
    projectId: string,
    locale: string,
    draftId?: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { brandManifestId: true },
    });
    if (!project?.brandManifestId)
      throw new BadRequestException(
        'Сначала привяжите бренд-бук с одобренной преамбулой',
      );
    const row = await this.own(userId, project.brandManifestId);
    const value = parseNarratorPreamble(row.tutorialPreamble);
    if (!value || value.locale !== locale)
      throw new BadRequestException(
        'В брендбуке нет одобренной преамбулы на языке обучалки',
      );
    if (!draftId) return value;
    // A finished tutorial owns its copy: deleting the brand must not let
    // sweep-orphans remove an intro still needed by tempo rebuilds.
    const pathname = `tutorial-video-frames/${draftId}/preamble-${value.pathname.split('/').pop()}`;
    const url = await this.blob.copyBlob(value.pathname, pathname, 'video/mp4');
    if (!url)
      throw new BadRequestException(
        'Не удалось сохранить преамбулу обучалки — повторите отправку',
      );
    const snapshot = { ...value, draftId, pathname, url };
    if (!parseNarratorPreamble(snapshot))
      throw new BadRequestException(
        'Копия преамбулы имеет неподдерживаемый адрес',
      );
    return snapshot;
  }
}
