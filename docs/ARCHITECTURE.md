# Phase 0 Architecture

Clients call the NestJS backend over HTTP. Request-ID and logging middleware run first, followed by Helmet/CORS/body limits, throttling, validation, controllers, and the response envelope interceptor. A global filter converts every unhandled or HTTP exception to a safe error envelope.

`HealthModule` queries PostgreSQL through the global `PrismaModule` and pings Redis through the global `RedisModule`. Both clients connect during application initialization and disconnect through Nest lifecycle hooks. Shutdown hooks allow SIGTERM/SIGINT container stops to close resources cleanly.

Docker Compose places the backend, PostgreSQL, and Redis on `docuai-network`. Named volumes preserve database and Redis data across container recreation. Backend startup waits for healthy dependencies and applies committed migrations before listening.
