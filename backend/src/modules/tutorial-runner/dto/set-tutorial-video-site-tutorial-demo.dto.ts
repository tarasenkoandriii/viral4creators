import { IsBoolean } from 'class-validator';

/**
 * PATCH /admin/tutorial-video-assets/:id/site-tutorial-demo — галочка «В
 * демо обучающего лендинга» (`TutorialVideoAdminService.setSiteTutorialDemo`).
 */
export class SetTutorialVideoSiteTutorialDemoDto {
  @IsBoolean()
  marked!: boolean;
}
