import { JobKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class CreateGenerationJobDto {
  @IsEnum(JobKind)
  kind: JobKind;

  @IsString()
  @MaxLength(4000)
  @IsOptional()
  prompt?: string;

  @IsString()
  @IsOptional()
  sourceAssetUrl?: string;

  @IsString()
  @IsOptional()
  maskAssetUrl?: string;

  @IsString()
  @IsOptional()
  voiceId?: string;

  @IsInt()
  @Min(1)
  @Max(4)
  @IsOptional()
  count?: number;

  @IsInt()
  @Min(1)
  @Max(30)
  @IsOptional()
  durationSeconds?: number;

  @IsObject()
  @IsOptional()
  options?: Record<string, unknown>;
}
