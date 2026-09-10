import { IsOptional, IsString, Length } from 'class-validator';

/**
 * POST /sessions/:id/audit — empty body = automatic Gemini video audit;
 * `issue` = the user says what is wrong themselves (spec §11.3) and only
 * the prompt fix is produced (no video call).
 */
export class RunAuditRequestDto {
  @IsOptional()
  @IsString()
  @Length(3, 1000, { message: 'issue must be between 3 and 1000 characters' })
  issue?: string;
}

/**
 * POST /sessions/:id/audit/apply — put a fix into the prompt (spec §11.2:
 * lands in PromptEditor as an editable draft). `text` lets the client send
 * an already-edited version; omitted = the audit's suggestedText verbatim.
 */
export class ApplyFixRequestDto {
  @IsString()
  @Length(1, 64)
  auditId!: string;

  @IsOptional()
  @IsString()
  @Length(10, 6000, { message: 'text must be between 10 and 6000 characters' })
  text?: string;
}
