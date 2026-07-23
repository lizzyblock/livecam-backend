import { Module } from '@nestjs/common';
import { FacesController } from './faces.controller';
import { FacesService } from './faces.service';
import { CreditsModule } from '../credits/credits.module';

@Module({
  imports: [CreditsModule],
  controllers: [FacesController],
  providers: [FacesService],
  exports: [FacesService],
})
export class FacesModule {}
