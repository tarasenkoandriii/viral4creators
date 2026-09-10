/**
 * FfmpegApiService — повторы и защита от двойного счёта (Б-5.16).
 *
 * Сервис платный и посекундный, а `withRetry` бьёт по нему до трёх раз.
 * Единственное, что отделяет «одна задача, оплаченная один раз» от «три
 * задачи по цене трёх», — заголовок `Idempotency-Key`, посчитанный от
 * содержимого запроса. Уберите заголовок — код продолжит работать, тесты
 * до этого файла оставались зелёными, а счёт вырастал втрое на каждом
 * флапающем запросе.
 *
 * Отсюда и форма проверок ниже: повтор проверяется не сам по себе, а
 * вместе с тем, ЧТО уходит в повторе — тот же ключ идемпотентности, а не
 * новый. Плюс граница «что повторяем»: 429 и 5xx — временные, 4xx —
 * наша ошибка в запросе, и повтор её только оплачивает.
 */

import { FfmpegApiService } from './ffmpeg-api.service';

const JOB = {
  inputs: { 'in.mp4': 'https://blob.test/sessions/s1/generated.mp4' },
  outputs: ['out.mp4'],
  commands: ['-i {{in.mp4}} -vf crop=1 out.mp4'],
};

/** Ответ сервиса: тело завёрнуто в `data`, как у живого API. */
const ok = (data: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data }),
  }) as unknown as Response;

const fail = (status: number, body = 'ой') =>
  ({
    ok: false,
    status,
    text: async () => body,
  }) as unknown as Response;

const envBefore = {
  key: process.env.FFMPEG_API_KEY,
  base: process.env.FFMPEG_API_BASE_URL,
};
const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.FFMPEG_API_KEY = 'ключ';
  process.env.FFMPEG_API_BASE_URL = 'https://ffmpeg.test/api';
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
  if (envBefore.key === undefined) delete process.env.FFMPEG_API_KEY;
  else process.env.FFMPEG_API_KEY = envBefore.key;
  if (envBefore.base === undefined) delete process.env.FFMPEG_API_BASE_URL;
  else process.env.FFMPEG_API_BASE_URL = envBefore.base;
});

/** Заголовки n-го запроса как обычный объект. */
const headersOf = (call: number) =>
  (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<
    string,
    string
  >;

describe('FfmpegApiService.submit — Idempotency-Key против двойного счёта', () => {
  it('ключ идемпотентности уходит с задачей и посчитан от её содержимого', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1', status: 'queued' }));

    await svc.submit(JOB);

    const key = headersOf(0)['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ПОВТОР шлёт ТОТ ЖЕ ключ — иначе сервис заводит вторую платную задачу', async () => {
    // Главная проверка файла. Сеть моргнула на первой попытке, вторая
    // прошла: если ключ считать заново на каждой попытке (или не слать
    // вовсе), у сервиса окажется две задачи, а у нас — один jobId и
    // двойной счёт, который никто не заметит до выписки.
    const svc = new FfmpegApiService();
    fetchMock
      .mockResolvedValueOnce(fail(503, 'upstream'))
      .mockResolvedValueOnce(ok({ id: 'job1', status: 'queued' }));

    const ref = await svc.submit(JOB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(1)['Idempotency-Key']).toBe(
      headersOf(0)['Idempotency-Key'],
    );
    expect(ref).toEqual({ jobId: 'job1', status: 'queued' });
  });

  it('та же задача, отправленная заново, приходит под тем же ключом', async () => {
    // Второй опрос статуса, пришедший раньше записи в сессию, вызовет
    // submit повторно (см. postprod.service). Ключ от содержимого — это
    // то, по чему сервис узнаёт уже принятую задачу.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1' }));

    await svc.submit(JOB);
    await svc.submit({ ...JOB });

    expect(headersOf(1)['Idempotency-Key']).toBe(
      headersOf(0)['Idempotency-Key'],
    );
  });

  it('другая задача — другой ключ, иначе вторая обрезка не выполнится', async () => {
    // Обратная половина: постоянный ключ «на все запросы» тоже прошёл бы
    // проверку выше, но сервис отдал бы на второй ролик результат
    // первого.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1' }));

    await svc.submit(JOB);
    await svc.submit({ ...JOB, outputs: ['другой.mp4'] });

    expect(headersOf(1)['Idempotency-Key']).not.toBe(
      headersOf(0)['Idempotency-Key'],
    );
  });

  it('без FFMPEG_API_KEY запрос не уходит вовсе', async () => {
    // Запрос без авторизации сервис всё равно отвергнет — но по дороге
    // мы бы трижды его повторили и записали в лог три «ошибки API»
    // вместо одной внятной «ключ не задан».
    delete process.env.FFMPEG_API_KEY;
    const svc = new FfmpegApiService();

    await expect(svc.submit(JOB)).rejects.toThrow(/FFMPEG_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(svc.configured()).toBe(false);
  });

  it('пустой ключ считается незаданным, а не отправляется как пустой Bearer', async () => {
    process.env.FFMPEG_API_KEY = '   ';
    expect(new FfmpegApiService().configured()).toBe(false);
  });

  it('ответ без id задачи — ошибка, а не задача с id "undefined"', async () => {
    // jobId уходит в сессию и по нему потом опрашивается статус: строка
    // "undefined" в этом поле — вечно висящая постобработка.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ status: 'queued' }));

    await expect(svc.submit(JOB)).rejects.toThrow(/не содержит id задачи/);
  });

  it('id принимается в трёх написаниях, которыми отвечает живой API', async () => {
    for (const [field, value] of [
      ['id', 'a'],
      ['jobId', 'b'],
      ['job_id', 'c'],
    ] as const) {
      const svc = new FfmpegApiService();
      fetchMock.mockResolvedValue(ok({ [field]: value }));
      const ref = await svc.submit(JOB);
      expect(ref.jobId).toBe(value);
    }
  });

  it('тело и адрес запроса — те, которых ждёт сервис', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1' }));

    await svc.submit(JOB);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ffmpeg.test/api/ffmpeg');
    expect(init.method).toBe('POST');
    expect(headersOf(0).Authorization).toBe('Bearer ключ');
    expect(JSON.parse(init.body as string)).toEqual({
      input_files: JOB.inputs,
      output_files: JOB.outputs,
      ffmpeg_commands: JOB.commands,
    });
  });

  it('хвостовой слэш в базовом URL не превращается в двойной', async () => {
    // `//ffmpeg` у многих шлюзов — 404, и выглядит это как «сервис
    // недоступен», хотя дело в одной лишней косой черте в .env.
    process.env.FFMPEG_API_BASE_URL = 'https://ffmpeg.test/api///';
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1' }));

    await svc.submit(JOB);

    expect(fetchMock.mock.calls[0][0]).toBe('https://ffmpeg.test/api/ffmpeg');
  });
});

describe('FfmpegApiService.withRetry — что повторяем, а что нет', () => {
  it('4xx не повторяется: наша ошибка в запросе, повтор её только оплатит', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(fail(400, 'bad command'));

    await expect(svc.submit(JOB)).rejects.toThrow(/ffmpeg api 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('403 (протухший ключ) тоже не повторяется', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(fail(403));

    await expect(svc.submit(JOB)).rejects.toThrow(/ffmpeg api 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 повторяется — это просьба подождать, а не отказ', async () => {
    const svc = new FfmpegApiService();
    fetchMock
      .mockResolvedValueOnce(fail(429, 'slow down'))
      .mockResolvedValueOnce(ok({ id: 'job1' }));

    await expect(svc.submit(JOB)).resolves.toMatchObject({ jobId: 'job1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('обрыв соединения (без статуса) повторяется', async () => {
    const svc = new FfmpegApiService();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok({ id: 'job1' }));

    await expect(svc.submit(JOB)).resolves.toMatchObject({ jobId: 'job1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('попыток ровно три, и наружу уходит последняя ошибка', async () => {
    // Потолок в три попытки — это и цена (каждая попытка может создать
    // задачу), и время: маршрут постобработки живёт внутри опроса
    // статуса, который клиент ждёт.
    const svc = new FfmpegApiService();
    fetchMock
      .mockResolvedValueOnce(fail(500, 'первая'))
      .mockResolvedValueOnce(fail(500, 'вторая'))
      .mockResolvedValueOnce(fail(502, 'третья'));

    await expect(svc.submit(JOB)).rejects.toThrow(/502.*третья/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('успех с первой попытки — ровно один платный вызов', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ id: 'job1' }));
    await svc.submit(JOB);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FfmpegApiService.status — словарь чужих статусов', () => {
  it('succeeded (а не completed) — это готово: так отвечает живой API', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(
      ok({
        status: 'succeeded',
        output_files: { 'out.mp4': 'https://ffmpeg.test/out.mp4' },
        error_message: '',
      }),
    );

    const st = await svc.status('job1');

    expect(st.status).toBe('completed');
    expect(st.outputs).toEqual({ 'out.mp4': 'https://ffmpeg.test/out.mp4' });
    // `error_message` приходит ПУСТОЙ СТРОКОЙ, а не null: сравнение с
    // undefined дало бы ложное «задача с ошибкой» на каждой удачной.
    expect(st.error).toBeUndefined();
  });

  it('неизвестный статус считается «ещё идёт», а не провалом', async () => {
    // Ошибочно объявив чужой промежуточный статус провалом, мы бросим
    // уже оплаченную задачу и потеряем её результат.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ status: 'processing' }));
    await expect(svc.status('job1')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('failed/cancelled — провал с текстом причины', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(
      ok({ status: 'failed', error_message: 'codec not supported' }),
    );
    await expect(svc.status('job1')).resolves.toEqual({
      status: 'failed',
      outputs: undefined,
      error: 'codec not supported',
    });
  });

  it('пустой список файлов — это отсутствие файлов, а не пустой объект', async () => {
    // Постобработка проверяет `outputs` на наличие; пустой `{}` прошёл бы
    // проверку и увёл её в скачивание несуществующего файла.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ status: 'succeeded', output_files: {} }));
    await expect(svc.status('job1')).resolves.toMatchObject({
      outputs: undefined,
    });
  });

  it('id задачи экранируется в адресе', async () => {
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue(ok({ status: 'pending' }));
    await svc.status('job/1 2');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://ffmpeg.test/api/jobs/job%2F1%202',
    );
  });

  it('не-JSON в ответе — внятная ошибка, а не падение парсера', async () => {
    // Шлюзы отдают HTML-страницу ошибки с кодом 200 чаще, чем хотелось бы;
    // без этой ветки в логе оказался бы SyntaxError без единого признака
    // того, чей это ответ.
    const svc = new FfmpegApiService();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>502 Bad Gateway</html>',
    } as unknown as Response);

    await expect(svc.status('job1')).rejects.toThrow(/вернул не-JSON/);
  });
});
