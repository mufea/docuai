# API Spec

Base URL (local Docker): `http://localhost:3000`

All routes use the prefix `/api/v1`.

## Envelope

### Success

```json
{
  "success": true,
  "data": {},
  "message": null,
  "requestId": "uuid"
}
```

### Error

```json
{
  "success": false,
  "data": null,
  "code": "ERROR_CODE",
  "message": "Human readable message",
  "requestId": "uuid"
}
```

Stack traces are never included.

## Request ID

Header: `X-Request-ID`

1. If the client sends a valid id (`A–Z`, `a–z`, `0–9`, `.`, `_`, `:`, `-`, max 128 chars), the API reuses it.
2. Otherwise it generates a UUID.
3. The same value is returned as `X-Request-ID`, included in the JSON envelope, and attached to logs.

Example: `X-Request-ID: test-123` remains `test-123`.

## Endpoints

### `GET /api/v1/health`

Checks the application process, PostgreSQL, and Redis.

**200**

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
  "requestId": "..."
}
```

**503** when PostgreSQL or Redis is unavailable. `data` still contains the per-dependency status so callers can see which check failed. Example:

```json
{
  "success": false,
  "data": {
    "status": "error",
    "service": "DocuAI API",
    "database": "down",
    "redis": "up"
  },
  "code": "DEPENDENCY_UNAVAILABLE",
  "message": "One or more dependencies are unavailable",
  "requestId": "..."
}
```

## Error codes

| Code | Typical status |
| --- | --- |
| `VALIDATION_ERROR` | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `RATE_LIMIT_EXCEEDED` | 429 |
| `DEPENDENCY_UNAVAILABLE` | 503 |
| `INTERNAL_ERROR` | 500 |

Unknown JSON properties and invalid bodies are rejected by the global validation pipe.

## Security

- Helmet
- CORS (explicit origins; no production wildcard)
- Rate limit from `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT` (default 100 requests / 60 seconds)
- 1 MB request body limit
- Secrets are not returned in responses or logs

Phase 0 has no authenticated routes.
