import { IsBoolean } from 'class-validator';

/** PATCH /admin/tutorial-video-assets/:id/review (§4.9, этап 99). */
export class SetTutorialVideoReviewedDto {
  @IsBoolean()
  reviewed!: boolean;
}
