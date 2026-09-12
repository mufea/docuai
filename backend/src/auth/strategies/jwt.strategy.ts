import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../../config/configuration';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../interfaces/jwt-payload.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService<AppConfig, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('auth', { infer: true }).accessSecret,
      algorithms: ['HS256'],
    });
  }

  /**
   * Called only after signature and expiry have been verified. Returning a
   * falsy value makes passport reject the request.
   */
  validate(payload: JwtPayload): AuthenticatedUser | null {
    if (typeof payload.sub !== 'string' || !UUID_PATTERN.test(payload.sub)) {
      return null;
    }
    return { userId: payload.sub };
  }
}
