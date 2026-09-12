import * as Joi from 'joi';

const DURATION_PATTERN = /^\d+[smhd]?$/i;

/** Placeholders shipped in .env.example; never accepted. */
const PLACEHOLDER_SECRETS = [
  'CHANGE_ME_TO_A_LONG_RANDOM_SECRET',
  'CHANGE_ME_TO_ANOTHER_LONG_RANDOM_SECRET',
];

/** Defaults used by docker-compose for local development; refused in production. */
export const DEV_ONLY_SECRETS = [
  'dev-only-insecure-access-secret-do-not-use-in-production',
  'dev-only-insecure-refresh-secret-do-not-use-in-production',
];

/**
 * Validates process.env at boot. The application refuses to start when a
 * required variable is missing or malformed so misconfiguration is caught
 * early instead of surfacing as runtime errors.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(4310),
  API_PREFIX: Joi.string().default('api/v1'),
  TRUST_PROXY: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .default(false),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'log', 'debug', 'verbose')
    .optional(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  TEST_DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .optional(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  THROTTLE_TTL: Joi.number().integer().min(1).default(60),

  SWAGGER_ENABLED: Joi.boolean()
    .truthy('1', 'yes', 'on')
    .falsy('0', 'no', 'off')
    .optional(),

  // --- Authentication (Phase 1) ---------------------------------------------
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .invalid(...PLACEHOLDER_SECRETS)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_SECRETS),
    })
    .required(),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .invalid(...PLACEHOLDER_SECRETS)
    .disallow(Joi.ref('JWT_ACCESS_SECRET'))
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid(...DEV_ONLY_SECRETS),
    })
    .required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().pattern(DURATION_PATTERN).default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string().pattern(DURATION_PATTERN).default('30d'),

  AUTH_LOGIN_RATE_LIMIT: Joi.number().integer().min(1).default(10),
  AUTH_LOGIN_RATE_WINDOW: Joi.number().integer().min(1).default(60),
  AUTH_REGISTER_RATE_LIMIT: Joi.number().integer().min(1).default(5),
  AUTH_REGISTER_RATE_WINDOW: Joi.number().integer().min(1).default(60),
  AUTH_REFRESH_RATE_LIMIT: Joi.number().integer().min(1).default(20),
  AUTH_REFRESH_RATE_WINDOW: Joi.number().integer().min(1).default(60),
}).unknown(true);
