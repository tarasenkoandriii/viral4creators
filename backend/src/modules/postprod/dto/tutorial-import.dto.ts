import { IsString, MaxLength } from 'class-validator';
export class TutorialImportDto {
  @IsString()
  @MaxLength(300)
  pathname!: string;
  @IsString()
  @MaxLength(2000)
  expectedUrl!: string;
}
