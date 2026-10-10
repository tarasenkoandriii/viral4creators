import { IsString, Length } from 'class-validator';
export class ShortenGreetingScriptDto {
  @IsString()
  @Length(1, 2000)
  text!: string;
}
