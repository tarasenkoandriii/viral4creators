/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('axios');
jest.mock('../../config/configuration', () => ({
  loadConfiguration: jest.fn(() => ({ pixabay: { apiKey: 'test-key' } })),
}));

import axios from 'axios';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { GreetingStickerService } from './greeting-sticker.service';
import { loadConfiguration } from '../../config/configuration';
import type { SessionService } from '../../common/session.service';
import type { BlobService } from '../storage/blob.service';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedConfig = loadConfiguration as unknown as jest.Mock;

const HIT = {
  id: 101,
  previewURL: 'https://cdn.pixabay.com/x_150.png',
  largeImageURL: 'https://cdn.pixabay.com/x_1280.png',
  pageURL: 'https://pixabay.com/illustrations/x-101/',
  tags: 'конфетти',
};

function build(
  snapshot: Record<string, unknown> | null = {},
  opts: {
    beforeWrite?: (
      attempt: number,
      set: (patch: Record<string, unknown>) => void,
    ) => void;
  } = {},
) {
  let current: Record<string, unknown> | null =
    snapshot === null
      ? null
      : { occasion: 'BIRTHDAY', recipientName: 'Марина', ...snapshot };
  // «Параллельная» правка снимка из другого запроса — мимо сервиса.
  const set = (patch: Record<string, unknown>) => {
    current = { ...current, ...patch };
  };
  const updateSession = jest
    .fn()
    .mockImplementation((_id: string, patch: Record<string, any>) => {
      current = patch.greetingBriefSnapshot;
      return Promise.resolve(undefined);
    });
  const sessions = {
    getSession: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ sessionId: 's1', greetingBriefSnapshot: current }),
      ),
    updateSession,
  };
  const uploadBuffer = jest
    .fn()
    .mockResolvedValue({ url: 'https://blob.test/sticker.png' });
  const svc = new GreetingStickerService(
    sessions as unknown as SessionService,
    { uploadBuffer } as unknown as BlobService,
    fakeSnapshotDb(sessions, {
      beforeWrite: (n) => opts.beforeWrite?.(n, set),
    }) as any,
  );
  return { svc, updateSession, uploadBuffer, snapshotNow: () => current };
}

function searchOk(hits: unknown[] = [HIT]) {
  mockedAxios.get.mockImplementation((url: string) =>
    url.includes('pixabay.com/api')
      ? Promise.resolve({ status: 200, data: { hits } })
      : Promise.resolve({ status: 200, data: Buffer.from([1, 2, 3]) }),
  );
}

describe('GreetingStickerService (фича №8)', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedConfig.mockReturnValue({ pixabay: { apiKey: 'test-key' } });
  });

  it('без ключа выдача пуста и экран об этом знает', async () => {
    mockedConfig.mockReturnValue({ pixabay: { apiKey: '' } });
    const view = await build().svc.view('s1', 'конфетти');
    expect(view.configured).toBe(false);
    expect(view.results).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('пустой запрос в Pixabay не ходит', async () => {
    searchOk();
    const view = await build().svc.view('s1', '   ');
    expect(view.results).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('наружу уходит превью и страница источника, но не ссылка на скачивание', async () => {
    // Скачиваем мы сами: хотлинк Pixabay запрещает.
    searchOk();
    const view = await build().svc.view('s1', 'конфетти');
    expect(view.results[0]).toEqual({
      id: '101',
      previewUrl: HIT.previewURL,
      sourceUrl: HIT.pageURL,
      tags: 'конфетти',
    });
    expect(JSON.stringify(view.results)).not.toContain('x_1280');
  });

  it('повторный поиск берётся из кеша — этого требуют условия Pixabay', async () => {
    searchOk();
    const { svc } = build();
    await svc.view('s1', 'конфетти');
    await svc.view('s1', '  КОНФЕТТИ ');
    const searches = mockedAxios.get.mock.calls.filter((c) =>
      String(c[0]).includes('pixabay.com/api'),
    );
    expect(searches).toHaveLength(1);
  });

  it('сбой Pixabay даёт пустую выдачу, а не красный экран', async () => {
    // Без наклейки ролик всё равно получится.
    mockedAxios.get.mockRejectedValue(new Error('сеть'));
    const view = await build().svc.view('s1', 'конфетти');
    expect(view.results).toEqual([]);
    expect(view.configured).toBe(true);
  });

  it('выбранная наклейка скачивается К НАМ и в снимок идёт наш URL', async () => {
    // «permanent hotlinking of images is not allowed… download them to
    // your server first» — условия Pixabay.
    searchOk();
    const { svc, uploadBuffer, updateSession } = build();
    const view = await svc.select('s1', 'конфетти', '101', 'top-left');
    expect(uploadBuffer).toHaveBeenCalledWith(
      expect.stringMatching(/^sessions\/s1\/stickers\/st_[0-9a-f]+\.png$/),
      expect.any(Buffer),
      'image/png',
    );
    expect(view.selected).toEqual(
      expect.objectContaining({
        url: 'https://blob.test/sticker.png',
        sourceUrl: HIT.pageURL,
        source: 'pixabay',
        placement: 'top-left',
      }),
    );
    expect(updateSession).toHaveBeenCalled();
  });

  it('id не из выдачи не скачивается — иначе сервер тянул бы что угодно откуда угодно', async () => {
    searchOk();
    const { svc, uploadBuffer } = build();
    await expect(
      svc.select('s1', 'конфетти', 'чужой-id', null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('без ключа выбрать нечего — честный отказ', async () => {
    mockedConfig.mockReturnValue({ pixabay: { apiKey: '' } });
    const { svc } = build();
    await expect(
      svc.select('s1', 'конфетти', '101', null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('неизвестное положение читается как значение по умолчанию', async () => {
    searchOk();
    const view = await build().svc.select('s1', 'конфетти', '101', 'куда-то');
    expect(view.selected?.placement).toBe('bottom-right');
  });

  it('положение меняется без повторного скачивания', async () => {
    searchOk();
    const { svc, uploadBuffer } = build({
      sticker: {
        id: 'st_1',
        url: 'https://blob.test/a.png',
        pathname: 'sessions/s1/stickers/st_1.png',
        sourceUrl: 'https://pixabay.com/x',
        source: 'pixabay',
        placement: 'bottom-right',
      },
    });
    uploadBuffer.mockClear();
    const view = await svc.move('s1', 'center');
    expect(view.selected?.placement).toBe('center');
    expect(view.selected?.url).toBe('https://blob.test/a.png');
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('двигать нечего, если наклейка не выбрана', async () => {
    const { svc } = build();
    await expect(svc.move('s1', 'center')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('наклейку можно снять', async () => {
    const { svc } = build({
      sticker: {
        id: 'st_1',
        url: 'u',
        pathname: 'p',
        sourceUrl: 's',
        source: 'pixabay',
        placement: 'center',
      },
    });
    const view = await svc.clear('s1');
    expect(view.selected).toBeNull();
  });

  it('не поздравительная сессия — 404', async () => {
    const { svc } = build(null);
    await expect(svc.view('s1', '')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('C2: запись снимка не теряет соседние правки', () => {
    const STICKER = {
      id: 'st_1',
      url: 'https://blob.test/a.png',
      pathname: 'sessions/s1/stickers/st_1.png',
      sourceUrl: 'https://pixabay.com/x',
      source: 'pixabay',
      placement: 'bottom-right',
    };

    it('пишется только ключ sticker — число сцен, выбранное параллельно, остаётся', async () => {
      searchOk();
      const { svc, snapshotNow } = build(
        {},
        {
          // Пока наклейка скачивалась, соседний запрос выбрал три сцены.
          beforeWrite: (n, set) => n === 1 && set({ sceneCount: 3 }),
        },
      );
      await svc.select('s1', 'конфетти', '101', null);
      expect(snapshotNow()).toEqual(
        expect.objectContaining({
          sceneCount: 3,
          sticker: expect.objectContaining({ source: 'pixabay' }),
        }),
      );
    });

    it('повод стал траурным, пока шло скачивание, — запись не ложится, отказ по свежему снимку', async () => {
      searchOk();
      const { svc, snapshotNow } = build(
        {},
        { beforeWrite: (n, set) => n === 1 && set({ occasion: 'CONDOLENCE' }) },
      );
      await expect(
        svc.select('s1', 'конфетти', '101', null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(snapshotNow()?.sticker).toBeUndefined();
    });

    it('сдвиг наклейки, которую только что сменили, двигает НОВУЮ, а не возвращает старую', async () => {
      const replaced = {
        ...STICKER,
        id: 'st_2',
        url: 'https://blob.test/b.png',
      };
      const { svc, snapshotNow } = build(
        { sticker: STICKER },
        { beforeWrite: (n, set) => n === 1 && set({ sticker: replaced }) },
      );
      const view = await svc.move('s1', 'center');
      expect(view.selected).toEqual({ ...replaced, placement: 'center' });
      expect(snapshotNow()?.sticker).toEqual({
        ...replaced,
        placement: 'center',
      });
    });

    it('снимок меняют под руками три раза подряд — 409 GREETING_EDIT_IN_PROGRESS', async () => {
      let i = 0;
      const { svc, updateSession } = build(
        { sticker: STICKER },
        {
          beforeWrite: (_n, set) =>
            set({ sticker: { ...STICKER, id: `st_x${++i}` } }),
        },
      );
      const err = await svc.move('s1', 'center').catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'GREETING_EDIT_IN_PROGRESS' }),
      );
      expect(i).toBe(3);
      expect(updateSession).not.toHaveBeenCalled();
    });
  });
});
