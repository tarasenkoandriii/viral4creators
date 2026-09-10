/**
 * Разбор товарного фида — YML (Yandex Market Language, де-факто
 * стандарт Rozetka/Prom.ua и большинства украинских магазинов) и CSV
 * (запасной вариант, если продавец выгружает таблицу вручную). Этап
 * 68, ТЗ TODO §Уровень 2 п.8, §47.
 *
 * ## Почему разбор терпимый, а не строгий
 *
 * Тот же принцип, что уже применён к ответу модели в
 * `voiceover-script.ts`/`ab-variant-response.ts`: источник — не наш
 * код, а чужая система (Shopify-плагин, WooCommerce-экспортёр,
 * «Мой склад», ручная выгрузка в Excel), и у каждой свои мелкие
 * отклонения от спецификации YML или свои названия колонок CSV.
 * Строгий разбор означал бы «фид не подошёл» на ровном месте для
 * добросовестного продавца. Здесь — распознавание синонимов заголовков
 * CSV, автоопределение разделителя (запятая/точка-с-запятой), и
 * НИКАКОГО отбрасывания строк на этапе разбора: строка без названия
 * или цены всё равно возвращается (с пустыми полями) — решение,
 * пропустить её или нет, принимает воркер импорта
 * (`product-feed-import-worker.service.ts`), который умеет объяснить
 * пользователю причину пропуска. Парсер здесь только читает, не судит.
 *
 * ## Почему YML не через ручной regex-разбор
 *
 * YML — обычный XML с вложенностью (`<offer>` внутри `<offers>`,
 * лукап категории через отдельный `<categories>`), и вытаскивать это
 * регулярками означало бы заново писать XML-парсер похуже готового.
 * `fast-xml-parser` — чистый JS, без нативных зависимостей, что важно
 * для serverless-окружения Vercel.
 */

import { XMLParser } from 'fast-xml-parser';

export type FeedFormat = 'yml' | 'csv';

/**
 * Одна строка фида как есть, без валидации — обязательные поля могут
 * быть пустыми/`null`; их проверяет воркер импорта перед созданием
 * товара (§47: нет названия/цены → SKIPPED, валюта не совпадает с
 * валютой проекта → SKIPPED).
 */
export interface ParsedFeedRow {
  externalId?: string;
  title: string;
  price: number | null;
  currency: string | null;
  description?: string;
  photoUrl?: string;
  categoryText?: string;
}

/**
 * Формат определяется по СОДЕРЖИМОМУ (первый непробельный символ —
 * `<`), а не только по `Content-Type`: многие серверы отдают XML-фид
 * как `text/plain` или вовсе без заголовка. `Content-Type` — только
 * запасной сигнал, когда тело нельзя просмотреть (пусто/бинарно).
 */
export function detectFeedFormat(
  contentType: string | null | undefined,
  body: string,
): FeedFormat {
  const head = body.slice(0, 2000).trimStart();
  if (head.startsWith('<')) return 'yml';
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('xml')) return 'yml';
  return 'csv';
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Текстовое содержимое узла fast-xml-parser: простой узел без
 * атрибутов приходит строкой/числом, узел С атрибутами (например
 * `<category id="2">Телефоны</category>`) — объектом с `#text`.
 */
function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && node !== null && '#text' in node) {
    const t = (node as Record<string, unknown>)['#text'];
    if (t == null) return '';
    return typeof t === 'string' ? t.trim() : String(t).trim();
  }
  return '';
}

function attrOf(node: unknown, name: string): string {
  if (node == null || typeof node !== 'object') return '';
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return v == null ? '' : String(v).trim();
}

/** Дочерний узел по имени тега — без приведения к `any`: узел из
 * fast-xml-parser типизирован как `unknown`, потому что заранее
 * неизвестно, простой он (строка/число) или составной (объект). */
function childOf(node: unknown, name: string): unknown {
  if (node == null || typeof node !== 'object') return undefined;
  return (node as Record<string, unknown>)[name];
}

/**
 * Цена как число — терпимо к запятой вместо точки и валютным
 * символам, которые иногда просачиваются в текст узла (`"199,99 грн"`).
 */
function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(',', '.');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Разбор YML — `<offer>` внутри `<shop><offers>`, категория —
 * отдельным лукапом через `<shop><categories><category id>`
 * (спецификация YML держит название категории отдельно от товара,
 * связывая их только числовым id).
 */
export function parseYmlFeed(xml: string): ParsedFeedRow[] {
  let parsed: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => name === 'offer' || name === 'category',
    });
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const shop = childOf(childOf(parsed, 'yml_catalog'), 'shop');
  if (!shop) return [];

  const categoryById = new Map<string, string>();
  for (const cat of toArray(childOf(childOf(shop, 'categories'), 'category'))) {
    const id = attrOf(cat, 'id');
    if (id) categoryById.set(id, textOf(cat));
  }

  const rows: ParsedFeedRow[] = [];
  for (const offer of toArray(childOf(childOf(shop, 'offers'), 'offer'))) {
    const title =
      textOf(childOf(offer, 'name')) || textOf(childOf(offer, 'model')) || '';
    const currencyText = textOf(childOf(offer, 'currencyId'));
    const categoryId = textOf(childOf(offer, 'categoryId'));
    const externalId = attrOf(offer, 'id');
    rows.push({
      externalId: externalId || undefined,
      title,
      price: parsePrice(childOf(offer, 'price')),
      currency: currencyText ? currencyText.toUpperCase() : null,
      description: textOf(childOf(offer, 'description')) || undefined,
      photoUrl: textOf(childOf(offer, 'picture')) || undefined,
      categoryText: categoryId ? categoryById.get(categoryId) : undefined,
    });
  }
  return rows;
}

type CsvFieldKey =
  | 'externalId'
  | 'title'
  | 'price'
  | 'currency'
  | 'description'
  | 'photoUrl'
  | 'categoryText';

/** Синонимы заголовков — украинский/русский/английский, все варианты в нижнем регистре. */
const CSV_HEADER_SYNONYMS: Record<CsvFieldKey, string[]> = {
  externalId: ['id', 'sku', 'артикул', 'код', 'код товару'],
  title: ['name', 'title', 'название', 'назва', 'товар', 'наименование'],
  price: ['price', 'цена', 'ціна', 'вартість', 'стоимость'],
  currency: ['currency', 'валюта'],
  description: ['description', 'описание', 'опис'],
  photoUrl: ['photo', 'image', 'picture', 'фото', 'изображение', 'зображення'],
  categoryText: ['category', 'категория', 'категорія'],
};

function detectDelimiter(firstLine: string): string {
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

/**
 * Минимальный, но корректный построчный разбор CSV с поддержкой
 * кавычек (включая экранирование `""` и делимитеры/переносы строк
 * внутри кавычек) — своими силами, без библиотеки: терпимый разбор
 * заголовков и разделителя уже требует «понимания формата», а не
 * готового строгого CSV-парсера, который сломается на первой же
 * нестандартной выгрузке (лишний BOM, разная кодировка переноса строк).
 */
function splitCsvRows(text: string, delimiter: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

function buildColumnIndex(
  headers: string[],
): Partial<Record<CsvFieldKey, number>> {
  const index: Partial<Record<CsvFieldKey, number>> = {};
  headers.forEach((raw, i) => {
    const normalized = raw.trim().toLowerCase();
    for (const key of Object.keys(CSV_HEADER_SYNONYMS) as CsvFieldKey[]) {
      if (index[key] !== undefined) continue;
      if (CSV_HEADER_SYNONYMS[key].includes(normalized)) index[key] = i;
    }
  });
  return index;
}

export function parseCsvFeed(csv: string): ParsedFeedRow[] {
  const firstLine = csv.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const rows = splitCsvRows(csv, delimiter);
  if (rows.length === 0) return [];

  const [headerRow, ...dataRows] = rows;
  const columns = buildColumnIndex(headerRow);
  const cell = (row: string[], key: CsvFieldKey): string => {
    const i = columns[key];
    return i === undefined ? '' : (row[i] ?? '').trim();
  };

  return dataRows.map((row) => {
    const currency = cell(row, 'currency');
    return {
      externalId: cell(row, 'externalId') || undefined,
      title: cell(row, 'title'),
      price: parsePrice(cell(row, 'price')),
      currency: currency ? currency.toUpperCase() : null,
      description: cell(row, 'description') || undefined,
      photoUrl: cell(row, 'photoUrl') || undefined,
      categoryText: cell(row, 'categoryText') || undefined,
    };
  });
}

/** Единая точка входа — распознаёт формат и делегирует нужному разборщику. */
export function parseFeed(
  contentType: string | null | undefined,
  body: string,
): { format: FeedFormat; rows: ParsedFeedRow[] } {
  const format = detectFeedFormat(contentType, body);
  const rows = format === 'yml' ? parseYmlFeed(body) : parseCsvFeed(body);
  return { format, rows };
}
