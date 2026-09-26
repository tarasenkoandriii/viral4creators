import {
  APP_ATTACHMENT_LIMIT,
  attachmentPath,
  attachmentsOf,
  isOwnAttachmentPath,
  isAllowedAttachmentType,
  envSummary,
  needsReason,
  isTicketStatus,
  MAX_ATTACHMENTS,
  mergesInto,
  mergeText,
  MERGE_WINDOW_MS,
  rateVerdict,
  textOf,
  TELEGRAM_FILE_LIMIT,
  tooBig,
} from './test-ticket';

describe('статусы', () => {
  it('знает свои и не знает чужих', () => {
    expect(isTicketStatus('ANSWERED')).toBe(true);
    expect(isTicketStatus('answered')).toBe(false);
    expect(isTicketStatus('CLOSED')).toBe(false);
    expect(isTicketStatus(undefined)).toBe(false);
  });
});

describe('вложения', () => {
  it('из лестницы размеров берёт самый большой', () => {
    // Мелкий превью-размер как доказательство бага бесполезен: на нём
    // не видно того, ради чего скриншот и прислали.
    const claims = attachmentsOf({
      photo: [
        { file_id: 'small', file_size: 1000 },
        { file_id: 'big', file_size: 90000 },
        { file_id: 'mid', file_size: 20000 },
      ],
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ fileId: 'big', kind: 'PHOTO' });
  });

  it('узнаёт все виды файлов, а не только фото', () => {
    // Пропущенный вид — это молча потерянное вложение.
    const kind = (message: Parameters<typeof attachmentsOf>[0]) =>
      attachmentsOf(message)[0]?.kind;
    expect(kind({ document: { file_id: 'd' } })).toBe('DOCUMENT');
    expect(kind({ video: { file_id: 'v' } })).toBe('VIDEO');
    expect(kind({ animation: { file_id: 'a' } })).toBe('VIDEO');
    expect(kind({ video_note: { file_id: 'n' } })).toBe('VIDEO');
    expect(kind({ voice: { file_id: 'o' } })).toBe('VOICE');
    expect(kind({ audio: { file_id: 'm' } })).toBe('AUDIO');
  });

  it('ничего не прислали — пустой список, а не отказ', () => {
    expect(attachmentsOf({ text: 'кнопка не нажимается' })).toEqual([]);
  });

  it('файл без file_id пропускается', () => {
    expect(attachmentsOf({ document: { file_name: 'log.txt' } })).toEqual([]);
  });

  it('больше пяти не берёт', () => {
    const photo = Array.from({ length: 9 }, (_, i) => ({
      file_id: `p${i}`,
      file_size: i,
    }));
    const many = attachmentsOf({
      photo,
      document: { file_id: 'd' },
      video: { file_id: 'v' },
      voice: { file_id: 'o' },
      audio: { file_id: 'm' },
      animation: { file_id: 'a' },
      video_note: { file_id: 'n' },
    });
    expect(many).toHaveLength(MAX_ATTACHMENTS);
  });

  it('несёт имя и тип, когда Telegram их прислал', () => {
    expect(
      attachmentsOf({
        document: {
          file_id: 'd',
          file_name: 'console.log',
          mime_type: 'text/plain',
          file_size: 12,
        },
      })[0],
    ).toEqual({
      fileId: 'd',
      kind: 'DOCUMENT',
      size: 12,
      fileName: 'console.log',
      mimeType: 'text/plain',
    });
  });
});

describe('потолок платформы', () => {
  it('ровно 20 МБ ещё влезает, байтом больше — нет', () => {
    expect(
      tooBig({ fileId: 'f', kind: 'VIDEO', size: TELEGRAM_FILE_LIMIT }),
    ).toBe(false);
    expect(
      tooBig({ fileId: 'f', kind: 'VIDEO', size: TELEGRAM_FILE_LIMIT + 1 }),
    ).toBe(true);
  });

  it('размер неизвестен — не отказываем', () => {
    // Отказать из-за неприсланного поля значит потерять вложение,
    // которое скачалось бы.
    expect(tooBig({ fileId: 'f', kind: 'DOCUMENT' })).toBe(false);
  });
});

describe('текст', () => {
  it('подпись к файлу — такой же текст находки', () => {
    expect(textOf({ caption: '  вот тут  ' })).toBe('вот тут');
  });

  it('текст важнее подписи, если пришли оба', () => {
    expect(textOf({ text: 'текст', caption: 'подпись' })).toBe('текст');
  });

  it('ни того, ни другого — пустая строка, а не undefined', () => {
    expect(textOf({ photo: [{ file_id: 'p' }] })).toBe('');
  });
});

describe('склейка', () => {
  const at = (ms: number) => new Date(1_000_000 + ms);

  it('в окне — клеим', () => {
    expect(mergesInto({ lastMessageAt: at(0) }, at(MERGE_WINDOW_MS - 1))).toBe(
      true,
    );
  });

  it('ровно на границе — ещё клеим', () => {
    expect(mergesInto({ lastMessageAt: at(0) }, at(MERGE_WINDOW_MS))).toBe(
      true,
    );
  });

  it('за окном — новый тикет', () => {
    // Человек, вернувшийся через час, пишет про другое.
    expect(mergesInto({ lastMessageAt: at(0) }, at(MERGE_WINDOW_MS + 1))).toBe(
      false,
    );
  });

  it('окно считается от последнего сообщения, а не от создания', () => {
    // Цепочка «скриншот → подпись → второй скриншот» не должна рваться
    // посередине из-за того, что первое сообщение отправлено давно.
    expect(
      mergesInto(
        { lastMessageAt: at(MERGE_WINDOW_MS) },
        at(MERGE_WINDOW_MS + 10),
      ),
    ).toBe(true);
  });

  it('тикет, в который человек не писал, к склейке не годится', () => {
    // Аудит этапа 157: отметка ставится ТОЛЬКО сообщением человека.
    // Строка без неё — это не «писал очень давно», это «не писал».
    expect(mergesInto({ lastMessageAt: null }, at(0))).toBe(false);
  });

  it('предыдущего нет — клеить не к чему', () => {
    expect(mergesInto(null, at(0))).toBe(false);
  });

  it('пустое сообщение не добавляет пустых строк', () => {
    expect(mergeText('первое', '   ')).toBe('первое');
    expect(mergeText('', 'первое')).toBe('первое');
    expect(mergeText('первое', 'второе')).toBe('первое\n\nвторое');
  });
});

describe('частота', () => {
  it('до лимита включительно — пропускаем', () => {
    expect(rateVerdict(1, 30)).toBe('allow');
    expect(rateVerdict(30, 30)).toBe('allow');
  });

  it('отказ ровно один раз, дальше молчание', () => {
    // Бот, отвечающий «слишком часто» на каждое из тридцати следующих
    // сообщений, сам становится спамом — и ровно тогда, когда человек
    // и так раздражён.
    expect(rateVerdict(31, 30)).toBe('warn');
    expect(rateVerdict(32, 30)).toBe('silence');
    expect(rateVerdict(300, 30)).toBe('silence');
  });
});

describe('причина смены статуса', () => {
  it('нужна только там, где статус — ответ человеку', () => {
    // «Отклонено» и «дубль» без причины читаются как «нам всё равно» —
    // а человек потратил время. Остальное рабочее состояние очереди,
    // объяснять его некому.
    expect(needsReason('REJECTED')).toBe(true);
    expect(needsReason('DUPLICATE')).toBe(true);
    expect(needsReason('IN_PROGRESS')).toBe(false);
    expect(needsReason('FIXED')).toBe(false);
    expect(needsReason('NEW')).toBe(false);
    expect(needsReason('ANSWERED')).toBe(false);
  });
});

describe('окружение одной строкой', () => {
  const full = {
    surface: 'TMA',
    osFamily: 'ios',
    osVersion: '18.1',
    deviceKind: 'PHONE',
    viewport: { w: 390, h: 760 },
    screen: { w: 390, h: 844, dpr: 3 },
    uiLocale: 'uk',
    appBuild: '2026.09.25-a1b2c3d',
  };

  it('собирается в читаемую строку', () => {
    expect(envSummary(full)).toBe(
      'Telegram · iOS 18.1 · телефон · 390×760 · uk · сборка 2026.09.25-a1b2c3d',
    );
  });

  it('размер берётся от видимой области, а не от экрана', () => {
    // «Не влезло» меряют по ней; экран остаётся в раскрытом списке.
    expect(envSummary(full)).toContain('390×760');
    expect(envSummary(full)).not.toContain('844');
  });

  it('пропущенные поля выпадают целиком, а не прочерками', () => {
    // Строку читают взглядом, и прочерки в ней занимают место, ничего
    // не сообщая.
    expect(envSummary({ surface: 'BROWSER', osFamily: 'windows' })).toBe(
      'браузер · Windows',
    );
  });

  it('неопознанные значения не притворяются знанием', () => {
    expect(
      envSummary({ surface: 'TMA', osFamily: 'unknown', appBuild: 'unknown' }),
    ).toBe('Telegram');
  });

  it('незнакомое семейство ОС показывается как есть', () => {
    // Иначе устройство, которого мы не видели, станет невидимым.
    expect(envSummary({ osFamily: 'harmonyos' })).toBe('harmonyos');
  });

  it('окружения нет — пустая строка, а не «null»', () => {
    expect(envSummary(null)).toBe('');
    expect(envSummary(undefined)).toBe('');
    expect(envSummary('TMA')).toBe('');
  });

  it('половина размера не печатается', () => {
    expect(envSummary({ viewport: { w: 390 } })).toBe('');
  });
});

describe('вложения из мини-аппа (этап 160)', () => {
  it('принимает то, чем доказывают баг', () => {
    expect(isAllowedAttachmentType('image/png')).toBe(true);
    expect(isAllowedAttachmentType('video/mp4')).toBe(true);
    expect(isAllowedAttachmentType('audio/ogg')).toBe(true);
    expect(isAllowedAttachmentType('text/plain')).toBe(true);
    expect(isAllowedAttachmentType('application/pdf')).toBe(true);
  });

  it('и не принимает остального: список закрытый', () => {
    // У открытого списка («всё, кроме») нет края, и однажды в
    // хранилище приедет то, чего там быть не должно.
    expect(isAllowedAttachmentType('application/x-msdownload')).toBe(false);
    expect(isAllowedAttachmentType('application/zip')).toBe(false);
    expect(isAllowedAttachmentType('')).toBe(false);
    expect(isAllowedAttachmentType('   ')).toBe(false);
  });

  it('разбирает тип с параметрами и регистром', () => {
    // Браузер шлёт `text/plain; charset=utf-8`, и отказать на этом
    // значило бы отказать в текстовом логе.
    expect(isAllowedAttachmentType('TEXT/PLAIN; charset=utf-8')).toBe(true);
    expect(isAllowedAttachmentType('Image/PNG')).toBe(true);
  });

  it('путь ложится под владельца, а не в свой префикс', () => {
    // Метла обходит закрытый список областей и разбирает пути как
    // `<префикс>/<id>/…` (аудит этапа 157).
    const path = attachmentPath('u1', 1_700_000_000_000);
    expect(path.startsWith('users/u1/tickets/app-1700000000000-')).toBe(true);
  });

  it('два вложения подряд не перетирают друг друга', () => {
    // Путь детерминирован по времени, а внутри одной миллисекунды
    // человек успевает приложить второй файл: `allowOverwrite` у
    // хранилища включён, и совпадение стоило бы потерянного файла.
    const a = attachmentPath('u1', 1);
    const b = attachmentPath('u1', 1);
    expect(a).not.toBe(b);
  });

  it('чужая папка не проходит проверку пути', () => {
    // Аудит этапа 160: проверка на `users/` и `/tickets/` по
    // отдельности пропускала папку ДРУГОГО тестировщика — ровно тот
    // случай, который она и должна была закрыть.
    expect(isOwnAttachmentPath('users/u1/tickets/app-1', 'u1')).toBe(true);
    expect(isOwnAttachmentPath('users/u2/tickets/app-1', 'u1')).toBe(false);
  });

  it('и чужая область хранилища — тоже', () => {
    expect(isOwnAttachmentPath('sessions/s1/original.mp4', 'u1')).toBe(false);
    expect(isOwnAttachmentPath('users/u1/voices/v1/sample.webm', 'u1')).toBe(
      false,
    );
  });

  it('выход вверх по дереву не считается своим путём', () => {
    // Путь приходит из тела запроса: без этой проверки
    // `users/u1/tickets/../../u2/tickets/x` прошёл бы по префиксу.
    expect(
      isOwnAttachmentPath('users/u1/tickets/../../u2/tickets/x', 'u1'),
    ).toBe(false);
  });

  it('сама папка без файла — не путь к файлу', () => {
    expect(isOwnAttachmentPath('users/u1/tickets/', 'u1')).toBe(false);
    expect(isOwnAttachmentPath('', 'u1')).toBe(false);
  });

  it('свой путь, выданный `attachmentPath`, проходит по построению', () => {
    expect(isOwnAttachmentPath(attachmentPath('u1', 5), 'u1')).toBe(true);
  });

  it('потолок мини-аппа — наш, а не платформенный', () => {
    // 20 МБ у бота — чужое ограничение, которое мы пересказываем.
    // Здесь потолок про другое: доказательством работает снимок
    // экрана или короткий фрагмент.
    expect(APP_ATTACHMENT_LIMIT).toBeLessThan(TELEGRAM_FILE_LIMIT);
  });
});
