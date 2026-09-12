import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Min,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: string = 'development';

  @IsString()
  @IsNotEmpty()
  APP_NAME: string = 'DocuAI';

  @IsInt()
  @Min(1)
  APP_PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  API_PREFIX: string = 'api/v1';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsUrl({ require_tld: false, protocols: ['redis', 'rediss'] })
  REDIS_URL!: string;

  @IsString()
  CORS_ORIGINS: string = 'http://localhost:3000';

  @IsInt()
  @Min(1)
  RATE_LIMIT_TTL: number = 60;

  @IsInt()
  @Min(1)
  RATE_LIMIT_LIMIT: number = 100;
}

export function validateEnvironment(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const validated = plainToInstance(EnvironmentVariables, values, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const fields = errors.map((error) => error.property).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return validated as unknown as Record<string, unknown>;
}
