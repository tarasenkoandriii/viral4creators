/**
 * Рендер референс-картинки с готовым текстом настоящим шрифтом — не
 * AI-генерация изображения (та же болезнь неточного текста на новом
 * месте, §20.3 ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md), а честный рендер
 * через `satori` (тот же открытый проект Vercel, что уже используется
 * в экосистеме Next.js для og-изображений — прозрачный JS, без
 * нативных Cairo-биндингов у самого рендера SVG) + `@resvg/resvg-js`
 * для растеризации в PNG (у него есть нативный Rust-биндинг, но
 * поставляется готовыми бинарниками под основные платформы, тот же
 * принцип, что уже даёт `@vercel/og` в проде Vercel — не компилируется
 * из исходников на месте, как потребовал бы `node-canvas`).
 *
 * ⚠️ Не прогнано ни разу в этой среде (нет сети, чтобы поставить
 * пакеты и запустить, ТЗ §20.7) — первый реальный вызов должен быть
 * при локальном/тестовом прогоне, не сразу на проде.
 */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';

export type TextCardRole = 'hook' | 'callout' | 'cta';

export interface TextCardRequest {
  text: string;
  role: TextCardRole;
  /** '9:16' | '16:9' | '1:1' — тот же целевой аспект, что и у самого
   * ролика (`common/reframe.ts` уже умеет его определять) — референс,
   * который выглядит как кадр ролика, а не случайная картинка. */
  aspectRatio: '9:16' | '16:9' | '1:1';
}

const CARD_DIMENSIONS: Record<TextCardRequest['aspectRatio'], { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
};

/** Нейтральный высококонтрастный дефолт — читается на любом видео-фоне,
 * на который эта картинка будет «смотреть» моделью как референс, не
 * только на собственном фоне карточки. */
const DEFAULT_BG = '#111318';
const DEFAULT_FG = '#FFFFFF';
/** CTA — самый конверсионный из трёх (§20.4 п.1) — единственная роль
 * с акцентной плашкой под текстом, чтобы референс визуально отличался
 * от hook/callout даже при беглом взгляде модели. */
const CTA_ACCENT = '#FF5A36';

let fontCache: { regular: Buffer; bold: Buffer } | null = null;

function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (fontCache) return fontCache;
  const dir = join(__dirname, '..', 'assets', 'fonts');
  try {
    fontCache = {
      regular: readFileSync(join(dir, 'NotoSans-Regular.ttf')),
      bold: readFileSync(join(dir, 'NotoSans-Bold.ttf')),
    };
  } catch (error) {
    // Ошибка должна быть понятной сразу — не "Cannot read property of
    // undefined" тремя уровнями глубже внутри satori.
    throw new Error(
      `text-card-render: файлы шрифта не найдены в ${dir} — см. src/assets/fonts/README.md для инструкции по скачиванию. Исходная ошибка: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return fontCache;
}

/**
 * Простая эвристика вместо реального измерения текста — `satori` сам
 * переносит строки по `flexWrap`, но при ОЧЕНЬ длинном тексте
 * (нарушение лимита в 100 символов, §8.5 п.3 ТЗ, теоретически
 * возможное, если `extractLiteralTexts()` его не соблюла) шрифт нужно
 * уменьшить, чтобы текст не вылезал за безопасные поля карточки.
 */
function fontSizeFor(text: string, cardWidth: number): number {
  const base = Math.round(cardWidth / 11);
  if (text.length <= 30) return base;
  if (text.length <= 60) return Math.round(base * 0.75);
  return Math.round(base * 0.55);
}

/**
 * Рендерит одну text-card. Возвращает PNG-буфер — заливка в Blob
 * (`sessions/{id}/text-card-{n}.png`, §20.3 ТЗ) остаётся вызывающему,
 * этот модуль ничего не знает про сессии/Blob.
 */
export async function renderTextCard(req: TextCardRequest): Promise<Buffer> {
  const { regular, bold } = loadFonts();
  const { width, height } = CARD_DIMENSIONS[req.aspectRatio];
  const fontSize = fontSizeFor(req.text, width);
  const isCta = req.role === 'cta';

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: DEFAULT_BG,
          padding: Math.round(width * 0.1),
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                color: DEFAULT_FG,
                fontFamily: 'Noto Sans',
                fontWeight: isCta ? 700 : 400,
                fontSize,
                lineHeight: 1.25,
                textAlign: 'center',
              },
              children: req.text,
            },
          },
          ...(isCta
            ? [
                {
                  type: 'div',
                  props: {
                    style: {
                      display: 'flex',
                      marginTop: Math.round(height * 0.04),
                      width: Math.round(width * 0.2),
                      height: Math.round(height * 0.008),
                      backgroundColor: CTA_ACCENT,
                    },
                    children: [],
                  },
                },
              ]
            : []),
        ],
      },
    },
    {
      width,
      height,
      fonts: [
        { name: 'Noto Sans', data: regular, weight: 400, style: 'normal' },
        { name: 'Noto Sans', data: bold, weight: 700, style: 'normal' },
      ],
    },
  );

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
  });
  const pngData = resvg.render();
  return pngData.asPng();
}
