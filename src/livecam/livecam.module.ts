import { Module } from '@nestjs/common';
import { LivecamController } from './livecam.controller';
import { LivecamService } from './livecam.service';
import { CreditsModule } from '../credits/credits.module';

@Module({
  imports: [CreditsModule],
  controllers: [LivecamController],
  providers: [LivecamService],
})
export class LivecamModule {}
