import {
  detectFeedFormat,
  parseCsvFeed,
  parseFeed,
  parseYmlFeed,
} from './product-feed';

describe('detectFeedFormat', () => {
  it('тело начинается с "<" — YML, даже без Content-Type', () => {
    expect(detectFeedFormat(null, '<?xml version="1.0"?><yml_catalog/>')).toBe(
      'yml',
    );
  });

  it('Content-Type содержит xml — YML, даже если тело не с "<" (например, с BOM)', () => {
    expect(detectFeedFormat('application/xml; charset=utf-8', '  ')).toBe(
      'yml',
    );
  });

  it('ни признака XML — CSV по умолчанию', () => {
    expect(detectFeedFormat('text/csv', 'name,price\nТовар,100')).toBe('csv');
    expect(detectFeedFormat(null, 'name,price\nТовар,100')).toBe('csv');
  });
});

describe('parseYmlFeed', () => {
  const wrap = (offers: string, categories = '') => `
    <?xml version="1.0" encoding="UTF-8"?>
    <yml_catalog date="2026-09-09">
      <shop>
        <categories>${categories}</categories>
        <offers>${offers}</offers>
      </shop>
    </yml_catalog>
  `;

  it('базовый offer: имя, цена, валюта, описание (CDATA), фото, категория через лукап', () => {
    const xml = wrap(
      `<offer id="123">
        <name>Смартфон X</name>
        <price>19999.99</price>
        <currencyId>UAH</currencyId>
        <description><![CDATA[Хороший телефон]]></description>
        <picture>https://shop.test/x.jpg</picture>
        <categoryId>5</categoryId>
      </offer>`,
      `<category id="5">Телефоны</category>`,
    );
    const rows = parseYmlFeed(xml);
    expect(rows).toEqual([
      {
        externalId: '123',
        title: 'Смартфон X',
        price: 19999.99,
        currency: 'UAH',
        description: 'Хороший телефон',
        photoUrl: 'https://shop.test/x.jpg',
        categoryText: 'Телефоны',
      },
    ]);
  });

  it('нет <name> — берёт <model> как заголовок', () => {
    const xml = wrap(
      `<offer id="1"><model>Модель Y</model><price>100</price></offer>`,
    );
    expect(parseYmlFeed(xml)[0].title).toBe('Модель Y');
  });

  it('цена с запятой и валютным текстом разбирается как число', () => {
    const xml = wrap(
      `<offer id="1"><name>Товар</name><price>199,99 грн</price></offer>`,
    );
    expect(parseYmlFeed(xml)[0].price).toBeCloseTo(199.99);
  });

  it('единственный offer (не массив в XML) распознаётся так же, как несколько', () => {
    const xml = wrap(
      `<offer id="1"><name>Один</name><price>50</price></offer>`,
    );
    const rows = parseYmlFeed(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Один');
  });

  it('несколько offer — все попадают в результат по порядку', () => {
    const xml = wrap(
      `<offer id="1"><name>Первый</name><price>10</price></offer>` +
        `<offer id="2"><name>Второй</name><price>20</price></offer>`,
    );
    const rows = parseYmlFeed(xml);
    expect(rows.map((r) => r.title)).toEqual(['Первый', 'Второй']);
  });

  it('categoryId без соответствующей <category> в справочнике — categoryText не заполняется', () => {
    const xml = wrap(
      `<offer id="1"><name>Товар</name><price>10</price><categoryId>999</categoryId></offer>`,
    );
    expect(parseYmlFeed(xml)[0].categoryText).toBeUndefined();
  });

  it('нет <shop> — возвращает пустой список, а не бросает исключение', () => {
    expect(parseYmlFeed('<not-a-feed/>')).toEqual([]);
  });

  it('битый XML — возвращает пустой список, а не бросает исключение', () => {
    expect(parseYmlFeed('<yml_catalog><shop><offers>')).toEqual([]);
  });

  it('нет ни цены, ни валюты — поля возвращаются null, строка не отбрасывается (парсер не судит)', () => {
    const xml = wrap(`<offer id="1"><name>Товар без цены</name></offer>`);
    const rows = parseYmlFeed(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBeNull();
    expect(rows[0].currency).toBeNull();
  });
});

describe('parseCsvFeed', () => {
  it('запятая как разделитель, английские заголовки', () => {
    const csv = 'name,price,currency\nТовар 1,100,UAH\nТовар 2,200,UAH';
    const rows = parseCsvFeed(csv);
    expect(rows).toEqual([
      {
        externalId: undefined,
        title: 'Товар 1',
        price: 100,
        currency: 'UAH',
        description: undefined,
        photoUrl: undefined,
        categoryText: undefined,
      },
      {
        externalId: undefined,
        title: 'Товар 2',
        price: 200,
        currency: 'UAH',
        description: undefined,
        photoUrl: undefined,
        categoryText: undefined,
      },
    ]);
  });

  it('точка-с-запятой автоопределяется, когда её в первой строке больше, чем запятых', () => {
    const csv = 'название;цена;валюта\nТовар;150;UAH';
    const rows = parseCsvFeed(csv);
    expect(rows).toEqual([
      expect.objectContaining({ title: 'Товар', price: 150, currency: 'UAH' }),
    ]);
  });

  it('украинские синонимы заголовков распознаются', () => {
    const csv = 'назва;ціна;категорія\nТовар;99.5;Взуття';
    const rows = parseCsvFeed(csv);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        title: 'Товар',
        price: 99.5,
        categoryText: 'Взуття',
      }),
    );
  });

  it('кавычки: запятая внутри поля не разбивает строку', () => {
    const csv =
      'name,description,price\n"Товар, топ","Хорошее, качественное",100';
    const rows = parseCsvFeed(csv);
    expect(rows[0].title).toBe('Товар, топ');
    expect(rows[0].description).toBe('Хорошее, качественное');
  });

  it('пустые строки пропускаются', () => {
    const csv = 'name,price\nТовар 1,100\n\n\nТовар 2,200';
    const rows = parseCsvFeed(csv);
    expect(rows).toHaveLength(2);
  });

  it('незнакомый заголовок — колонка просто не попадает в разбор, остальные читаются', () => {
    const csv = 'sku,name,price,mystery\nSKU1,Товар,100,???';
    const rows = parseCsvFeed(csv);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        externalId: 'SKU1',
        title: 'Товар',
        price: 100,
      }),
    );
  });

  it('пустой ввод — пустой список', () => {
    expect(parseCsvFeed('')).toEqual([]);
  });

  it('BOM в начале файла не портит первый заголовок', () => {
    const csv = '﻿name,price\nТовар,100';
    const rows = parseCsvFeed(csv);
    expect(rows[0].title).toBe('Товар');
  });
});

describe('parseFeed', () => {
  it('делегирует YML-разборщику для XML-содержимого', () => {
    const xml =
      '<yml_catalog><shop><offers><offer id="1"><name>Т</name><price>1</price></offer></offers></shop></yml_catalog>';
    const result = parseFeed('application/xml', xml);
    expect(result.format).toBe('yml');
    expect(result.rows).toHaveLength(1);
  });

  it('делегирует CSV-разборщику для остального содержимого', () => {
    const result = parseFeed('text/csv', 'name,price\nТ,1');
    expect(result.format).toBe('csv');
    expect(result.rows).toHaveLength(1);
  });
});
