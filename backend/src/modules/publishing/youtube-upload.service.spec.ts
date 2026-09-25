import axios from 'axios';
import {
  DEFAULT_CATEGORY_ID,
  YoutubeUploadService,
} from './youtube-upload.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Тело `videos.insert` (этап 137).
 *
 * Всё, что здесь проверяется, невидимо в песочнице и видно только
 * площадке: забытый `categoryId` всплыл бы при первом же обновлении
 * ролика, забытый `defaultLanguage` — молчаливым отказом от локализаций
 * (`defaultLanguageNotSet`), а `part` без `localizations` просто выкинул
 * бы переводы, за которые уже заплачено.
 */
const input = {
  title: 'Кружка Steel 500',
  description: 'Стальная термокружка',
  tags: ['термокружки'],
  privacy: 'PUBLIC' as const,
  videoUrl: 'https://blob.test/v.mp4',
};

function openOk() {
  mockedAxios.post.mockResolvedValueOnce({
    status: 200,
    headers: { location: 'https://upload.example/session-1' },
    data: {},
  } as never);
}

type InsertBody = {
  snippet: Record<string, unknown>;
  status: Record<string, unknown>;
  localizations?: Record<string, { title: string; description: string }>;
};
const bodyOf = () => mockedAxios.post.mock.calls[0][1] as InsertBody;
const urlOf = () => mockedAxios.post.mock.calls[0][0] as string;

describe('YoutubeUploadService.openSession — метаданные ролика', () => {
  beforeEach(() => mockedAxios.post.mockReset());

  it('просит часть localizations, когда переводы есть: без неё они игнорируются', async () => {
    // Строка URL, а не тела, — ошибиться в ней легче всего, а заметить
    // нечем: площадка молча примет ролик без локализаций.
    openOk();
    await new YoutubeUploadService().openSession(
      {
        ...input,
        language: 'ru',
        localizations: { en: { title: 'Mug', description: '' } },
      },
      'at',
    );
    expect(urlOf()).toContain('part=snippet,status,localizations');
  });

  it('без переводов запрос ровно тот же, что был до этапа 137', async () => {
    // Аудит этапа: этот запрос — единственный путь всех публикаций на
    // YouTube. Новое имя части на КАЖДОЙ загрузке ставило бы всю
    // выгрузку в зависимость от того, насколько точно угадано поведение
    // чужого API, ради необязательного украшения.
    openOk();
    await new YoutubeUploadService().openSession(
      { ...input, language: 'ru' },
      'at',
    );
    expect(urlOf()).toContain('part=snippet,status');
    expect(urlOf()).not.toContain('localizations');
  });

  it('ставит categoryId всегда — он обязателен при любом будущем обновлении snippet', async () => {
    openOk();
    await new YoutubeUploadService().openSession(input, 'at');
    expect(bodyOf().snippet.categoryId).toBe(DEFAULT_CATEGORY_ID);
  });

  it('язык ролика уезжает и в defaultLanguage, и в defaultAudioLanguage', async () => {
    openOk();
    await new YoutubeUploadService().openSession(
      { ...input, language: 'uk' },
      'at',
    );
    expect(bodyOf().snippet).toMatchObject({
      defaultLanguage: 'uk',
      defaultAudioLanguage: 'uk',
    });
  });

  it('локализации уезжают отдельной частью, рядом со snippet', async () => {
    openOk();
    await new YoutubeUploadService().openSession(
      {
        ...input,
        language: 'ru',
        localizations: { en: { title: 'Mug', description: 'A mug' } },
      },
      'at',
    );
    expect(bodyOf().localizations).toEqual({
      en: { title: 'Mug', description: 'A mug' },
    });
    // Оригинал остаётся в snippet и в локализации не дублируется.
    expect(bodyOf().snippet.title).toBe(input.title);
  });

  it('пустая карта локализаций не отправляется вовсе', async () => {
    // `localizations: {}` — это просьба завести пустую часть, а не
    // «локализаций нет»; площадке такое слать незачем.
    openOk();
    await new YoutubeUploadService().openSession(
      { ...input, language: 'ru', localizations: {} },
      'at',
    );
    expect('localizations' in bodyOf()).toBe(false);
  });

  it('без языка локализации не отправляются даже если переводы есть', async () => {
    // YouTube отвергает локализации при незаданном defaultLanguage
    // (`defaultLanguageNotSet`) — и отвергает ВЕСЬ запрос, то есть
    // публикация упала бы из-за украшения.
    openOk();
    await new YoutubeUploadService().openSession(
      { ...input, localizations: { en: { title: 'Mug', description: '' } } },
      'at',
    );
    expect('localizations' in bodyOf()).toBe(false);
    expect(bodyOf().snippet.defaultLanguage).toBeUndefined();
  });

  it('обязательные поля прежних этапов на месте', async () => {
    // Раскрытие ИИ-контента (§14.4) — требование площадки, не опция.
    openOk();
    await new YoutubeUploadService().openSession(input, 'at');
    expect(bodyOf().status).toMatchObject({
      privacyStatus: 'public',
      containsSyntheticMedia: true,
      selfDeclaredMadeForKids: false,
    });
  });
});
