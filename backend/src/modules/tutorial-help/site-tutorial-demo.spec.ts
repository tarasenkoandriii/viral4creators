/**
 * Барьер публичной справки: `client-site` и ролики по сайтам заказчиков
 * не выдаются никогда; семейство демо обучающего лендинга
 * (`site-tutorial-demo-1..N`) — только вычитанные ролики с отметкой
 * оператора. См. `site-tutorial-demo.ts`.
 *
 * Выборка проверяется двумя способами: «честной» поддельной базой,
 * которая исполняет `where` (что попадёт в ответ при верном запросе), и
 * «сломанной», которая `where` игнорирует (держит ли барьер второй
 * рубеж — проверку в коде).
 */

import { NotFoundException } from '@nestjs/common';
import { TutorialHelpService } from './tutorial-help.service';
import {
  CLOSED_HELP_SUBJECT_KEYS,
  isSiteTutorialDemoFamilyKey,
  isSiteTutorialDemoKey,
  NOT_SITE_TUTORIAL_DEMO_WHERE,
  parseSiteTutorialDemoAssetIds,
  SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY,
  SITE_TUTORIAL_DEMO_KEYS,
  SITE_TUTORIAL_DEMO_MAX_MARKED,
  siteTutorialDemoTopicFor,
} from './site-tutorial-demo';
import { SUPPORTED_LOCALES } from '../../common/locale';
import * as locales from '../tutorial-scenario/tutorial-locales';

interface Row {
  id: string;
  subjectKey: string;
  locale: string;
  reviewed: boolean;
  clientSiteDraftId: string | null;
  blobUrl: string | null;
  externalUrl: string | null;
  theme: string | null;
  createdAt: Date;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  posterUrl: string | null;
  capturedAt: Date | null;
  captureBuild: string | null;
}

let seq = 0;
function row(over: Partial<Row>): Row {
  seq += 1;
  return {
    id: `asset_${seq}`,
    subjectKey: 'site-tutorial-demo-1',
    locale: 'ru',
    reviewed: true,
    clientSiteDraftId: null,
    blobUrl: `https://blob/v${seq}.mp4`,
    externalUrl: null,
    theme: 'light',
    createdAt: new Date(Date.UTC(2026, 9, 6, 0, seq)),
    durationMs: 30000,
    width: 720,
    height: 1560,
    posterUrl: null,
    capturedAt: null,
    captureBuild: null,
    ...over,
  };
}

type Where = Record<string, unknown> & {
  OR?: Array<Record<string, { not: null }>>;
  id?: { in: string[] };
};

/** Подмножество семантики Prisma `where`, которым пользуется справка. */
function matches(r: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      const ok = (cond as Where['OR'])!.some((alt) =>
        Object.entries(alt).every(
          ([f]) => (r as unknown as Record<string, unknown>)[f] != null,
        ),
      );
      if (!ok) return false;
      continue;
    }
    const value = (r as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === 'object' && 'in' in cond) {
      if (!(cond as { in: unknown[] }).in.includes(value)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function pick(r: Row, select: Record<string, boolean>) {
  return Object.fromEntries(
    Object.keys(select).map((k) => [
      k,
      (r as unknown as Record<string, unknown>)[k],
    ]),
  );
}

function build(
  rows: Row[],
  setting: string | null | (() => Promise<string | null>),
  opts: { brokenWhere?: boolean; noSettings?: boolean } = {},
) {
  const findFirst = jest.fn(
    async (args: { where: Where; select: Record<string, boolean> }) => {
      const hit = rows
        .filter((r) => opts.brokenWhere || matches(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return hit ? pick(hit, args.select) : null;
    },
  );
  const get = jest.fn(async (key: string) => {
    expect(key).toBe(SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY);
    return typeof setting === 'function' ? setting() : setting;
  });
  const prisma = { tutorialVideoAsset: { findFirst } };
  const settings = opts.noSettings ? undefined : { get };
  return {
    service: new TutorialHelpService(prisma as never, settings as never),
    findFirst,
    get,
  };
}

const marked = (...ids: string[]) => JSON.stringify(ids);

describe('семейство демо обучающего лендинга — ключи и отметка', () => {
  it('ровно N слотов, без префиксного совпадения', () => {
    expect(SITE_TUTORIAL_DEMO_KEYS).toEqual([
      'site-tutorial-demo-1',
      'site-tutorial-demo-2',
      'site-tutorial-demo-3',
    ]);
    expect(isSiteTutorialDemoKey('site-tutorial-demo-1')).toBe(true);
    for (const bad of [
      'site-tutorial-demo-0',
      'site-tutorial-demo-4',
      'site-tutorial-demo-10',
      'site-tutorial-demo-',
      'site-tutorial-demo-1 ',
      'SITE-TUTORIAL-DEMO-1',
      'client-site',
    ]) {
      expect(isSiteTutorialDemoKey(bad)).toBe(false);
    }
  });

  it('тексты слотов есть на всех пяти языках, и в них нет обещания сценария', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of SITE_TUTORIAL_DEMO_KEYS) {
        const topic = siteTutorialDemoTopicFor(key, locale);
        expect(topic?.title.trim()).toBeTruthy();
        expect(topic?.text.length).toBeGreaterThan(40);
      }
    }
    expect(siteTutorialDemoTopicFor('client-site', 'ru')).toBeNull();
    expect(siteTutorialDemoTopicFor('2', 'ru')).toBeNull();
  });

  it('client-site — в списке закрытых ключей', () => {
    expect(CLOSED_HELP_SUBJECT_KEYS).toContain('client-site');
  });

  describe('разбор отметки — закрыто по умолчанию', () => {
    it('годный массив id', () => {
      expect(parseSiteTutorialDemoAssetIds(marked('a1', 'b_2', 'a1'))).toEqual([
        'a1',
        'b_2',
      ]);
    });
    it.each([
      [null],
      [''],
      ['  '],
      ['not json'],
      ['{"ids":["a1"]}'],
      ['"a1"'],
      ['[1,2]'],
      ['["a1", ""]'],
      ['["a1", "has space"]'],
      ['["a1", {"id":"b"}]'],
      [JSON.stringify(['x'.repeat(65)])],
    ])('%p — пусто', (raw) => {
      expect(parseSiteTutorialDemoAssetIds(raw as string | null)).toEqual([]);
    });
    it('слишком длинный список — пусто, а не первые N', () => {
      const ids = Array.from(
        { length: SITE_TUTORIAL_DEMO_MAX_MARKED + 1 },
        (_, i) => `a${i}`,
      );
      expect(parseSiteTutorialDemoAssetIds(JSON.stringify(ids))).toEqual([]);
    });
  });
});

describe('TutorialHelpService — барьер client-site', () => {
  it('client-site — 404 до любых запросов к базе и к настройкам', async () => {
    const leak = row({
      subjectKey: 'client-site',
      clientSiteDraftId: 'draft_1',
    });
    const { service, findFirst, get } = build([leak], marked(leak.id), {
      brokenWhere: true,
    });
    await expect(service.get('client-site', 'ru')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('client-site закрыт явно — даже если тема с таким именем появится в каталоге', async () => {
    const spy = jest
      .spyOn(locales, 'tutorialStepFor')
      .mockReturnValue({ title: 'T', text: 'текст', details: [] });
    try {
      const leak = row({ subjectKey: 'client-site' });
      const { service, findFirst } = build([leak], null, { brokenWhere: true });
      await expect(service.get('client-site', 'ru')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('обычная тема: каждый запрос исключает строки с clientSiteDraftId', async () => {
    const { service, findFirst } = build([], null);
    await service.get('greeting-brief', 'ru');
    expect(findFirst).toHaveBeenCalledTimes(3);
    for (const [args] of findFirst.mock.calls) {
      expect(args.where.clientSiteDraftId).toBeNull();
    }
  });

  it('обычная тема: строка сайта заказчика под тем же ключом не выдаётся', async () => {
    const own = row({
      subjectKey: 'greeting-brief',
      blobUrl: 'https://blob/own.mp4',
    });
    const foreign = row({
      subjectKey: 'greeting-brief',
      clientSiteDraftId: 'draft_1',
      blobUrl: 'https://blob/customer.mp4',
    });
    const { service } = build([own, foreign], null);
    const view = await service.get('greeting-brief', 'ru');
    expect(view.videoUrl).toBe('https://blob/own.mp4');
    expect(view.variants.light?.videoUrl).toBe('https://blob/own.mp4');
  });

  it('обычная тема отметку оператора не читает и по ней не фильтрует', async () => {
    const own = row({ subjectKey: '2' });
    const { service, get, findFirst } = build([own], null);
    const view = await service.get('2', 'ru');
    expect(view.videoUrl).toBe(own.blobUrl);
    expect(get).not.toHaveBeenCalled();
    for (const [args] of findFirst.mock.calls) {
      expect(args.where).not.toHaveProperty('id');
    }
  });
});

describe('TutorialHelpService — семейство site-tutorial-demo', () => {
  const KEY = 'site-tutorial-demo-1';

  it('текст отдаётся и без роликов (лендинг покажет «скоро»)', async () => {
    const { service } = build([], null);
    const view = await service.get(KEY, 'uk');
    expect(view.subjectKey).toBe(KEY);
    expect(view.locale).toBe('uk');
    expect(view.title.trim()).toBeTruthy();
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
  });

  it('неизвестный слот — 404', async () => {
    const { service } = build([], null);
    await expect(
      service.get('site-tutorial-demo-4', 'ru'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('вычитанный и отмеченный ролик полигона — выдаётся, обе темы', async () => {
    const light = row({ subjectKey: KEY, theme: 'light' });
    const dark = row({ subjectKey: KEY, theme: 'dark' });
    const { service } = build([light, dark], marked(light.id, dark.id));
    const view = await service.get(KEY, 'ru', 'dark');
    expect(view.videoUrl).toBe(dark.blobUrl);
    expect(view.variants.light?.videoUrl).toBe(light.blobUrl);
    expect(view.variants.dark?.videoUrl).toBe(dark.blobUrl);
  });

  it('служебные поля барьера наружу не уходят', async () => {
    const light = row({ subjectKey: KEY });
    const { service } = build([light], marked(light.id));
    const view = await service.get(KEY, 'ru');
    const json = JSON.stringify(view);
    expect(json).not.toContain(light.id);
    expect(json).not.toContain('clientSiteDraftId');
    expect(Object.keys(view.variants.light!).sort()).toEqual(
      [
        'videoUrl',
        'posterUrl',
        'width',
        'height',
        'durationMs',
        'capturedAt',
        'captureBuild',
      ].sort(),
    );
  });

  it('вычитанный, но НЕ отмеченный — не выдаётся (reviewed мало)', async () => {
    const approved = row({ subjectKey: KEY });
    const other = row({ subjectKey: KEY });
    const { service } = build([approved, other], marked(other.id + 'x'));
    const view = await service.get(KEY, 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
  });

  it('отмеченный, но НЕ вычитанный — не выдаётся', async () => {
    const draft = row({ subjectKey: KEY, reviewed: false });
    const { service } = build([draft], marked(draft.id));
    expect((await service.get(KEY, 'ru')).videoUrl).toBeNull();
  });

  it('отмеченный ролик САЙТА ЗАКАЗЧИКА — не выдаётся (честная база)', async () => {
    const customer = row({ subjectKey: KEY, clientSiteDraftId: 'draft_9' });
    const { service } = build([customer], marked(customer.id));
    const view = await service.get(KEY, 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
  });

  it('отмеченный ролик сайта заказчика — не выдаётся, даже если where сломан', async () => {
    const customer = row({ subjectKey: KEY, clientSiteDraftId: 'draft_9' });
    const { service } = build([customer], marked(customer.id), {
      brokenWhere: true,
    });
    const view = await service.get(KEY, 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
  });

  it('строка client-site с отмеченным id не выдаётся под ключом семейства (сломанный where)', async () => {
    const leak = row({ subjectKey: 'client-site', clientSiteDraftId: null });
    const { service } = build([leak], marked(leak.id), { brokenWhere: true });
    expect((await service.get(KEY, 'ru')).videoUrl).toBeNull();
  });

  it('неотмеченная строка не выдаётся, даже если where сломан', async () => {
    const stray = row({ subjectKey: KEY });
    const { service } = build([stray], marked('asset_other'), {
      brokenWhere: true,
    });
    expect((await service.get(KEY, 'ru')).videoUrl).toBeNull();
  });

  it('запрос семейства несёт все условия барьера', async () => {
    const { service, findFirst } = build([], marked('a1', 'a2'));
    await service.get(KEY, 'ru');
    expect(findFirst).toHaveBeenCalledTimes(3);
    for (const [args] of findFirst.mock.calls) {
      expect(args.where).toMatchObject({
        subjectKey: KEY,
        reviewed: true,
        clientSiteDraftId: null,
        id: { in: ['a1', 'a2'] },
      });
    }
  });

  it('ролик ДРУГОГО слота с отметкой в этот слот не попадает', async () => {
    const second = row({ subjectKey: 'site-tutorial-demo-2' });
    const { service } = build([second], marked(second.id));
    expect((await service.get(KEY, 'ru')).videoUrl).toBeNull();
    expect((await service.get('site-tutorial-demo-2', 'ru')).videoUrl).toBe(
      second.blobUrl,
    );
  });

  it.each([
    ['отметки нет', null],
    ['отметка негодная', 'not json'],
    ['отметка пустая', '[]'],
  ])('%s — роликов нет и база не спрашивается', async (_name, setting) => {
    const ok = row({ subjectKey: KEY });
    const { service, findFirst } = build([ok], setting as string | null, {
      brokenWhere: true,
    });
    const view = await service.get(KEY, 'ru');
    expect(view.videoUrl).toBeNull();
    expect(view.variants).toEqual({});
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('чтение отметки упало — закрыто, а не 500', async () => {
    const ok = row({ subjectKey: KEY });
    const { service, findFirst } = build(
      [ok],
      async () => {
        throw new Error('db down');
      },
      { brokenWhere: true },
    );
    const view = await service.get(KEY, 'ru');
    expect(view.videoUrl).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('сервиса настроек нет — семейство закрыто', async () => {
    const ok = row({ subjectKey: KEY });
    const { service } = build([ok], marked(ok.id), {
      noSettings: true,
      brokenWhere: true,
    });
    expect((await service.get(KEY, 'ru')).videoUrl).toBeNull();
  });
});

describe('исключение семейства у чужих потребителей — по префиксу', () => {
  it.each([
    ['site-tutorial-demo-1', true],
    ['site-tutorial-demo-99', true],
    ['site-tutorial-demo-', true],
    ['1', false],
    ['client-site', false],
    ['greeting-brief', false],
    ['xsite-tutorial-demo-1', false],
  ])('%s → %s', (key, expected) => {
    expect(isSiteTutorialDemoFamilyKey(key)).toBe(expected);
  });

  it('условие Prisma — тот же префикс', () => {
    expect(NOT_SITE_TUTORIAL_DEMO_WHERE).toEqual({
      NOT: { subjectKey: { startsWith: 'site-tutorial-demo-' } },
    });
  });
});
