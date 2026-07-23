import { Module } from '@nestjs/common';
import { LivecamController } from './livecam.controller';
import { LivecamService } from './livecam.service';
import { WorkerControlService } from './worker-control.service';
import { CreditsModule } from '../credits/credits.module';
import { VoicesModule } from '../voices/voices.module';
import { FacesModule } from '../faces/faces.module';

@Module({
  imports: [CreditsModule, VoicesModule, FacesModule],
  controllers: [LivecamController],
  providers: [LivecamService, WorkerControlService],
})
export class LivecamModule {}
