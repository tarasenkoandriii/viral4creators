/**
 * Три конфига TypeScript в `backend/` делят между собой одну
 * обязанность, и цена ошибки в этом делении уже дважды была сорванным
 * боевым деплоем.
 *
 * 1. `tsconfig.json` — то, чем компилируют ПРОДУКТ: шаг `типы` в CI и
 *    сборщик Vercel для serverless-точки входа. Здесь должны быть
 *    настоящие типы Prisma и все спеки (иначе ошибка типов в тесте не
 *    проверяется нигде: `ts-jest` в песочнице гоняет их с
 *    `diagnostics: false`).
 * 2. `tsconfig.build.json` — то, по чему собирается `dist`: без спеков,
 *    чтобы ошибка в тесте не роняла прод-сборку.
 * 3. `tsconfig.typecheck.json` — только для песочницы, где
 *    `prisma generate` недоступен (нет сети до binaries.prisma.sh).
 *    Уводит импорт `@prisma/client` на заглушку через `paths`.
 *
 * Опасность в третьем, и она изменила форму. Раньше заглушка была
 * ГЛОБАЛЬНЫМ объявлением (`declare module '@prisma/client';`): пока
 * файл лежал в дереве без исключения, его подхватывал любой конфиг,
 * собирающий файлы маской, настоящий клиент становился `any` — и
 * сборщик Vercel упал на 11 ошибках в `session.service.ts`, хотя
 * `nest build` к тому моменту уже проходил. Теперь заглушка —
 * обычный модуль (`test/types/prisma-any/index.d.ts`), и подменяет
 * клиента только `paths` песочного конфига. Утечь глобально нечему;
 * следить осталось за одним: чтобы `paths` не появился в конфиге,
 * которым компилируют продукт.
 *
 * Почему вообще понадобился `paths`: сокращённое `declare module`
 * работает, только пока пакета нет физически. В песочнице он стоит
 * (без сгенерированного `.prisma/client`), разрешение модулей находит
 * его настоящий `index.d.ts` раньше объявления, и проверка тонула в
 * сотне ошибок «namespace has no exported member».
 *
 * Проверка читает конфиги, а не компилирует: полный `tsc` по трём
 * конфигам занял бы минуты, а разъезжается здесь именно текст правил.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../..');
const read = (name: string): Record<string, unknown> =>
  JSON.parse(
    // Комментарии в tsconfig разрешены, JSON.parse их не понимает.
    fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  ) as Record<string, unknown>;

const STUB = 'test/types/prisma-any/index.d.ts';
const pathsOf = (cfg: Record<string, unknown>): Record<string, string[]> =>
  ((cfg.compilerOptions as Record<string, unknown> | undefined)?.paths ??
    {}) as Record<string, string[]>;

describe('конфиги TypeScript: разделение обязанностей', () => {
  it('tsconfig.json не подменяет @prisma/client', () => {
    // Именно этот конфиг компилирует продукт. Появись здесь подмена —
    // и настоящий клиент Prisma снова станет `any` там, где он должен
    // быть настоящим.
    expect(pathsOf(read('tsconfig.json'))['@prisma/client']).toBeUndefined();
    expect(
      pathsOf(read('tsconfig.build.json'))['@prisma/client'],
    ).toBeUndefined();
  });

  it('tsconfig.json не видит саму заглушку', () => {
    // Второй рубеж: даже если подмены нет, файл не должен попадать в
    // программу продукта маской.
    const exclude = read('tsconfig.json').exclude as string[] | undefined;
    expect(exclude).toBeDefined();
    expect(exclude!.some((e) => STUB.startsWith(e.replace(/\/$/, '')))).toBe(
      true,
    );
  });

  it('tsconfig.build.json не собирает спеки', () => {
    const exclude = read('tsconfig.build.json').exclude as string[];
    expect(exclude).toContain('**/*.spec.ts');
  });

  it('песочничный конфиг уводит импорт на заглушку', () => {
    const cfg = read('tsconfig.typecheck.json');
    expect(pathsOf(cfg)['@prisma/client']).toEqual([`./${STUB}`]);
  });

  it('заглушка на месте и не объявляет модуль глобально', () => {
    const src = fs.readFileSync(path.join(ROOT, STUB), 'utf8');
    // Обычный модуль: есть экспорты и нет объявления модуля — именно
    // глобальность прежней версии и роняла прод-сборку. Ищем начало
    // строки: в шапке файла та история рассказана словами, и упоминание
    // в комментарии ничего не объявляет.
    expect(src).toMatch(/export declare class PrismaClient/);
    expect(src).not.toMatch(/^\s*declare module/m);
  });
});
