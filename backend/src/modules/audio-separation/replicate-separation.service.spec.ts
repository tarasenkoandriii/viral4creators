/**
 * Разделение дорожки — контракт с Replicate и разбор ответа.
 *
 * Самое дорогое место здесь — `splitStems`: ошибка в нём возвращает в
 * ролик тот самый голос модели, ради удаления которого весь этап и
 * затеян, причём молча и за деньги. Поэтому ловушки проверяются
 * поимённо, а не «в целом».
 */
import {
  ReplicateSeparationService,
  splitStems,
} from './replicate-separation.service';

const KEYS = [
  'REPLICATE_API_TOKEN',
  'REPLICATE_DEMUCS_MODEL',
  'REPLICATE_DEMUCS_VERSION',
  'REPLICATE_DEMUCS_INPUT',
  'REPLICATE_DEMUCS_TIMEOUT_MS',
  'REPLICATE_API_BASE_URL',
] as const;

const before: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) {
    before[k] = process.env[k];
    delete process.env[k];
  }
  jest.restoreAllMocks();
});
afterEach(() => {
  for (const k of KEYS) {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
});

/**
 * Версия закреплена — прогон делает ровно ОДИН запрос, и тесты про
 * разбор ответа не обязаны знать про разрешение версии. Тесты самого
 * разрешения пользуются `configuredAuto()`.
 */
function configured() {
  process.env.REPLICATE_API_TOKEN = 'tok';
  process.env.REPLICATE_DEMUCS_VERSION = 'ver-hash';
  return new ReplicateSeparationService();
}

/** Версия НЕ закреплена: прогон сперва спросит последнюю. */
function configuredAuto() {
  process.env.REPLICATE_API_TOKEN = 'tok';
  delete process.env.REPLICATE_DEMUCS_VERSION;
  return new ReplicateSeparationService();
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('ReplicateSeparationService — настройка', () => {
  it('без токена — пропуск, ни одного запроса наружу', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as never);
    const svc = new ReplicateSeparationService();

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(svc.configured()).toBe(false);
    expect(out.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('одного токена достаточно: версия модели необязательна', async () => {
    // Приём из рабочего кода владельца (silverfinance/ideogram.ts):
    // без закреплённого хеша вызов идёт на эндпоинт модели и берёт
    // последнюю версию. Требовать хеш значило бы заставлять человека
    // искать его руками ради того, что и так работает.
    process.env.REPLICATE_API_TOKEN = 'tok';
    const svc = new ReplicateSeparationService();
    expect(svc.configured()).toBe(true);
  });

  it('пустая ссылка — пропуск, а не вызов с пустым входом', async () => {
    const svc = configured();
    const fetchMock = jest.spyOn(global, 'fetch' as never);

    const out = await svc.separate({ sourceUrl: '   ' });

    expect(out.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ReplicateSeparationService — вызов', () => {
  it('успешный ответ сразу: фон и голос разложены, время замерено', async () => {
    const svc = configured();
    jest.spyOn(global, 'fetch' as never).mockResolvedValue(
      jsonResponse({
        status: 'succeeded',
        output: {
          vocals: 'https://out/vocals.mp3',
          no_vocals: 'https://out/no_vocals.mp3',
        },
      }) as never,
    );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(true);
    expect(out.backgroundUrls).toEqual(['https://out/no_vocals.mp3']);
    expect(out.vocalsUrl).toBe('https://out/vocals.mp3');
    expect(typeof out.seconds).toBe('number');
  });

  it('версия не закреплена — спрашиваем последнюю и шлём её в предсказание', async () => {
    // Находка прода: эндпоинт `/v1/models/.../predictions` существует
    // только для ОФИЦИАЛЬНЫХ моделей Replicate, а htdemucs
    // сообщественная — он отвечал 404, и деньги за попытку списывались.
    const svc = configuredAuto();
    const fetchMock = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValueOnce(
        jsonResponse({ latest_version: { id: 'ver-latest' } }) as never,
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'succeeded',
          output: { no_vocals: 'https://o/b.mp3' },
        }) as never,
      );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/v1\/models\/ryan5453\/demucs$/,
    );
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/predictions$/);
    expect(JSON.parse(String(init.body)).version).toBe('ver-latest');
  });

  it('версия закреплена — лишнего запроса за ней нет', async () => {
    const svc = configured();
    process.env.REPLICATE_DEMUCS_VERSION = 'ver-pinned';
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
      jsonResponse({
        status: 'succeeded',
        output: { no_vocals: 'https://o/b.mp3' },
      }) as never,
    );

    await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/predictions$/);
    expect(JSON.parse(String(init.body)).version).toBe('ver-pinned');
  });

  it('хеш версии запоминается: второй прогон за ним не ходит', async () => {
    // Модель меняется раз в год, прогонов десятки в день.
    const svc = configuredAuto();
    process.env.REPLICATE_DEMUCS_MODEL = 'owner/cached-model';
    const ok = () =>
      jsonResponse({
        status: 'succeeded',
        output: { no_vocals: 'https://o/b.mp3' },
      }) as never;
    const fetchMock = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValueOnce(
        jsonResponse({ latest_version: { id: 'ver-1' } }) as never,
      )
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await svc.separate({ sourceUrl: 'https://x/a.mp4' });
    await svc.separate({ sourceUrl: 'https://x/b.mp4' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/\/v1\/predictions$/);
  });

  it('модель не найдена — причина называет переменную, которую чинить', async () => {
    const svc = configuredAuto();
    process.env.REPLICATE_DEMUCS_MODEL = 'owner/missing-model';
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue(
        jsonResponse({ detail: 'not found' }, false, 404) as never,
      );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('REPLICATE_DEMUCS_MODEL');
  });

  it('в ответе нет latest_version — тоже понятная причина, а не падение', async () => {
    const svc = configuredAuto();
    process.env.REPLICATE_DEMUCS_MODEL = 'owner/no-version';
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue(jsonResponse({ name: 'no-version' }) as never);

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('REPLICATE_DEMUCS_VERSION');
  });

  it('REPLICATE_DEMUCS_INPUT переопределяет схему входа и подставляет ссылку', async () => {
    // Смысл переменной: если имена полей у модели окажутся другими, это
    // правка настройки, а не деплой.
    const svc = configured();
    process.env.REPLICATE_DEMUCS_INPUT = JSON.stringify({
      track: '{{source}}',
      two_stems: 'vocals',
    });
    const fetchMock = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
      jsonResponse({
        status: 'succeeded',
        output: { no_vocals: 'https://o/b.mp3' },
      }) as never,
    );

    await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.input).toEqual({
      track: 'https://x/a.mp4',
      two_stems: 'vocals',
    });
  });

  it('не дождались сразу — дочитываем опросом по urls.get', async () => {
    const svc = configured();
    const fetchMock = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'processing',
          urls: { get: 'https://api/p/1' },
        }) as never,
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'succeeded',
          output: { no_vocals: 'https://o/b.mp3' },
        }) as never,
      );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api/p/1');
  });

  it('провайдер ответил failed — причина наружу, исключения нет', async () => {
    const svc = configured();
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue(
        jsonResponse({ status: 'failed', error: 'out of memory' }) as never,
      );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.skipped).toBeUndefined();
    expect(out.reason).toContain('out of memory');
  });

  it('HTTP-ошибка — тоже причина, а не throw: ролик обязан собраться', async () => {
    const svc = configured();
    jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue(jsonResponse({ detail: 'nope' }, false, 402) as never);

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('402');
  });

  it('успех без единого фонового стема — это отказ, а не пустой успех', async () => {
    const svc = configured();
    jest.spyOn(global, 'fetch' as never).mockResolvedValue(
      jsonResponse({
        status: 'succeeded',
        output: { vocals: 'https://o/v.mp3' },
      }) as never,
    );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.backgroundUrls).toBeUndefined();
  });
});

describe('ReplicateSeparationService — бюджет времени', () => {
  it('не дождались за отведённое время — отказ, а не бесконечное ожидание', async () => {
    // Находка аудита этапа C: у вызывающего (постобработка в функции
    // Vercel) есть свой потолок, и разделение не вправе его съесть.
    // Не уложились — собираем ролик по-старому.
    process.env.REPLICATE_API_TOKEN = 'tok';
    process.env.REPLICATE_DEMUCS_TIMEOUT_MS = '10000';
    // Потолок читается при вызове, а не при импорте — переменную
    // можно просто выставить, без перезагрузки модуля.
    const svc = new ReplicateSeparationService();
    jest.spyOn(global, 'fetch' as never).mockResolvedValue(
      jsonResponse({
        status: 'processing',
        urls: { get: 'https://api/p/1' },
      }) as never,
    );

    const out = await svc.separate({ sourceUrl: 'https://x/a.mp4' });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('timeout');
  }, 30_000);
});

describe('splitStems — разбор ответа модели', () => {
  it('«no_vocals» — это ФОН, хотя в имени есть «vocals»', () => {
    // Главная ловушка файла: наивная проверка `includes('vocals')`
    // отправила бы фон в голос, и в ролик вернулась бы речь модели.
    const r = splitStems({
      vocals: 'https://o/v.mp3',
      no_vocals: 'https://o/b.mp3',
    });
    expect(r.backgroundUrls).toEqual(['https://o/b.mp3']);
    expect(r.vocalsUrl).toBe('https://o/v.mp3');
  });

  it('четыре стема: голос отдельно, три остальных — фон', () => {
    const r = splitStems({
      vocals: 'https://o/v.mp3',
      drums: 'https://o/d.mp3',
      bass: 'https://o/ba.mp3',
      other: 'https://o/o.mp3',
    });
    expect(r.backgroundUrls).toHaveLength(3);
    expect(r.backgroundUrls).not.toContain('https://o/v.mp3');
  });

  it('исходник рядом с результатом в фон не попадает', () => {
    // Иначе в «фон» уехал бы файл с голосом модели целиком.
    const r = splitStems({
      input: 'https://o/original.mp3',
      source: 'https://o/original2.mp3',
      no_vocals: 'https://o/b.mp3',
    });
    expect(r.backgroundUrls).toEqual(['https://o/b.mp3']);
  });

  it('одна безымянная ссылка — фоном не считаем', () => {
    // Может оказаться выделенным голосом; угадывать здесь дороже, чем
    // отказаться.
    expect(splitStems('https://o/x.mp3').backgroundUrls).toEqual([]);
  });

  it('мусор вместо ответа — пустой результат, без исключения', () => {
    expect(splitStems(null).backgroundUrls).toEqual([]);
    expect(splitStems(42).backgroundUrls).toEqual([]);
    expect(splitStems({ a: 1, b: 'не ссылка' }).backgroundUrls).toEqual([]);
  });
});
