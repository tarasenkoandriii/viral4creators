/**
 * Умолчание для поля тегов панели публикации (ТЗ
 * TZ-Multilingual-YouTube.md, этап 136).
 *
 * ## Зачем
 *
 * Теги — главный рычаг разгона ролика, а поле для них было пустым: в
 * него никто ничего не вписывал, и заявки уходили с двумя тегами,
 * которые сервер досыпал сам уже ПОСЛЕ отправки (категория и название
 * товара) — человек их не видел и повлиять на них не мог. Этап
 * переворачивает порядок: то же умолчание показывается ДО отправки, в
 * поле ввода, где его можно править.
 *
 * ## Почему запасной источник обязателен
 *
 * Тегов у исходника может не быть сразу по трём причинам: автор их не
 * заполнил; референс пришёл файлом, а не ссылкой на YouTube; вызов к
 * Google не удался. Во всех трёх случаях поле не должно оставаться
 * пустым — иначе этап не делает ничего для тех, у кого тегов нет, а
 * это большинство.
 *
 * ## Почему это чистая функция, а не выражение в компоненте
 *
 * Правило важнее, чем выглядит: в нём и приоритет источников, и то, что
 * умолчание считается ОДИН раз и больше не трогает правку человека.
 * Оба свойства проверяются тестом, а из тела компонента их не достать.
 */

/** Источники умолчания, в порядке убывания осмысленности. */
export interface TagDefaultsInput {
  /** Теги исходного ролика, если референс пришёл ссылкой на YouTube. */
  sourceTags?: string[] | null;
  productName?: string | null;
  category?: string | null;
}

/**
 * Те же правила нормализации, что у сервера (`uniqueTags` в
 * `publication.service.ts`): решётка в начале убирается, регистр не
 * создаёт дубля, пустые отбрасываются, длина тега ≤ 60, список ≤ 30 и
 * ≤ 500 символов суммарно — потолок YouTube на всё свойство
 * `snippet.tags` (тег с пробелом уезжает в кавычках, и они в потолок
 * тоже считаются). Совпадение не случайное: человек должен видеть в
 * поле ровно то, что уйдёт, а не то, что сервер потом молча урежет, —
 * и уж точно не узнавать о потолке из проваленной публикации.
 */
const TAG_LIST_BUDGET = 500;
const tagCost = (tag: string) => tag.length + (/\s/.test(tag) ? 2 : 0);

export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let budget = TAG_LIST_BUDGET;
  for (const t of raw) {
    const v = t.trim().replace(/^#/, '').slice(0, 60);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    const cost = tagCost(v);
    if (cost > budget) break;
    budget -= cost;
    seen.add(key);
    out.push(v);
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * Умолчание для поля: теги исходника, если они есть; иначе — то, что
 * продукт про ролик и так знает. Никогда не пустое, если известно хоть
 * что-то одно.
 */
export function defaultTags(input: TagDefaultsInput): string[] {
  const source = normalizeTags(input.sourceTags ?? []);
  if (source.length > 0) return source;
  return normalizeTags([
    ...(input.category ? [input.category] : []),
    ...(input.productName ? [input.productName] : []),
  ]);
}

/** Строка для `<input>`: теги через запятую с пробелом. */
export function tagsToInput(tags: readonly string[]): string {
  return tags.join(', ');
}

/** Обратный разбор строки поля в список тегов для заявки. */
export function tagsFromInput(value: string): string[] {
  return normalizeTags(value.split(/[,\n]/));
}
