/**
 * Разбор документа в блоки — K3 (§3.4): PDF (unpdf), DOCX (mammoth →
 * raw text/HTML → те же блоки, что у страницы), TXT, MD (заголовки # →
 * путь), CSV (строка = «заголовок: значение; …»). ≤ 20 МБ; пустой
 * текст (скан PDF без текстового слоя) — ошибка с понятной причиной
 * («в файле нет текста — пришлите текстовый PDF»), OCR в Э1 нет.
 *
 * Тип проверяется ДВАЖДЫ: объявленный (MIME + расширение — `formatFor`,
 * до выдачи токена загрузки) и фактический (сигнатура байтов —
 * `assertBodyMatches`, после загрузки): токен Blob ограничивает только
 * заголовок Content-Type, который задаёт клиент, а не содержимое.
 */
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';
import type { ExtractedBlock } from '../../site-crawl/types';
import {
  blocksFromCsv,
  blocksFromMarkdown,
  blocksFromPlainText,
  blocksFromSimpleHtml,
  cleanText,
  detectLang,
} from './text-blocks';

export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'md' | 'csv';

export interface ParsedDocument {
  title: string | null;
  lang: string | null;
  blocks: ExtractedBlock[];
  /** Текста больше MAX_DOCUMENT_TEXT_CHARS — хвост отброшен (честно, флагом). */
  truncated?: boolean;
}

export type DocumentErrorCode =
  'DOCUMENT_TYPE' | 'DOCUMENT_TOO_LARGE' | 'DOCUMENT_NO_TEXT';

/** Ошибка разбора с кодом для TMA и фразой для владельца. */
export class DocumentParseError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

/**
 * Потолок извлечённого текста: 1 млн символов ≈ 250 тыс. токенов ≈ $0.04
 * эмбеддингов — больше одним файлом бюджет обучения Trial ($0.5) не
 * вытянет, а «прайс на 20 МБ» почти всегда таблица, которую лучше
 * загрузить CSV.
 */
export const MAX_DOCUMENT_TEXT_CHARS = KNOWLEDGE_DEFAULTS.maxDocumentTextChars;

const MIME_FORMAT: Readonly<Record<string, DocumentFormat>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

const EXT_FORMAT: Readonly<Record<string, DocumentFormat>> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
};

/** MIME + расширение → формат; несогласие или чужой тип — null (DOCUMENT_TYPE). */
export function formatFor(
  fileName: string,
  mimeType: string,
): DocumentFormat | null {
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (
    !(KNOWLEDGE_DEFAULTS.documentMimeTypes as readonly string[]).includes(mime)
  ) {
    return null;
  }
  const byMime = MIME_FORMAT[mime];
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  const byExt = ext ? EXT_FORMAT[ext] : undefined;
  if (!byExt) return null;
  // Браузеры отдают .md как text/plain, а .csv — как text/plain или
  // text/csv: текстовые форматы между собой совместимы, решает расширение.
  const textual = (f: DocumentFormat) =>
    f === 'txt' || f === 'md' || f === 'csv';
  if (byMime === byExt) return byExt;
  if (textual(byMime) && textual(byExt)) return byExt;
  return null;
}

/** Имя файла для пути Blob и показа: без каталогов, без управляющих символов. */
export function safeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  return cleaned || 'document';
}

function titleFromFileName(fileName: string): string | null {
  const t = safeFileName(fileName)
    .replace(/\.[a-z0-9]+$/i, '')
    .trim();
  return t || null;
}

function isUtf8Text(body: Buffer): boolean {
  if (body.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/** Сигнатура байтов совпадает с форматом (иначе DOCUMENT_TYPE). */
export function bodyMatchesFormat(
  body: Buffer,
  format: DocumentFormat,
): boolean {
  switch (format) {
    case 'pdf':
      return body.subarray(0, 1024).toString('latin1').includes('%PDF-');
    case 'docx':
      // DOCX — zip; mammoth сам проверит, что внутри word/document.xml.
      return body.length > 4 && body.readUInt32LE(0) === 0x04034b50;
    default:
      return isUtf8Text(body);
  }
}

function capText(blocks: ExtractedBlock[]): {
  blocks: ExtractedBlock[];
  truncated: boolean;
} {
  let total = 0;
  const out: ExtractedBlock[] = [];
  for (const b of blocks) {
    if (total + b.text.length > MAX_DOCUMENT_TEXT_CHARS) {
      return { blocks: out, truncated: true };
    }
    total += b.text.length;
    out.push(b);
  }
  return { blocks: out, truncated: false };
}

async function pdfBlocks(body: Buffer): Promise<ExtractedBlock[]> {
  const { extractText } = await import('unpdf');
  let pages: string[];
  try {
    const r = await extractText(new Uint8Array(body), { mergePages: false });
    pages = r.text;
  } catch {
    throw new DocumentParseError(
      'DOCUMENT_TYPE',
      'Не удалось прочитать PDF — файл повреждён или защищён паролем',
    );
  }
  const out: ExtractedBlock[] = [];
  for (const page of pages) out.push(...blocksFromPlainText(page));
  return out;
}

async function docxBlocks(
  body: Buffer,
): Promise<{ blocks: ExtractedBlock[]; firstHeading: string | null }> {
  const mammoth = await import('mammoth');
  let html: string;
  try {
    // Картинки не нужны (текст знаний) и раздувают HTML base64 — выкидываем.
    const r = await mammoth.convertToHtml(
      { buffer: body },
      {
        convertImage: mammoth.images.imgElement(() =>
          Promise.resolve({ src: '' }),
        ),
      },
    );
    html = r.value;
  } catch {
    throw new DocumentParseError(
      'DOCUMENT_TYPE',
      'Не удалось прочитать DOCX — файл повреждён или это не документ Word',
    );
  }
  return blocksFromSimpleHtml(html);
}

export async function parseDocument(
  body: Buffer,
  format: DocumentFormat,
  fileName: string,
): Promise<ParsedDocument> {
  if (body.length > KNOWLEDGE_DEFAULTS.maxDocumentBytes) {
    throw new DocumentParseError(
      'DOCUMENT_TOO_LARGE',
      'Файл больше 20 МБ — разделите его на части',
    );
  }
  if (!bodyMatchesFormat(body, format)) {
    throw new DocumentParseError(
      'DOCUMENT_TYPE',
      'Содержимое файла не совпадает с его типом — загрузите PDF, DOCX, TXT, MD или CSV',
    );
  }

  let blocks: ExtractedBlock[];
  let title = titleFromFileName(fileName);
  switch (format) {
    case 'pdf':
      blocks = await pdfBlocks(body);
      break;
    case 'docx': {
      const r = await docxBlocks(body);
      blocks = r.blocks;
      if (r.firstHeading) title = r.firstHeading;
      break;
    }
    case 'md': {
      const text = body.toString('utf8').replace(/^﻿/, '');
      blocks = blocksFromMarkdown(text);
      const h1 = blocks.find((b) => b.t === 'h' && b.level === 1);
      if (h1) title = h1.text;
      break;
    }
    case 'csv':
      blocks = blocksFromCsv(body.toString('utf8'));
      break;
    case 'txt':
      blocks = blocksFromPlainText(body.toString('utf8').replace(/^﻿/, ''));
      break;
  }

  blocks = blocks
    .map((b) => ({ ...b, text: b.t === 'pre' ? cleanText(b.text) : b.text }))
    .filter((b) => b.text.length > 0);
  if (
    blocks.length === 0 ||
    blocks.every((b) => !/[\p{L}\p{N}]/u.test(b.text))
  ) {
    throw new DocumentParseError(
      'DOCUMENT_NO_TEXT',
      format === 'pdf'
        ? 'В файле нет текста — похоже на скан. Пришлите текстовый PDF (OCR пока не поддерживается)'
        : 'В файле нет текста',
    );
  }
  const capped = capText(blocks);
  const lang = detectLang(capped.blocks.map((b) => b.text).join('\n'));
  return {
    title,
    lang,
    blocks: capped.blocks,
    ...(capped.truncated ? { truncated: true } : {}),
  };
}
