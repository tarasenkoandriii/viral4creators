import { IsBoolean } from 'class-validator';

/** PATCH /sessions/:id/relevance */
export class UpdateRelevanceRequestDto {
  @IsBoolean()
  useInPrompt!: boolean;
}
