jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { VideoService } from './video.service';
import { REFERENCE_DERIVED_KEYS } from '../../common/session-reset';
import { VideoSourceType } from '../../common/types/video.types';

/**
 * Этап 28: смена референса обнуляет кастинг, выбор сцен/массовки, слоты
 * референс-изображений и отчёт релевантности — иначе они описывали бы
 * прошлое видео, а отчёт ещё и уходил бы в бриф платной генерации.
 */
function build() {
  const sessions = {
    getSession: jest.fn().mockResolvedValue({ sessionId: 's1' }),
    updateSession: jest.fn().mockResolvedValue(undefined),
  };
  const blob = {
    createUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://put' }),
  };
  const youtubeSearch = {
    fetchVideoTags: jest.fn().mockResolvedValue([]),
  };
  const svc = new VideoService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blob as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    youtubeSearch as any,
  );
  return { svc, sessions, blob, youtubeSearch };
}

const patchOf = (sessions: { updateSession: jest.Mock }) =>
  sessions.updateSession.mock.calls[0][1] as Record<string, unknown>;

describe('VideoService — новый референс сбрасывает привязанное состояние', () => {
  it('загрузка файла: originalVideo записан, производное состояние очищено', async () => {
    const { svc, sessions } = build();
    await svc.generateUploadUrl('s1', 'a.mp4', 100, 'video/mp4');
    const patch = patchOf(sessions);
    expect((patch.originalVideo as { sourceType: string }).sourceType).toBe(
      VideoSourceType.UPLOAD,
    );
    for (const key of REFERENCE_DERIVED_KEYS) {
      expect(key in patch).toBe(true);
      expect(patch[key]).toBeUndefined();
    }
    // товар и снимок бренда переживают смену референса
    expect('productInformation' in patch).toBe(false);
    expect('brandManifestSnapshot' in patch).toBe(false);
  });

  it('ссылка на YouTube: то же самое', async () => {
    const { svc, sessions } = build();
    await svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ');
    const patch = patchOf(sessions);
    expect((patch.originalVideo as { sourceType: string }).sourceType).toBe(
      VideoSourceType.YOUTUBE,
    );
    for (const key of REFERENCE_DERIVED_KEYS) {
      expect(patch[key]).toBeUndefined();
    }
  });
});

/**
 * Presigned PUT — это выданное браузеру право писать в наше хранилище.
 * Размер и тип проверяются ДО его выдачи: после выдачи ссылку уже не
 * отозвать, а платит за трафик и хранение сервис.
 */
describe('VideoService — что вообще пускается в хранилище', () => {
  const MB = 1024 * 1024;

  it('файл ровно на пределе (100 МБ) принимается', () => {
    // Граница проверяется строгим «>», и это важно: съехавшая на байт
    // проверка отвергала бы законные файлы у самого потолка.
    const { svc, blob } = build();
    return svc
      .generateUploadUrl('s1', 'a.mp4', 100 * MB, 'video/mp4')
      .then(() => expect(blob.createUploadUrl).toHaveBeenCalled());
  });

  it('файл больше 100 МБ не получает ссылку на загрузку', async () => {
    const { svc, blob, sessions } = build();
    await expect(
      svc.generateUploadUrl('s1', 'huge.mp4', 100 * MB + 1, 'video/mp4'),
    ).rejects.toThrow(/maximum size of 100MB/);
    // Ни ссылки, ни отметки о новом референсе: отказ обязан быть до
    // сброса производного состояния, иначе неудачная попытка загрузки
    // стирала бы кастинг и разбор прежнего ролика.
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('в хранилище пускаются только три формата видео', async () => {
    const { svc, blob } = build();
    for (const mimeType of [
      'video/mp4',
      'video/quicktime',
      'video/x-msvideo',
    ]) {
      await svc.generateUploadUrl('s1', 'a.mov', 10, mimeType);
    }
    expect(blob.createUploadUrl).toHaveBeenCalledTimes(3);
  });

  it.each([
    // Не видео вовсе: presigned PUT ограничивает Content-Type, поэтому
    // именно этот список и решает, что за файл ляжет в наш Blob.
    'image/png',
    'application/pdf',
    'text/html',
    // Видео, но не из списка: разбор их всё равно не переварит.
    'video/webm',
    'video/x-matroska',
    // Пустой и почти-верный тип — типичный ввод клиента, а не атака.
    '',
    'video/mp4; codecs=avc1',
    'VIDEO/MP4',
  ])('MIME «%s» вне белого списка — ссылка не выдаётся', async (mimeType) => {
    const { svc, blob, sessions } = build();
    await expect(
      svc.generateUploadUrl('s1', 'a.bin', 10, mimeType),
    ).rejects.toThrow(/Invalid video format/);
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('несуществующая сессия не даёт права писать в чужой префикс', async () => {
    // Путь блоба строится из sessionId: без этой проверки любой UUID
    // открывал бы запись в `sessions/<что угодно>/`.
    const { svc, blob } = build();
    (
      svc as unknown as { sessionService: { getSession: jest.Mock } }
    ).sessionService.getSession.mockResolvedValue(null);
    await expect(
      svc.generateUploadUrl('s1', 'a.mp4', 10, 'video/mp4'),
    ).rejects.toThrow(/Session not found/);
    expect(blob.createUploadUrl).not.toHaveBeenCalled();
  });

  it('лимит размера уходит и в само разрешение на запись, а не только в проверку', async () => {
    // Проверка на сервере отсекает честного клиента; потолок в токене
    // отсекает нечестного, который взял ссылку и заливает гигабайты.
    const { svc, blob } = build();
    await svc.generateUploadUrl('s1', 'a.mp4', 10, 'video/mp4');
    expect(blob.createUploadUrl).toHaveBeenCalledWith(
      'sessions/s1/original.mp4',
      'video/mp4',
      100 * MB,
    );
  });
});

describe('VideoService — расширение ключа не берётся из имени файла (этап 54, Б-3.5)', () => {
  it('ключ выводится из MIME-типа, что бы ни было в fileName', async () => {
    const { svc, blob: blobService } = build();
    await svc.generateUploadUrl(
      's1',
      '../../../etc/passwd.mp4/..%2F..%2Fx',
      10,
      'video/quicktime',
    );
    expect(blobService.createUploadUrl).toHaveBeenCalledWith(
      'sessions/s1/original.mov',
      'video/quicktime',
      expect.any(Number),
    );
  });

  it('имя файла без точки и с чужим расширением — ключ всё равно по типу', async () => {
    const { svc, blob: blobService } = build();
    await svc.generateUploadUrl('s1', 'clip', 10, 'video/mp4');
    await svc.generateUploadUrl('s1', 'clip.exe', 10, 'video/x-msvideo');
    expect(blobService.createUploadUrl).toHaveBeenNthCalledWith(
      1,
      'sessions/s1/original.mp4',
      'video/mp4',
      expect.any(Number),
    );
    expect(blobService.createUploadUrl).toHaveBeenNthCalledWith(
      2,
      'sessions/s1/original.avi',
      'video/x-msvideo',
      expect.any(Number),
    );
  });
});

/**
 * Теги исходника (ТЗ TZ-Multilingual-YouTube.md, этап 136).
 *
 * Регистрация ссылки — единственный момент, когда теги вообще можно
 * взять, и одновременно момент, в котором ничего нельзя сломать: без
 * референса дальше не идёт ни разбор, ни генерация. Отсюда два
 * свойства, которые здесь и проверяются: теги попадают в сессию, а их
 * отсутствие — по любой причине — регистрации не мешает.
 */
describe('VideoService — теги исходного ролика (этап 136)', () => {
  const youtubeOf = (sessions: { updateSession: jest.Mock }) =>
    patchOf(sessions).originalVideo as { sourceTags?: string[] };

  it('теги ролика записаны в сессию, id взят из ссылки', async () => {
    const { svc, sessions, youtubeSearch } = build();
    youtubeSearch.fetchVideoTags.mockResolvedValue(['бег', 'кроссовки']);
    await svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ?t=30');
    expect(youtubeSearch.fetchVideoTags).toHaveBeenCalledWith(
      'dQw4w9WgXcQ',
      's1',
    );
    expect(youtubeOf(sessions).sourceTags).toEqual(['бег', 'кроссовки']);
  });

  it('у ролика без тегов поля нет вовсе, а не пустой список', async () => {
    // «Тегов не было» и «поле есть, но пустое» для панели публикации
    // одно и то же, и лишнее поле только притворялось бы знанием.
    const { svc, sessions } = build();
    await svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ');
    expect('sourceTags' in youtubeOf(sessions)).toBe(false);
  });

  it('падение запроса тегов не мешает зарегистрировать референс', async () => {
    const { svc, sessions, youtubeSearch } = build();
    youtubeSearch.fetchVideoTags.mockRejectedValue(new Error('google down'));
    await expect(
      svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ'),
    ).resolves.toEqual({ youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(sessions.updateSession).toHaveBeenCalled();
  });

  it('повторная регистрация ТОЙ ЖЕ ссылки за тегами не ходит', async () => {
    // Снимок, а не зеркало: второй вызов дал бы то же самое за ещё одну
    // единицу суточной квоты всего деплоя. Заодно это закрывает самый
    // дешёвый способ жечь чужую квоту — один и тот же URL в цикле.
    const { svc, sessions, youtubeSearch } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
        sourceTags: ['бег'],
      },
    });
    await svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ');
    expect(youtubeSearch.fetchVideoTags).not.toHaveBeenCalled();
    expect(
      (patchOf(sessions).originalVideo as { sourceTags?: string[] }).sourceTags,
    ).toEqual(['бег']);
  });

  it('ДРУГАЯ ссылка теги перечитывает, даже если старые в сессии есть', async () => {
    // Иначе новый референс унёс бы теги прежнего — молча и навсегда.
    const { svc, sessions, youtubeSearch } = build();
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      originalVideo: {
        sourceType: VideoSourceType.YOUTUBE,
        youtubeUrl: 'https://youtu.be/OLD11111111',
        sourceTags: ['старые'],
      },
    });
    youtubeSearch.fetchVideoTags.mockResolvedValue(['новые']);
    await svc.registerYoutubeVideo('s1', 'https://youtu.be/dQw4w9WgXcQ');
    expect(youtubeSearch.fetchVideoTags).toHaveBeenCalledWith(
      'dQw4w9WgXcQ',
      's1',
    );
    expect(
      (patchOf(sessions).originalVideo as { sourceTags?: string[] }).sourceTags,
    ).toEqual(['новые']);
  });

  it('загрузка файлом за тегами не ходит: у файла их неоткуда взять', async () => {
    const { svc, youtubeSearch } = build();
    await svc.generateUploadUrl('s1', 'a.mp4', 100, 'video/mp4');
    expect(youtubeSearch.fetchVideoTags).not.toHaveBeenCalled();
  });
});
