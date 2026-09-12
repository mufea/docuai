import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Module,
  Post,
} from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';

export class EchoDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@Controller('probe')
export class ProbeController {
  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  @Get('error')
  unexpected(): never {
    throw new Error('boom');
  }

  @Get('not-found')
  missing(): never {
    throw new HttpException('Resource missing', HttpStatus.NOT_FOUND);
  }
}

@Module({
  controllers: [ProbeController],
})
export class ProbeModule {}
