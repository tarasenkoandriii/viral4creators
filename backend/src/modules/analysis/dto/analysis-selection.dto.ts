import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

/** PUT /sessions/:id/analysis/selection */
export class PutAnalysisSelectionRequestDto {
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  @Matches(/^s\d{1,2}$/, { each: true, message: 'scene ids look like "s3"' })
  droppedScenes!: string[];

  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^e\d{1,2}$/, { each: true, message: 'extras ids look like "e1"' })
  droppedExtras!: string[];
}
