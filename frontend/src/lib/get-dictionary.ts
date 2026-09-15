import { defaultLocale, type Locale } from './i18n';
import ru from '../dictionaries/ru.json';
import uk from '../dictionaries/uk.json';
import en from '../dictionaries/en.json';
import de from '../dictionaries/de.json';
import es from '../dictionaries/es.json';

/**
 * Числовые формы (Intl.PluralRules, этап 56): у ru/uk четыре формы
 * (one/few/many/other), у en/de/es только две (one/other) — так устроены
 * сами языки, это не расхождение данных. Буквальный тип `typeof ru`
 * требовал бы от английского словаря те же четыре ключа, которых в
 * английском попросту не бывает, поэтому такие поля объявлены здесь как
 * `PluralForms`, а не как литерал из ru.json.
 */
type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;

export type Dictionary = Omit<
  typeof ru,
  'manifestsListScreen' | 'manifestScreen' | 'deleteConfirm'
> & {
  manifestsListScreen: Omit<typeof ru.manifestsListScreen, 'usedInProjects'> & {
    usedInProjects: PluralForms;
  };
  manifestScreen: Omit<
    typeof ru.manifestScreen,
    'deleteWarnWithProjects' | 'usedInProjectsHint' | 'assets'
  > & {
    deleteWarnWithProjects: PluralForms;
    usedInProjectsHint: PluralForms;
    assets: Omit<typeof ru.manifestScreen.assets, 'scene'> & {
      scene: Omit<typeof ru.manifestScreen.assets.scene, 'countHint'> & {
        countHint: PluralForms;
      };
    };
  };
  /**
   * «Умный» алерт удаления (этап 89) — счётчики под-сущностей
   * (items/catalogBatchRuns/…) идут через `Intl.PluralRules`, как и
   * остальные числовые формы словаря выше.
   */
  deleteConfirm: Omit<
    typeof ru.deleteConfirm,
    | 'items'
    | 'catalogBatchRuns'
    | 'abTestRuns'
    | 'feedImportRuns'
    | 'analogs'
    | 'catalogBatchItems'
  > & {
    items: PluralForms;
    catalogBatchRuns: PluralForms;
    abTestRuns: PluralForms;
    feedImportRuns: PluralForms;
    analogs: PluralForms;
    catalogBatchItems: PluralForms;
  };
};

const dictionaries: Record<Locale, Dictionary> = {
  ru: ru as Dictionary,
  uk: uk as Dictionary,
  en: en as Dictionary,
  de: de as Dictionary,
  es: es as Dictionary,
};

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries[defaultLocale];
}
