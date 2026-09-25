import { IsOptional, IsString } from 'class-validator';

/**
 * Выбор приёма. `null` — снять выбор и вернуться к референсу (этап
 * 149). Именно `null`, а не отсутствие поля: «ничего не прислали» и
 * «прислали пустоту» это разные намерения, и различать их должен
 * контракт, а не догадка сервиса.
 */
export class PutSceneTemplateRequestDto {
  @IsOptional()
  @IsString()
  templateId!: string | null;
}
