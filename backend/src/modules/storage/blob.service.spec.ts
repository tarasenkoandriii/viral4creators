/**
 * Механика уборки хранилища (doc/STORAGE-AUDIT.md).
 *
 * `deleteMany` — единственный путь, которым файлы вообще покидают Blob:
 * им пользуются и суточная уборка сессий, и метла осиротевших файлов.
 * Обе особенности — резка на куски и глотание ошибки куска — существуют
 * ради одного: уборка не должна прекращаться из-за одного файла. Без
 * первой одна истёкшая пачка уходит гигантским запросом по принципу
 * «всё или ничего», без второй один отсутствующий файл останавливает
 * удаление всех остальных, и мусор копится дальше.
 */

jest.mock('@vercel/blob', () => ({
  issueSignedToken: jest.fn(),
  presignUrl: jest.fn(),
  put: jest.fn(),
  head: jest.fn(),
  del: jest.fn(),
  list: jest.fn(),
}));

import { del, list } from '@vercel/blob';
import { BlobService } from './blob.service';

const mockedDel = del as jest.MockedFunction<typeof del>;
const mockedList = list as jest.MockedFunction<typeof list>;

const paths = (n: number, prefix = 'sessions/s1/f') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.jpg`);

let service: BlobService;
beforeEach(() => {
  jest.clearAllMocks();
  mockedDel.mockResolvedValue(undefined);
  service = new BlobService();
  // Предупреждения об упавших кусках — часть штатного поведения; в
  // выводе тестов они только мешают читать.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
});

describe('BlobService.deleteMany — чанкование', () => {
  it('пачка режется на куски, а не уходит одним запросом', () => {
    // 120 путей при куске в 50 — три запроса: 50, 50, 20.
    return service.deleteMany(paths(120)).then((done) => {
      expect(mockedDel).toHaveBeenCalledTimes(3);
      expect((mockedDel.mock.calls[0][0] as string[]).length).toBe(50);
      expect((mockedDel.mock.calls[1][0] as string[]).length).toBe(50);
      expect((mockedDel.mock.calls[2][0] as string[]).length).toBe(20);
      expect(done).toBe(120);
    });
  });

  it('ни один путь не теряется и не удаляется дважды', () => {
    // Ошибка в арифметике среза — самый вероятный способ оставить файлы
    // в хранилище навсегда, и заметить её иначе нечем.
    const all = paths(137);
    return service.deleteMany(all).then(() => {
      const sent = mockedDel.mock.calls.flatMap((c) => c[0] as string[]);
      expect(sent).toEqual(all);
    });
  });

  it('пачка меньше куска уходит одним запросом', async () => {
    expect(await service.deleteMany(paths(3))).toBe(3);
    expect(mockedDel).toHaveBeenCalledTimes(1);
  });

  it('удалять нечего — в сеть не ходим вовсе', async () => {
    // Суточная уборка запускается всегда, и в норме удалять нечего:
    // пустой запрос к провайдеру — это стоимость и лишняя точка отказа.
    expect(await service.deleteMany([])).toBe(0);
    expect(mockedDel).not.toHaveBeenCalled();
  });

  it('размер куска настраивается — на нём и держится проверка резки', async () => {
    expect(await service.deleteMany(paths(10), 4)).toBe(10);
    expect(mockedDel.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([
      4, 4, 2,
    ]);
  });
});

describe('BlobService.deleteMany — сбой одного куска не роняет остальные', () => {
  it('упавший кусок пропускается, следующие всё равно удаляются', async () => {
    // Ровно ради этого стоит try/catch внутри цикла: один отсутствующий
    // файл не должен оставить в хранилище всё, что шло после него.
    mockedDel
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('blob not found'))
      .mockResolvedValueOnce(undefined);

    const done = await service.deleteMany(paths(120));

    expect(mockedDel).toHaveBeenCalledTimes(3);
    // В отчёт попадают только реально отправленные: 50 + 20.
    expect(done).toBe(70);
  });

  it('упали все куски — метод возвращает ноль, а не бросает наружу', async () => {
    // Наверху (`CronController`) сбой уборки файлов — не повод считать
    // прогон провальным: строки сессий уже удалены, и падение здесь
    // отменило бы и их отчёт.
    mockedDel.mockRejectedValue(new Error('хранилище недоступно'));
    await expect(service.deleteMany(paths(60))).resolves.toBe(0);
  });

  it('о сбое куска остаётся запись в логе — иначе утечка тихая', async () => {
    const warn = service['logger'].warn as jest.Mock;
    mockedDel.mockRejectedValueOnce(new Error('blob not found'));
    await service.deleteMany(paths(1));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('blob not found'),
    );
  });
});

describe('BlobService.listByPrefix — курсор наружу', () => {
  it('есть следующая страница — курсор отдаётся крону', async () => {
    // Метла обходит хранилище страницами: потеря курсора превратила бы
    // её в вечный обход первой страницы.
    mockedList.mockResolvedValue({
      blobs: [{ pathname: 'sessions/s1/a.jpg', uploadedAt: '2026-09-01' }],
      hasMore: true,
      cursor: 'следующая',
    } as never);
    const page = await service.listByPrefix('sessions/');
    expect(page.cursor).toBe('следующая');
    expect(page.blobs[0].uploadedAt).toBeInstanceOf(Date);
  });

  it('страница последняя — курсора нет, даже если провайдер его прислал', async () => {
    // Иначе обход не закончится никогда: `hasMore` — единственный
    // признак конца, на который можно опереться.
    mockedList.mockResolvedValue({
      blobs: [],
      hasMore: false,
      cursor: 'хвост',
    } as never);
    expect((await service.listByPrefix('sessions/')).cursor).toBeNull();
  });
});
