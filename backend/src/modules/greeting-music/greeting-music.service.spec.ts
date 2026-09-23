/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@vercel/blob', () => ({ head: jest.fn() }));
jest.mock('axios');

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { head } from '@vercel/blob';
import axios from 'axios';
import { GreetingMusicService } from './greeting-music.service';
import type { PlatformSettingsService } from '../../common/platform-settings.service';
import type { SessionService } from '../../common/session.service';
import type { BlobService } from '../storage/blob.service';
import type { AudioService } from '../audio/audio.service';

const CATALOG = JSON.stringify([
  { id: 'common', title: 'Общая', url: 'https://blob.test/common.mp3' },
  {
    id: 'party',
    title: 'Праздничная',
    url: 'https://blob.test/party.mp3',
    occasions: ['BIRTHDAY'],
  },
]);

function build(
  over: {
    raw?: string | null;
    snapshot?: Record<string, unknown>;
    tracks?: unknown[];
    audioEnabled?: boolean;
  } = {},
) {
  const get = jest
    .fn()
    .mockResolvedValue(over.raw === undefined ? CATALOG : over.raw);
  const updateSession = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    getSession: jest.fn().mockResolvedValue({
      sessionId: 's1',
      greetingBriefSnapshot: {
        occasion: 'BIRTHDAY',
        recipientName: 'Аня',
        ...over.snapshot,
      },
    }),
    updateSession,
  };
  const createUploadUrl = jest
    .fn()
    .mockResolvedValue({ uploadUrl: 'https://blob.test/put' });
  const uploadBuffer = jest
    .fn()
    .mockResolvedValue({ url: 'https://blob.test/library.mp3' });
  const candidates = jest.fn().mockResolvedValue(over.tracks ?? []);
  const audio = {
    enabled: over.audioEnabled ?? true,
    candidates,
    downloadUrl: jest.fn((t: any) => Promise.resolve(t.audioUrl)),
  };
  const svc = new GreetingMusicService(
    { get } as unknown as PlatformSettingsService,
    sessions as unknown as SessionService,
    { createUploadUrl, uploadBuffer } as unknown as BlobService,
    audio as unknown as AudioService,
  );
  return { svc, updateSession, get, createUploadUrl, uploadBuffer, candidates };
}

describe('GreetingMusicService (фича №4)', () => {
  it('показывает только темы, подходящие поводу сессии', async () => {
    const view = await build().svc.get('s1');
    expect(view.themes.map((t) => t.id)).toEqual(['common', 'party']);
    const condolence = await build({
      snapshot: { occasion: 'CONDOLENCE' },
    }).svc.get('s1');
    expect(condolence.themes.map((t) => t.id)).toEqual(['common']);
  });

  it('каталог пуст — пустой список, а не ошибка: фича выключена, ролик собирается', async () => {
    const view = await build({ raw: null }).svc.get('s1');
    expect(view.themes).toEqual([]);
    expect(view.selected).toBeNull();
  });

  it('выбранная тема ложится в снимок КОПИЕЙ, а не id', async () => {
    // Каталог правится из админки: ссылка по id тихо поменяла бы
    // музыку уже собранного ролика.
    const { svc, updateSession } = build();
    const view = await svc.select('s1', 'party');
    expect(view.selected).toEqual({
      id: 'party',
      title: 'Праздничная',
      url: 'https://blob.test/party.mp3',
    });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Аня',
        musicTheme: view.selected,
      }),
    });
  });

  it('тема не для этого повода — 404, а не тихое «ничего не выбрали»', async () => {
    // Иначе пользователь увидел бы «сохранено» и получил ролик без
    // музыки — или, хуже, фанфары под соболезнованием.
    const { svc, updateSession } = build({
      snapshot: { occasion: 'CONDOLENCE' },
    });
    await expect(svc.select('s1', 'party')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('неизвестная тема — тоже 404', async () => {
    const { svc } = build();
    await expect(svc.select('s1', 'нет-такой')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('null снимает подложку и не трогает остальной снимок', async () => {
    const { svc, updateSession } = build({
      snapshot: {
        musicTheme: { id: 'party', title: 'П', url: 'https://blob.test/p.mp3' },
      },
    });
    const view = await svc.select('s1', null);
    expect(view.selected).toBeNull();
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Аня',
        musicTheme: null,
      }),
    });
  });

  it('не поздравительная сессия — 404', async () => {
    const { svc } = build({ snapshot: undefined });
    const broken = new GreetingMusicService(
      { get: jest.fn() } as unknown as PlatformSettingsService,
      {
        getSession: jest.fn().mockResolvedValue({ sessionId: 's1' }),
      } as unknown as SessionService,
      {} as unknown as BlobService,
      {} as unknown as AudioService,
    );
    void svc;
    await expect(broken.get('s1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GreetingMusicService — своя музыка', () => {
  const mockedHead = head as unknown as jest.Mock;

  beforeEach(() => {
    mockedHead.mockReset();
    mockedHead.mockResolvedValue({ url: 'https://blob.test/track.mp3' });
  });

  const confirm = {
    pathname: 'sessions/s1/music/mt_abc123.mp3',
    title: 'Наша песня',
    rightsConfirmed: true,
  };

  it('путь загрузки лежит под префиксом сессии — файл уедет вместе с ней', async () => {
    const { svc, createUploadUrl } = build();
    const target = await svc.createUploadUrl('s1', {
      fileName: 'song.mp3',
      fileSize: 1024,
      mimeType: 'audio/mpeg',
    });
    expect(target.pathname).toMatch(/^sessions\/s1\/music\/mt_[0-9a-f]+\.mp3$/);
    expect(createUploadUrl).toHaveBeenCalledWith(
      target.pathname,
      'audio/mpeg',
      expect.any(Number),
    );
  });

  it('расширение берётся из типа файла, а не из имени', async () => {
    const { svc } = build();
    const wav = await svc.createUploadUrl('s1', {
      fileName: 'song.mp3',
      fileSize: 1024,
      mimeType: 'audio/wav',
    });
    expect(wav.pathname.endsWith('.wav')).toBe(true);
  });

  it('подтверждённый файл ложится в снимок как своя музыка', async () => {
    const { svc, updateSession } = build();
    const view = await svc.confirmUpload('s1', confirm);
    expect(view.selected).toEqual(
      expect.objectContaining({
        id: 'mt_abc123',
        title: 'Наша песня',
        url: 'https://blob.test/track.mp3',
        source: 'upload',
        pathname: confirm.pathname,
      }),
    );
    expect(view.selected?.rightsConfirmedAt).toBeTruthy();
    expect(updateSession).toHaveBeenCalled();
  });

  it('без подтверждения прав трек в ролик не попадает', async () => {
    // Готовый ролик человек отправляет другому человеку: чужая
    // фонограмма в нём — это распространение, а не прослушивание.
    const { svc, updateSession } = build();
    await expect(
      svc.confirmUpload('s1', { ...confirm, rightsConfirmed: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('чужой путь не приписывается своей сессии', async () => {
    const { svc, updateSession } = build();
    await expect(
      svc.confirmUpload('s1', {
        ...confirm,
        pathname: 'sessions/s2/music/mt_abc123.mp3',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateSession).not.toHaveBeenCalled();
    expect(mockedHead).not.toHaveBeenCalled();
  });

  it('файла в хранилище нет — внятный отказ, а не молчаливая подложка-пустышка', async () => {
    mockedHead.mockRejectedValue(new Error('not found'));
    const { svc, updateSession } = build();
    await expect(svc.confirmUpload('s1', confirm)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('пустое название не даёт безымянной подложки', async () => {
    const { svc } = build();
    const view = await svc.confirmUpload('s1', { ...confirm, title: '   ' });
    expect(view.selected?.title).toBeTruthy();
  });

  it('своя музыка не зависит от каталога — работает и при пустом', async () => {
    // Каталог платформы может быть не наполнен вовсе: своя музыка
    // должна работать и тогда.
    const { svc } = build({ raw: null });
    const view = await svc.confirmUpload('s1', confirm);
    expect(view.themes).toEqual([]);
    expect(view.selected?.source).toBe('upload');
  });
});

describe('GreetingMusicService — ссылка на трек', () => {
  const link = {
    url: 'https://cdn.example.com/track.mp3',
    title: 'Наша песня',
    rightsConfirmed: true,
  };

  it('ссылка ложится в снимок без файла у нас', async () => {
    const { svc, updateSession } = build();
    const view = await svc.selectLink('s1', link);
    expect(view.selected).toEqual(
      expect.objectContaining({
        title: 'Наша песня',
        url: link.url,
        source: 'link',
      }),
    );
    // Удалять при чистке сессии нечего — файла у нас не появилось.
    expect(view.selected).not.toHaveProperty('pathname');
    expect(updateSession).toHaveBeenCalled();
  });

  it('одна и та же ссылка даёт один и тот же id', async () => {
    // Повторный ввод не должен плодить разные записи одного трека.
    const first = await build().svc.selectLink('s1', link);
    const second = await build().svc.selectLink('s1', link);
    expect(first.selected?.id).toBe(second.selected?.id);
    const other = await build().svc.selectLink('s1', {
      ...link,
      url: 'https://cdn.example.com/other.mp3',
    });
    expect(other.selected?.id).not.toBe(first.selected?.id);
  });

  it('без подтверждения прав ссылка не принимается', async () => {
    const { svc, updateSession } = build();
    await expect(
      svc.selectLink('s1', { ...link, rightsConfirmed: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('негодная ссылка отвергается до записи', async () => {
    const { svc, updateSession } = build();
    for (const url of [
      'http://cdn.example.com/t.mp3',
      'https://localhost/t.mp3',
      'https://user:pass@cdn.example.com/t.mp3',
      'не ссылка',
    ]) {
      await expect(
        svc.selectLink('s1', { ...link, url }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('права проверяются раньше ссылки — сначала главное', async () => {
    const { svc } = build();
    await expect(
      svc.selectLink('s1', {
        url: 'мусор',
        title: 'X',
        rightsConfirmed: false,
      }),
    ).rejects.toThrow(/вправе использовать/);
  });
});

describe('GreetingMusicService — библиотека со свободной лицензией', () => {
  beforeEach(() => {
    (axios.get as unknown as jest.Mock).mockReset();
    (axios.get as unknown as jest.Mock).mockResolvedValue({
      status: 200,
      data: Buffer.from([1, 2, 3]),
    });
  });

  const cc0 = {
    provider: 'freesound',
    providerTrackId: '7',
    kind: 'music',
    title: 'Тёплое утро',
    artist: 'Аноним',
    durationSec: 40,
    mood: [],
    genre: [],
    tags: [],
    previewUrl: 'https://freesound.test/p.mp3',
    audioUrl: 'https://freesound.test/p.mp3',
    license: {
      type: 'CC0-1.0',
      commercialUse: true,
      attributionRequired: false,
    },
  };
  const ccBy = {
    ...cc0,
    providerTrackId: '8',
    license: {
      type: 'CC-BY-4.0',
      commercialUse: true,
      attributionRequired: true,
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    },
  };

  it('пустой запрос до провайдеров не доходит', async () => {
    const { svc, candidates } = build({ tracks: [cc0] });
    const view = await svc.searchLibrary('s1', '   ');
    expect(view.library).toEqual([]);
    expect(candidates).not.toHaveBeenCalled();
  });

  it('библиотека не настроена — экран об этом знает', async () => {
    const { svc } = build({ audioEnabled: false });
    const view = await svc.searchLibrary('s1', 'тёплое');
    expect(view.libraryEnabled).toBe(false);
    expect(view.library).toEqual([]);
  });

  it('запрос требует коммерческой лицензии и отвергает платные', async () => {
    // Поздравление делается в платном продукте и уходит другому
    // человеку: некоммерческая лицензия этого не покрывает, а трек
    // «можно после покупки» без покупки использовать нельзя.
    const { svc, candidates } = build({ tracks: [cc0] });
    await svc.searchLibrary('s1', 'тёплое');
    expect(candidates).toHaveBeenCalledWith(
      expect.objectContaining({
        commercialUseRequired: true,
        allowPaidLicense: false,
        allowAttribution: true,
      }),
    );
  });

  it('в выдачу уходит лицензия и строка упоминания', async () => {
    const { svc } = build({ tracks: [ccBy] });
    const view = await svc.searchLibrary('s1', 'тёплое');
    expect(view.library?.[0].licenseType).toBe('CC-BY-4.0');
    expect(view.library?.[0].attribution).toContain('Тёплое утро');
  });

  it('у CC0 строки упоминания нет — она и не нужна', async () => {
    const { svc } = build({ tracks: [cc0] });
    const view = await svc.searchLibrary('s1', 'тёплое');
    expect(view.library?.[0].attribution).toBeNull();
  });

  it('выбранный трек скачивается К НАМ и несёт лицензию в снимок', async () => {
    // Ссылка провайдера живёт своей жизнью, превью Freesound отдаётся
    // по токену, а копия у себя — то, что можно предъявить.
    const { svc, uploadBuffer, updateSession } = build({ tracks: [ccBy] });
    const view = await svc.selectFromLibrary('s1', 'тёплое', 'freesound', '8');
    expect(uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^sessions\/s1\/music\/ml_[0-9a-f]+\.mp3$/),
      expect.any(Buffer),
      'audio/mpeg',
    );
    expect(view.selected).toEqual(
      expect.objectContaining({
        source: 'library',
        url: 'https://blob.test/library.mp3',
        licenseType: 'CC-BY-4.0',
      }),
    );
    expect(view.selected?.attribution).toContain('Тёплое утро');
    expect(updateSession).toHaveBeenCalled();
  });

  it('трек не из выдачи не скачивается', async () => {
    const { svc, uploadBuffer } = build({ tracks: [cc0] });
    await expect(
      svc.selectFromLibrary('s1', 'тёплое', 'freesound', 'чужой'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('библиотека не настроена — выбрать нечего, честный отказ', async () => {
    const { svc } = build({ audioEnabled: false });
    await expect(
      svc.selectFromLibrary('s1', 'тёплое', 'freesound', '7'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
