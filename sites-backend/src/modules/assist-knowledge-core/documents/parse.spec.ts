/**
 * Разбор документов знаний (K3, §3.4): PDF/DOCX/TXT/MD/CSV → блоки
 * чанкера, проверка типа по MIME+расширению и по сигнатуре байтов,
 * «в файле нет текста» для скана, лимит 20 МБ.
 */
import { execFileSync } from 'child_process';
import {
  DocumentParseError,
  bodyMatchesFormat,
  formatFor,
  parseDocument,
  safeFileName,
} from './parse';
import { blocksFromCsv, blocksFromMarkdown, detectLang } from './text-blocks';
import { makeDocx, makePdf } from './testing/doc-fixtures.testing';

/**
 * unpdf грузит pdf.js динамическим `import()` ESM-сборки — в проде (Node,
 * CommonJS) это работает, а в VM jest без --experimental-vm-modules нет.
 * Поэтому НАСТОЯЩИЙ unpdf запускается в дочернем Node: разбор проверяется
 * той же библиотекой, а не подделкой.
 */
jest.mock('unpdf', () => ({
  extractText: async (data: Uint8Array) => {
    const script =
      "const {extractText}=require('unpdf');" +
      "let b='';process.stdin.on('data',d=>b+=d).on('end',async()=>{" +
      "try{const r=await extractText(new Uint8Array(Buffer.from(b,'base64')),{mergePages:false});" +
      'process.stdout.write(JSON.stringify({ok:true,text:r.text}))}' +
      'catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e)}))}})';
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      input: Buffer.from(data).toString('base64'),
    }).toString();
    const r = JSON.parse(out) as {
      ok: boolean;
      text?: string[];
      error?: string;
    };
    if (!r.ok) throw new Error(r.error);
    return { totalPages: r.text?.length ?? 0, text: r.text ?? [] };
  },
}));

async function parseErr(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof DocumentParseError ? e.code : String(e);
  }
}

describe('formatFor — объявленный тип', () => {
  it.each([
    ['price.pdf', 'application/pdf', 'pdf'],
    [
      'terms.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    ],
    ['notes.txt', 'text/plain', 'txt'],
    ['README.md', 'text/markdown', 'md'],
    ['README.md', 'text/plain', 'md'],
    ['price.csv', 'text/csv', 'csv'],
    ['price.CSV', 'text/plain; charset=utf-8', 'csv'],
  ])('%s + %s → %s', (name, mime, fmt) => {
    expect(formatFor(name, mime)).toBe(fmt);
  });

  it.each([
    ['evil.exe', 'application/pdf'],
    ['photo.png', 'image/png'],
    ['doc.pdf', 'text/plain'],
    ['page.html', 'text/html'],
    ['noext', 'text/plain'],
    ['old.doc', 'application/msword'],
  ])('%s + %s → null', (name, mime) => {
    expect(formatFor(name, mime)).toBeNull();
  });
});

describe('safeFileName', () => {
  it('без каталогов и управляющих символов', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\x\\Прайс 2026.pdf')).toBe('Прайс 2026.pdf');
    expect(safeFileName('a\u0000b<script>.pdf')).toBe('ab_script_.pdf');
    expect(safeFileName('...')).toBe('document');
  });
});

describe('bodyMatchesFormat — фактический тип', () => {
  it('PDF/DOCX по сигнатуре, текст — валидный UTF-8 без NUL', () => {
    expect(bodyMatchesFormat(makePdf(['x']), 'pdf')).toBe(true);
    expect(bodyMatchesFormat(Buffer.from('hello'), 'pdf')).toBe(false);
    expect(bodyMatchesFormat(makeDocx([{ p: 'x' }]), 'docx')).toBe(true);
    expect(bodyMatchesFormat(makePdf(['x']), 'docx')).toBe(false);
    expect(bodyMatchesFormat(Buffer.from('Привіт'), 'txt')).toBe(true);
    expect(bodyMatchesFormat(Buffer.from([0x41, 0x00, 0x42]), 'txt')).toBe(
      false,
    );
    expect(bodyMatchesFormat(Buffer.from([0xc3, 0x28]), 'csv')).toBe(false);
  });
});

describe('parseDocument', () => {
  it('PDF с текстовым слоем → блоки с артикулом', async () => {
    const r = await parseDocument(
      makePdf(['Delivery ABC-1234 costs 150 UAH', 'Pickup is free']),
      'pdf',
      'price-list.pdf',
    );
    expect(r.title).toBe('price-list');
    expect(r.lang).toBe('en');
    expect(r.blocks.map((b) => b.text).join(' ')).toContain('ABC-1234');
    expect(r.blocks.every((b) => b.t === 'p')).toBe(true);
  });

  it('PDF без текста (скан) → DOCUMENT_NO_TEXT с понятной фразой', async () => {
    const p = parseDocument(makePdf([]), 'pdf', 'scan.pdf');
    await expect(p).rejects.toThrow(/текстовый PDF/);
    expect(await parseErr(parseDocument(makePdf([]), 'pdf', 'scan.pdf'))).toBe(
      'DOCUMENT_NO_TEXT',
    );
  });

  it('«PDF», который не PDF → DOCUMENT_TYPE (сигнатура важнее имени)', async () => {
    expect(
      await parseErr(parseDocument(Buffer.from('MZ\x90\x00'), 'pdf', 'x.pdf')),
    ).toBe('DOCUMENT_TYPE');
  });

  it('«текст» с NUL-байтами или не UTF-8 → DOCUMENT_TYPE (бинарник под видом TXT/CSV)', async () => {
    const bin = Buffer.from('Ціна 1200\u0000\u0001\u0002 грн');
    expect(await parseErr(parseDocument(bin, 'txt', 'x.txt'))).toBe(
      'DOCUMENT_TYPE',
    );
    expect(
      await parseErr(
        parseDocument(Buffer.from([0x41, 0x3b, 0xc3, 0x28]), 'csv', 'x.csv'),
      ),
    ).toBe('DOCUMENT_TYPE');
  });

  it('битый PDF с верной сигнатурой → DOCUMENT_TYPE', async () => {
    expect(
      await parseErr(
        parseDocument(Buffer.from('%PDF-1.4\nмусор'), 'pdf', 'x.pdf'),
      ),
    ).toBe('DOCUMENT_TYPE');
  });

  it('больше 20 МБ → DOCUMENT_TOO_LARGE до разбора', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61);
    expect(await parseErr(parseDocument(big, 'txt', 'big.txt'))).toBe(
      'DOCUMENT_TOO_LARGE',
    );
  });

  it('DOCX: заголовки → путь, таблица → «заголовок: значение»', async () => {
    const r = await parseDocument(
      makeDocx([
        { h: 1, text: 'Умови доставки' },
        { p: 'Доставка по Україні — 2–3 дні.' },
        { h: 2, text: 'Ціни' },
        {
          table: [
            ['Товар', 'Ціна'],
            ['Чайник ABC-1234', '1 200 грн'],
          ],
        },
      ]),
      'docx',
      'umovy.docx',
    );
    expect(r.title).toBe('Умови доставки');
    expect(r.lang).toBe('uk');
    expect(r.blocks).toEqual([
      { t: 'h', text: 'Умови доставки', level: 1, path: [] },
      {
        t: 'p',
        text: 'Доставка по Україні — 2–3 дні.',
        path: ['Умови доставки'],
      },
      { t: 'h', text: 'Ціни', level: 2, path: ['Умови доставки'] },
      {
        t: 'tr',
        text: 'Товар: Чайник ABC-1234; Ціна: 1 200 грн',
        path: ['Умови доставки', 'Ціни'],
      },
    ]);
  });

  it('DOCX, который не zip → DOCUMENT_TYPE; zip без документа → DOCUMENT_TYPE', async () => {
    expect(
      await parseErr(parseDocument(Buffer.from('hello'), 'docx', 'a.docx')),
    ).toBe('DOCUMENT_TYPE');
    const notWord = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(await parseErr(parseDocument(notWord, 'docx', 'a.docx'))).toBe(
      'DOCUMENT_TYPE',
    );
  });

  it('MD: путь заголовков, списки, таблицы, код; ссылки — только текст', async () => {
    const md = [
      '# Доставка',
      'Отправляем [Новой почтой](https://evil.example/x), быстро.',
      '## По Украине',
      '- Киев — 1 день',
      '- Львов — 2 дня',
      '',
      '| Город | Срок |',
      '|---|---|',
      '| Одесса | 3 дня |',
      '```',
      'код 42',
      '```',
    ].join('\n');
    const r = await parseDocument(Buffer.from(md), 'md', 'delivery.md');
    expect(r.title).toBe('Доставка');
    expect(r.lang).toBe('ru');
    expect(r.blocks).toEqual([
      { t: 'h', text: 'Доставка', level: 1, path: [] },
      {
        t: 'p',
        text: 'Отправляем Новой почтой, быстро.',
        path: ['Доставка'],
      },
      { t: 'h', text: 'По Украине', level: 2, path: ['Доставка'] },
      { t: 'li', text: 'Киев — 1 день', path: ['Доставка', 'По Украине'] },
      { t: 'li', text: 'Львов — 2 дня', path: ['Доставка', 'По Украине'] },
      {
        t: 'tr',
        text: 'Город: Одесса; Срок: 3 дня',
        path: ['Доставка', 'По Украине'],
      },
      { t: 'pre', text: 'код 42', path: ['Доставка', 'По Украине'] },
    ]);
    expect(JSON.stringify(r.blocks)).not.toContain('evil.example');
  });

  it('CSV: кавычки, ; как разделитель, строка = блок tr', async () => {
    const csv =
      '\uFEFFАртикул;Назва;Ціна\nABC-1234;"Чайник; сталь";1200\nXYZ-9;"Ложка ""люкс""";99\n';
    const r = await parseDocument(Buffer.from(csv), 'csv', 'price.csv');
    expect(r.blocks).toEqual([
      {
        t: 'tr',
        text: 'Артикул: ABC-1234; Назва: Чайник; сталь; Ціна: 1200',
        path: [],
      },
      {
        t: 'tr',
        text: 'Артикул: XYZ-9; Назва: Ложка "люкс"; Ціна: 99',
        path: [],
      },
    ]);
  });

  it('TXT: абзацы по пустой строке; пустой файл → DOCUMENT_NO_TEXT', async () => {
    const r = await parseDocument(
      Buffer.from('Первый абзац\nпродолжение.\n\nВторой абзац.'),
      'txt',
      'a.txt',
    );
    expect(r.blocks.map((b) => b.text)).toEqual([
      'Первый абзац продолжение.',
      'Второй абзац.',
    ]);
    expect(
      await parseErr(parseDocument(Buffer.from(' \n\n '), 'txt', 'e.txt')),
    ).toBe('DOCUMENT_NO_TEXT');
  });

  it('огромный текст обрезается флагом truncated, а не молча', async () => {
    const para = 'слово '.repeat(1000);
    const body = Buffer.from(
      Array.from({ length: 400 }, () => para).join('\n\n'),
    );
    const r = await parseDocument(body, 'txt', 'big.txt');
    expect(r.truncated).toBe(true);
    expect(r.blocks.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(
      1_000_000,
    );
  });
});

describe('text-blocks', () => {
  it('detectLang: uk/ru/en/null', () => {
    expect(detectLang('Привіт, як справи? Їжа є')).toBe('uk');
    expect(detectLang('Привет, как дела? Съешь ещё')).toBe('ru');
    expect(detectLang('Hello world')).toBe('en');
    expect(detectLang('12345')).toBeNull();
  });

  it('CSV из одной строки — значения без заголовков', () => {
    expect(blocksFromCsv('a,b,c')).toEqual([
      { t: 'tr', text: 'a; b; c', path: [] },
    ]);
  });

  it('MD: заголовок того же уровня сбрасывает путь', () => {
    const b = blocksFromMarkdown('# A\n## B\ntext\n## C\nmore');
    expect(b.find((x) => x.text === 'more')?.path).toEqual(['A', 'C']);
  });
});
