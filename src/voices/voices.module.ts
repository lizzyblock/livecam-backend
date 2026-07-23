import { Module } from '@nestjs/common';
import { VoicesController } from './voices.controller';
import { VoicesService } from './voices.service';
import { CreditsModule } from '../credits/credits.module';

@Module({
  imports: [CreditsModule],
  controllers: [VoicesController],
  providers: [VoicesService],
  exports: [VoicesService],
})
export class VoicesModule {}
