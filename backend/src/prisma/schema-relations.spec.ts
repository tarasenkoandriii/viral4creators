/**
 * Проверка связей в `prisma/schema.prisma` без запуска `prisma generate`.
 *
 * Зачем это отдельным тестом. Схема — единственная часть проекта, которую
 * обычный прогон не проверяет вовсе: валидация живёт внутри
 * `prisma generate`, а тот в сборочной среде скачивает движки с
 * binaries.prisma.sh. Там, где сети до них нет (песочница, часть CI),
 * `generate` не отрабатывает — и ошибка схемы доживает до `vercel build`,
 * то есть выясняется отказом ПРОДАКШН-деплоя. Ровно так и случилось:
 * у `VirtualStudioFragment.variant` не было обратной стороны, сборка
 * упала с P1012 на `prisma generate`, и до этого момента ни один тест
 * ничего не заметил.
 *
 * Проверяются две вещи, обе — ошибки уровня «generate не пройдёт»:
 *
 *  1. у каждой связи есть обе стороны (P1012, «missing an opposite
 *     relation field»);
 *  2. `@relation(fields: [...])` ссылается на реально существующие
 *     скалярные поля той же модели.
 *
 * Это НЕ замена `prisma validate` — правил в схеме кратно больше. Это
 * дешёвый заслон от того класса ошибок, который уже один раз доехал до
 * прода.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

interface RelationField {
  model: string;
  name: string;
  target: string;
  /** Имя связи из `@relation("...")`; null — безымянная. */
  relationName: string | null;
  /** Скалярные поля из `@relation(fields: [...])`. */
  fields: string[];
  line: string;
}

interface ParsedSchema {
  models: Map<string, string>;
  relations: RelationField[];
  scalarsOf: Map<string, Set<string>>;
}

function parseSchema(source: string): ParsedSchema {
  const models = new Map<string, string>();
  for (const m of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    models.set(m[1], m[2]);
  }

  const relations: RelationField[] = [];
  const scalarsOf = new Map<string, Set<string>>();

  for (const [model, body] of models) {
    const scalars = new Set<string>();
    scalarsOf.set(model, scalars);

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      // Комментарии, блочные атрибуты и пустые строки полями не являются.
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

      const parsed = /^(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(line);
      if (!parsed) continue;
      const [, name, type, , rest] = parsed;

      if (!models.has(type)) {
        scalars.add(name);
        continue;
      }

      const named = /@relation\(\s*"([^"]+)"/.exec(rest);
      const fieldsAttr = /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(rest);
      relations.push({
        model,
        name,
        target: type,
        relationName: named ? named[1] : null,
        fields: fieldsAttr
          ? fieldsAttr[1]
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean)
          : [],
        line,
      });
    }
  }

  return { models, relations, scalarsOf };
}

const schema = parseSchema(readFileSync(SCHEMA_PATH, 'utf8'));

describe('prisma/schema.prisma — связи', () => {
  it('схема разобралась и в ней есть модели со связями', () => {
    // Страховка от «тест зелёный, потому что ничего не нашёл»: если
    // разбор сломается о новый синтаксис, проверки ниже станут пустыми
    // и перестанут что-либо сторожить.
    expect(schema.models.size).toBeGreaterThan(20);
    expect(schema.relations.length).toBeGreaterThan(50);
  });

  it('у каждой связи есть обратная сторона — иначе generate падает с P1012', () => {
    const broken = schema.relations.filter((rel) => {
      const otherBody = schema.models.get(rel.target) ?? '';
      const backRefs = [
        ...otherBody.matchAll(/^\s*(\w+)\s+(\w+)(\[\])?\??(.*)$/gm),
      ]
        .filter(([, , type]) => type === rel.model)
        .filter(([, , , , rest]) => {
          const named = /@relation\(\s*"([^"]+)"/.exec(rest ?? '');
          return (named ? named[1] : null) === rel.relationName;
        });
      return backRefs.length === 0;
    });

    expect(
      broken.map((r) => `${r.model}.${r.name} -> ${r.target}: ${r.line}`),
    ).toEqual([]);
  });

  it('@relation(fields: [...]) ссылается на существующие поля своей модели', () => {
    const dangling: string[] = [];
    for (const rel of schema.relations) {
      const scalars = schema.scalarsOf.get(rel.model) ?? new Set<string>();
      for (const field of rel.fields) {
        if (!scalars.has(field)) {
          dangling.push(`${rel.model}.${rel.name}: нет поля "${field}"`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});
