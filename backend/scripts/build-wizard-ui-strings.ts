/**
 * Подписи интерфейса для записей опыта советника — «Тонкая красная
 * линия» §6.7, этап 9.
 *
 * ## Зачем генератор, а не чтение словаря в рантайме
 *
 * Словари мини-аппа лежат во `frontend/src/dictionaries`, которых у
 * собранного бэкенда на Vercel нет вовсе. Тот же приём, что у корпуса
 * консультанта: снимок кладётся в исходник, а тест паритета
 * (`wizard-ui-strings.spec.ts`) следит, чтобы снимок не разошёлся с
 * источником.
 *
 * ## Зачем список, а не весь словарь
 *
 * Словарь мини-аппа — 120 КБ на локаль, и 600 КБ строк в бэкенде ради
 * полутора десятков подписей кнопок были бы платой ни за что. Список
 * заодно и есть то, что видит оператор в админке: подсказка «какие
 * ключи можно вставлять», а не приглашение угадывать.
 *
 * Правило, ради которого всё это существует (§6.7): записи опыта НЕ
 * называют элементы интерфейса словами. В тексте стоит ключ, подпись
 * подставляется при ОТДАЧЕ — иначе переименование кнопки молча
 * переживёт правку словаря, а замороженный перевод понесёт старое
 * название по всем локалям.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
type Locale = (typeof LOCALES)[number];

const DICT_DIR = path.join(
  __dirname,
  '..',
  '..',
  'frontend',
  'src',
  'dictionaries',
);
const OUT_FILE = path.join(
  __dirname,
  '..',
  'src',
  'modules',
  'wizard-guide',
  'ui-strings.generated.ts',
);

/**
 * Что разрешено называть в записях опыта.
 *
 * Только то, на что человек реально жмёт по ходу сценария: заголовки
 * экранов и подписи полей сюда не нужны — про них запись скажет своими
 * словами, а кнопку надо назвать точно, иначе совет не выполнить.
 */
export const WIZARD_UI_KEYS: readonly string[] = [
  'clientSiteWizard.stepUrl',
  'clientSiteWizard.stepRecord',
  'clientSiteWizard.stepReview',
  'clientSiteWizard.exploreButton',
  'clientSiteWizard.fillOnlyButton',
  'clientSiteWizard.loginButton',
  'clientSiteWizard.liveButton',
  'clientSiteWizard.liveDoneButton',
  'clientSiteWizard.liveRestartButton',
  'clientSiteWizard.undoButton',
  'clientSiteWizard.doneButton',
  'clientSiteWizard.submitButton',
  'clientSiteWizard.resumeButton',
  'clientSiteWizard.continueButton',
  'clientSiteWizard.discardButton',
  'wizardGuide.hintUseless',

  // Поздравление (волна D, этап 12).
  'greetingVideoWizard.startSessionButton',
  'greetingVideoWizard.generateScriptButton',
  'greetingVideoWizard.generateVideoButton',
  'greetingVideoWizard.referencesHeading',
  'greetingVideoWizard.scriptHeading',
  'greetingVideoWizard.videoHeading',
  'greetingVideoWizard.submitButton',

  // Товарка (волна D, этап 13). Подписи шагов у неё массивом, и
  // сослаться на элемент массива ключом нельзя — поэтому здесь только
  // то, на что человек жмёт.
  'generationWizard.postprodCtaButton',
];

function readDict(locale: Locale): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(DICT_DIR, `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function get(dict: unknown, dotted: string): string | undefined {
  let node: unknown = dict;
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function buildUiStrings(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const locale of LOCALES) {
    const dict = readDict(locale);
    const strings: Record<string, string> = {};
    for (const key of WIZARD_UI_KEYS) {
      const value = get(dict, key);
      // Ключ без значения ПРОПУСКАЕТСЯ, а не роняет сборку: список выше
      // и словари правятся разными руками, и падать здесь значило бы
      // ронять деплой из-за переименованной кнопки. Пропавшую подпись
      // ловит `renderUiKeys` — на отдаче, называя ключ неизвестным.
      if (value !== undefined) strings[key] = value;
    }
    out[locale] = strings;
  }
  return out;
}

async function main(): Promise<void> {
  const strings = buildUiStrings();
  const header = `/**
 * ГЕНЕРИРУЕТСЯ автоматически — backend/scripts/build-wizard-ui-strings.ts.
 * Не редактировать руками: правки уйдут при следующей сборке. Источник —
 * frontend/src/dictionaries/*.json, список ключей — в самом скрипте.
 */

export const WIZARD_UI_STRINGS: Record<string, Record<string, string>> = ${JSON.stringify(strings, null, 2)};
`;
  const prettier = await import('prettier');
  const formatted = await prettier.format(header, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    printWidth: 80,
    tabWidth: 2,
    endOfLine: 'lf',
  });
  fs.writeFileSync(OUT_FILE, formatted, 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `wizard ui strings: ${WIZARD_UI_KEYS.length} ключ(ей) × ${LOCALES.length} локалей`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
