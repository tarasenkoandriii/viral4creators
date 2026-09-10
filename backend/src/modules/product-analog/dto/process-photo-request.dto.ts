import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SUPPORTED_LOCALES } from '../../../common/locale';

/**
 * POST /projects/:id/items/:itemId/photo/process — tells the backend the
 * PUT to Blob has finished. `pathname` is what upload-url returned; the
 * service re-checks it belongs to this item.
 */
export class ProcessPhotoRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^projects\/[^/]+\/items\/[^/]+\/photo\.(png|jpg|jpeg|webp)$/, {
    message:
      'pathname must be the value returned by the upload-url step (projects/<projectId>/items/<itemId>/photo.<ext>)',
  })
  pathname!: string;

  /** UI-локаль продавца (этап 59, ТЗ §35.5) — см. common/locale.ts. */
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  locale?: string;
}
