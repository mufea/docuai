# Phase 0 API

Base URL: `http://localhost:3000/api/v1`

## GET /health

Checks PostgreSQL and Redis.

Success (`200`):

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "DocuAI API",
    "database": "up",
    "redis": "up"
  },
  "message": null,
  "requestId": "uuid-or-client-value"
}
```

Dependency failure (`503`) uses code `DEPENDENCY_UNAVAILABLE` in the standard error envelope. Internal exception details and stack traces are never returned.

Every response includes `X-Request-ID`. A non-empty client-supplied value is preserved; otherwise the API generates a UUID v4.
