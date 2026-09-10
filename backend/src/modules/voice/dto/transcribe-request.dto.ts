import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * POST /projects/:id/items/:itemId/voice/transcribe — the PUT to Blob is
 * done; transcribe it. `apply` (default true) also writes the result into
 * the item's description so Экран 4 shows it in the editable field right
 * away; `apply: false` just returns the text (e.g. to let the UI ask
 * "replace existing description?").
 */
export class TranscribeRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^projects\/[^/]+\/items\/[^/]+\/voice-\d+\.[a-z0-9]+$/, {
    message:
      'pathname must be the value returned by the voice/upload-url step (projects/<projectId>/items/<itemId>/voice-<ts>.<ext>)',
  })
  pathname!: string;

  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}
