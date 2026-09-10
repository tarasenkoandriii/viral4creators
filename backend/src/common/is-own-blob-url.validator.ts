/**
 * Валидатор class-validator для «этот URL ведёт в наше хранилище»
 * (этап 38, А-2.11).
 *
 * Отдельный файл, а не декоратор внутри DTO: тех мест, где клиент может
 * назвать адрес картинки, три (снимок манифеста, кастинг персонажей,
 * манифест бренда), и правило у них общее. Разъехавшиеся копии одного
 * правила — это ровно тот способ, каким такая дыра появляется снова.
 */

import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FOREIGN_BLOB_URL_MESSAGE, isOwnBlobUrl } from './blob-url';

@ValidatorConstraint({ name: 'isOwnBlobUrl', async: false })
export class IsOwnBlobUrl implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // `null` и отсутствие значения пропускаем: их отсекают @IsOptional /
    // @ValidateIf рядом, и дублировать эту логику здесь значит
    // рассогласовать её при следующей правке.
    if (value === null || value === undefined) return true;
    return typeof value === 'string' && isOwnBlobUrl(value);
  }

  defaultMessage(): string {
    return FOREIGN_BLOB_URL_MESSAGE;
  }
}
