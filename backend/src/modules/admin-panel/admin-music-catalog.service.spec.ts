/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { AdminMusicCatalogService } from './admin-music-catalog.service';
import { GREETING_MUSIC_SETTING_KEY } from '../../common/greeting-music';
import type { PlatformSettingsService } from '../../common/platform-settings.service';

function build(stored: string | null = null) {
  let value = stored;
  const get = jest.fn().mockImplementation(() => Promise.resolve(value));
  const set = jest.fn().mockImplementation((_k: string, v: string) => {
    value = v;
    return Promise.resolve(undefined);
  });
  const svc = new AdminMusicCatalogService({
    get,
    set,
  } as unknown as PlatformSettingsService);
  return { svc, get, set };
}

const theme = (over: Record<string, unknown> = {}) => ({
  id: 'warm',
  title: 'Тёплая',
  url: 'https://blob.test/warm.mp3',
  ...over,
});

describe('AdminMusicCatalogService', () => {
  it('пустая настройка — пустая витрина, а не ошибка', async () => {
    const view = await build().svc.get();
    expect(view.raw).toBe('');
    expect(view.themes).toEqual([]);
    expect(view.rejected).toBe(0);
  });

  it('показывает, сколько записей принято и сколько отброшено', async () => {
    // Разбор терпимый: негодная запись пропускается молча. Без этих
    // чисел опечатка в ссылке выглядела бы как «сохранилось, но тема
    // не появилась».
    const raw = JSON.stringify([
      theme(),
      theme({ id: 'bad', url: 'http://blob.test/x.mp3' }),
      theme({ id: 'broken-id ?' }),
    ]);
    const view = await build().svc.save(raw);
    expect(view.submitted).toBe(3);
    expect(view.themes).toHaveLength(1);
    expect(view.rejected).toBe(2);
  });

  it('пишет туда, куда читает фича', async () => {
    const { svc, set } = build();
    await svc.save(JSON.stringify([theme()]), 'op-1');
    expect(set).toHaveBeenCalledWith(
      GREETING_MUSIC_SETTING_KEY,
      expect.stringContaining('warm'),
      'op-1',
    );
  });

  it('не-JSON отвергается внятно, а не превращается в пустой каталог', async () => {
    // Иначе оператор решил бы, что дело в темах, а не в лишней запятой.
    const { svc, set } = build();
    await expect(svc.save('{не json')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(set).not.toHaveBeenCalled();
  });

  it('пустое значение — это «выключить фичу», и оно сохраняется', async () => {
    const { svc, set } = build(JSON.stringify([theme()]));
    const view = await svc.save('   ');
    expect(set).toHaveBeenCalledWith(GREETING_MUSIC_SETTING_KEY, '', undefined);
    expect(view.themes).toEqual([]);
  });

  it('слишком длинное значение отвергается', async () => {
    const { svc, set } = build();
    await expect(
      svc.save('"' + 'x'.repeat(70000) + '"'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(set).not.toHaveBeenCalled();
  });

  it('форма { themes: [...] } тоже считается', async () => {
    const view = await build().svc.save(
      JSON.stringify({ themes: [theme(), theme({ id: 'calm' })] }),
    );
    expect(view.submitted).toBe(2);
    expect(view.rejected).toBe(0);
  });

  it('сохранённое значение читается обратно как есть', async () => {
    const { svc } = build();
    const raw = JSON.stringify([theme()]);
    await svc.save(raw);
    const view = await svc.get();
    expect(view.raw).toBe(raw);
    expect(view.themes).toHaveLength(1);
  });
});
