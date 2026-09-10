import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class SubmitProductInfoRequestDto {
  @IsString()
  @Length(3, 100, {
    message: 'Product name must be between 3 and 100 characters',
  })
  productName!: string;

  @IsString()
  @Length(1, 250, {
    message: 'Product description must be between 1 and 250 characters',
  })
  productDescription!: string;

  /** ISO 639-1 (optionally with region, "pt-BR") for the voice-over — spec §13. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, {
    message: 'dialogueLanguage must look like "uk" or "pt-BR"',
  })
  dialogueLanguage?: string;
}
