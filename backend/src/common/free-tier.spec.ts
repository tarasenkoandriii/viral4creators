/**
 * Правила границы бесплатного — «Условно бесплатный Lite», этап 132.
 *
 * Отдельный файл от `render-access.service.spec.ts` по той же причине,
 * по которой отдельный и сам модуль: здесь правило без Prisma и без
 * сервисов, и прочитать его можно целиком, не держа в голове продукт.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_FREE_GRANT_DAILY_CAP,
  freeGrantDailyCap,
  GRANDFATHER_BEFORE,
  hasRenderRight,
  wallEnabled,
} from './free-tier';

describe('рубильник', () => {
  it('включается ровно строкой "true" — всё остальное выключено', () => {
    // Мусор в переменной не должен включать стену: цена ошибки
    // несимметрична, и «не включилось» здесь дешевле, чем «включилось
    // по опечатке у всех сразу».
    expect(wallEnabled({ FREE_TIER_WALL_ENABLED: 'true' })).toBe(true);
    expect(wallEnabled({ FREE_TIER_WALL_ENABLED: 'TRUE' })).toBe(false);
    expect(wallEnabled({ FREE_TIER_WALL_ENABLED: '1' })).toBe(false);
    expect(wallEnabled({})).toBe(false);
  });
});

describe('предохранитель бесплатных начислений', () => {
  it('ноль — законное значение, а не «сломано»', () => {
    // Ноль ставит оператор, когда приостанавливает начисления. Читать
    // его как мусор значило бы игнорировать прямое указание.
    expect(freeGrantDailyCap({ FREE_GRANT_DAILY_CAP: '0' })).toBe(0);
  });

  it('мусор и отрицательное дают умолчание, а не ноль', () => {
    // Сломанная настройка не должна молча выключать программу.
    for (const raw of ['-5', 'много', '1.5', '']) {
      expect(freeGrantDailyCap({ FREE_GRANT_DAILY_CAP: raw })).toBe(
        DEFAULT_FREE_GRANT_DAILY_CAP,
      );
    }
  });

  it('число читается как есть', () => {
    expect(freeGrantDailyCap({ FREE_GRANT_DAILY_CAP: '7' })).toBe(7);
  });
});

describe('право на рендер', () => {
  const day = (s: string) => new Date(s);

  it('подписка пускает и без разблокировки', () => {
    expect(hasRenderRight({ hasActiveSubscription: true })).toBe(true);
  });

  it('без разблокировки и без подписки права нет', () => {
    expect(hasRenderRight({})).toBe(false);
  });

  it('разблокировка без отзыва пускает', () => {
    expect(hasRenderRight({ liteUnlockedAt: day('2026-09-01') })).toBe(true);
  });

  it('отзыв ПОЗЖЕ разблокировки закрывает доступ', () => {
    expect(
      hasRenderRight({
        liteUnlockedAt: day('2026-09-01'),
        liteRevokedAt: day('2026-09-10'),
      }),
    ).toBe(false);
  });

  it('разблокировка после отзыва снова открывает — без стирания истории', () => {
    // Из этого правила само собой работает повторная выдача доступа:
    // оператору не нужно чистить поля, достаточно разблокировать заново.
    expect(
      hasRenderRight({
        liteUnlockedAt: day('2026-09-20'),
        liteRevokedAt: day('2026-09-10'),
      }),
    ).toBe(true);
  });
});

describe('дата сохранения доступа', () => {
  it('совпадает с миграцией и с пунктом 6.9.3 оферты', () => {
    // Три места называют одну дату: константа, SQL миграции и текст
    // оферты. Разойдись они — спор выиграет документ, а объясняться
    // придётся нам; поэтому сверяет их тест, а не внимательность.
    const iso = GRANDFATHER_BEFORE.toISOString().slice(0, 10);
    expect(iso).toBe('2026-09-24');

    const root = path.join(__dirname, '../..');
    const sql = fs.readFileSync(
      path.join(
        root,
        'prisma/migrations/20261216090000_free_tier_wall/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(`'${iso}T00:00:00Z'`);

    const offer = fs.readFileSync(
      path.join(root, '../doc/legal/offer.md'),
      'utf8',
    );
    expect(offer).toContain('зарегистрировавшиеся до 24 сентября 2026 года');
  });
});
