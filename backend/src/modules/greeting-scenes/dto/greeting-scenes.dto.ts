import { IsInt, Max, Min } from 'class-validator';
import {
  MAX_GREETING_SCENES,
  MIN_GREETING_SCENES,
} from '../../../common/greeting-scenes';

export class GreetingScenesRequestDto {
  @IsInt()
  @Min(MIN_GREETING_SCENES)
  @Max(MAX_GREETING_SCENES)
  sceneCount!: number;
}
