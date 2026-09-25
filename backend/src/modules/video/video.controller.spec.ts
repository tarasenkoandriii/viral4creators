import 'reflect-metadata';
import { VideoController } from './video.controller';
import { RATE_LIMIT_KEY } from '../../common/rate-limit';

/**
 * Сторож для защиты, которую больше ничто не сторожит (аудит этапа 136).
 *
 * С этапа 136 регистрация ссылки перестала быть бесплатной для НАС: она
 * спрашивает у Google теги исходника, то есть тратит единицу суточной
 * квоты всего деплоя (10 000 на поиск референсов, блог и теги вместе).
 * Сам маршрут дешёвый и доступен любому, у кого есть id своей сессии, —
 * без ограничителя перебор выел бы квоту за минуты, и YouTube-поиск
 * отключился бы у всех.
 *
 * Тест нарочно проверяет метаданные декоратора, а не поведение: гвард
 * уже проверен своим тестом (`common/rate-limit.spec.ts`), а исчезнуть
 * при рефакторинге может именно строчка декоратора — молча и без
 * единого падающего теста.
 */
describe('VideoController — регистрация ссылки под ограничителем частоты', () => {
  it('на маршруте стоят оба окна: минутное и часовое', () => {
    const rules = Reflect.getMetadata(
      RATE_LIMIT_KEY,
      VideoController.prototype.registerYoutube,
    ) as Array<{ name: string; limit: number; windowSec: number }>;

    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowSec: 60 }),
        expect.objectContaining({ windowSec: 3600 }),
      ]),
    );
    // Имена у правил разные — иначе окна складывались бы в один счётчик
    // (см. доккомментарий `common/rate-limit.ts`).
    expect(new Set(rules.map((r) => r.name)).size).toBe(rules.length);
    // Часовое окно не должно быть слабее минутного, помноженного на час,
    // иначе оно ничего не ограничивает.
    const minute = rules.find((r) => r.windowSec === 60)!;
    const hour = rules.find((r) => r.windowSec === 3600)!;
    expect(hour.limit).toBeLessThan(minute.limit * 60);
  });

  it('загрузка файлом ограничителя не требует — она не ходит к Google', () => {
    expect(
      Reflect.getMetadata(
        RATE_LIMIT_KEY,
        VideoController.prototype.getUploadUrl,
      ),
    ).toBeUndefined();
  });
});
