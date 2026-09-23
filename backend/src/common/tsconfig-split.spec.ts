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
 *    Подключает объявление `@prisma/client` как `any`.
 *
 * Опасность в третьем: объявление модуля — ГЛОБАЛЬНОЕ, и пока файл
 * лежал в дереве без исключения, его подхватывал любой конфиг,
 * собирающий файлы маской. Настоящий клиент становился `any` — и
 * сборщик Vercel упал на 11 ошибках в `session.service.ts`, хотя
 * `nest build` к тому моменту уже проходил. Отсюда `exclude` в
 * `tsconfig.json` и явный `files` в конфиге проверки: `exclude` на
 * `files` не распространяется, поэтому файл виден ровно одному
 * конфигу.
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

const AMBIENT = 'test/types/prisma-client-ambient.d.ts';

describe('конфиги TypeScript: разделение обязанностей', () => {
  it('tsconfig.json не видит объявления @prisma/client как any', () => {
    // Именно этот конфиг компилирует продукт. Уберите строку — и
    // настоящий клиент Prisma снова станет `any` там, где он должен
    // быть настоящим.
    const exclude = read('tsconfig.json').exclude as string[] | undefined;
    expect(exclude).toBeDefined();
    expect(exclude!.some((e) => AMBIENT.startsWith(e.replace(/\/$/, '')))).toBe(
      true,
    );
  });

  it('tsconfig.build.json не собирает спеки', () => {
    const exclude = read('tsconfig.build.json').exclude as string[];
    expect(exclude).toContain('**/*.spec.ts');
  });

  it('песочничный конфиг подключает объявление ЯВНО, через files', () => {
    // Через `include` не получится: `exclude` из родителя его отрежет.
    const cfg = read('tsconfig.typecheck.json');
    expect(cfg.files).toEqual([AMBIENT]);
  });

  it('файл объявления на месте и объявляет именно @prisma/client', () => {
    const src = fs.readFileSync(path.join(ROOT, AMBIENT), 'utf8');
    expect(src).toMatch(/declare module '@prisma\/client';/);
  });
});
