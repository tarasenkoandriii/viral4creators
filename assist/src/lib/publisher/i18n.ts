/**
 * AI Publisher (P-G1) — словари оболочки и экранов P-G1 по языку
 * интерфейса. Экраны P-G2 берут свои словари сами (`publisher-ops-*`).
 */

import type { Locale } from '../../kit';
import { pubEn } from '../../i18n/publisher-en';
import { pubRu, type PublisherDict } from '../../i18n/publisher-ru';
import { pubUk } from '../../i18n/publisher-uk';
import { pubContentEn } from '../../i18n/publisher-content-en';
import {
  pubContentRu,
  type PublisherContentDict,
} from '../../i18n/publisher-content-ru';
import { pubContentUk } from '../../i18n/publisher-content-uk';

const DICTS: Record<Locale, PublisherDict> = {
  uk: pubUk,
  ru: pubRu,
  en: pubEn,
};
const CONTENT: Record<Locale, PublisherContentDict> = {
  uk: pubContentUk,
  ru: pubContentRu,
  en: pubContentEn,
};

export function getPublisherDict(locale: Locale): PublisherDict {
  return DICTS[locale];
}

export function getPublisherContentDict(locale: Locale): PublisherContentDict {
  return CONTENT[locale];
}

export type { PublisherContentDict, PublisherDict };
