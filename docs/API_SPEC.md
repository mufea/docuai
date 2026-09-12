# DocuAI API Specification

Base URL: `http://<host>:4310/api/v1`

Interactive OpenAPI documentation: `GET /api/v1/docs` (enabled outside
production, or when `SWAGGER_ENABLED=true`). Use the **Authorize** button with
an access token to call protected endpoints.

## Conventions

### Response envelope

Success:

```json
{
  "success": true,
  "data": {},
  "message": null,
  "requestId": "0b1e9c4e-2c5a-4a0b-9c8b-6c2e6f1c9d21"
}
```

Error:

```json
{
  "success": false,
  "data": null,
  "code": "ERROR_CODE",
  "message": "Human readable description",
  "requestId": "0b1e9c4e-2c5a-4a0b-9c8b-6c2e6f1c9d21"
}
```

Clients must branch on `code`, never on `message`.

### Request ID

Every response carries `X-Request-Id`. Clients may send their own
`X-Request-Id` (`[A-Za-z0-9._:-]{1,128}`) to correlate logs; otherwise a UUID
is generated.

### Authentication

Protected endpoints require an access token:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived JWTs (default 15 minutes, `expiresIn` in the
response tells the client the lifetime in seconds). When one expires the client
calls `POST /auth/refresh` with its refresh token and receives a **new** access
token **and a new refresh token**; the old refresh token is invalid from that
moment on. Clients must serialise refresh calls: two concurrent refreshes with
the same token are treated as token reuse and terminate every session of the
user.

| Route | Auth |
| ----- | ---- |
| `GET /health` | public |
| `POST /auth/register` | public |
| `POST /auth/login` | public |
| `POST /auth/refresh` | public |
| `POST /auth/logout` | bearer |
| `GET /auth/me` | bearer |
| `GET /users/me` | bearer |
| `PATCH /users/me` | bearer |

### Validation

Request bodies are validated strictly. Unknown fields are rejected:

```json
{ "success": false, "data": null, "code": "VALIDATION_ERROR", "message": "property foo should not exist", "requestId": "..." }
```

Emails are trimmed and lower-cased before use. Passwords are never modified
(no trimming) and must be 8–128 characters.

### Rate limiting

All endpoints (except `/health`) share a per-IP limit of `THROTTLE_LIMIT`
requests per `THROTTLE_TTL` seconds. Authentication endpoints additionally
have their own, stricter per-IP buckets:

| Endpoint | Default | Variables |
| -------- | ------- | --------- |
| `POST /auth/login` | 10 / 60 s | `AUTH_LOGIN_RATE_LIMIT`, `AUTH_LOGIN_RATE_WINDOW` |
| `POST /auth/register` | 5 / 60 s | `AUTH_REGISTER_RATE_LIMIT`, `AUTH_REGISTER_RATE_WINDOW` |
| `POST /auth/refresh` | 20 / 60 s | `AUTH_REFRESH_RATE_LIMIT`, `AUTH_REFRESH_RATE_WINDOW` |

Exceeding a limit returns `429 RATE_LIMITED` with a `Retry-After` header.

### Error codes

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `VALIDATION_ERROR` | 400 | Request body/query failed validation |
| `BAD_REQUEST` | 400 | Malformed request (e.g. invalid JSON) |
| `UNAUTHORIZED` | 401 | Generic unauthenticated (non-auth modules) |
| `AUTH_UNAUTHORIZED` | 401 | No bearer token, or token subject no longer exists |
| `AUTH_INVALID_TOKEN` | 401 | Access token malformed, expired or badly signed |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email or password (deliberately indistinguishable) |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | Refresh token unknown or malformed |
| `AUTH_REFRESH_TOKEN_EXPIRED` | 401 | Refresh token past `expiresAt` |
| `AUTH_REFRESH_TOKEN_REUSED` | 401 | Refresh token already revoked/rotated; all sessions were revoked |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Credentials valid but account suspended |
| `AUTH_ACCOUNT_DELETED` | 403 | Credentials valid but account deleted |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Route or resource not found |
| `USER_NOT_FOUND` | 404 | Profile update for a user that no longer exists |
| `AUTH_EMAIL_ALREADY_EXISTS` | 409 | Registration with an email already in use |
| `CONFLICT` | 409 | Other state conflict |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error (details are logged, never returned) |
| `SERVICE_UNAVAILABLE` | 503 | A dependency (database, Redis) is down |

## Schemas

### `User` (public representation)

Returned everywhere a user appears. `passwordHash` is never included.

```json
{
  "id": "70ce2001-72d7-4b28-8500-a0054b417437",
  "email": "user@example.com",
  "name": "John Doe",
  "avatarUrl": null,
  "status": "ACTIVE",
  "emailVerified": false,
  "createdAt": "2026-09-12T12:45:58.817Z",
  "updatedAt": "2026-09-12T12:45:58.817Z"
}
```

`status` ∈ `ACTIVE | SUSPENDED | DELETED`.

### `TokenPair`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "OMFiqaV6n2nBpCduoQyofW-7tYqv78Y1Gk6v3-jWEhY0T7v89qEePBVvzFVD5O-K",
  "expiresIn": 900,
  "tokenType": "Bearer"
}
```

### `AuthResponse`

`TokenPair` plus `"user": User`.

## Endpoints

### Health

#### `GET /health`

Public. Excluded from rate limiting.

Response `200`:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "database": "up",
    "redis": "up",
    "uptime": 128,
    "timestamp": "2026-09-12T12:00:00.000Z"
  },
  "message": null,
  "requestId": "..."
}
```

Response `503` when any dependency is down:

```json
{ "success": false, "data": null, "code": "SERVICE_UNAVAILABLE", "message": "Dependencies unavailable: redis", "requestId": "..." }
```

### Auth

#### `POST /auth/register`

Public. Rate limit: register bucket.

Request:

```json
{
  "email": "user@example.com",
  "password": "strong-password",
  "name": "John Doe",
  "deviceName": "Pixel 8"
}
```

| Field | Rules |
| ----- | ----- |
| `email` | required, valid email, ≤ 320 chars, normalised |
| `password` | required, string, 8–128 chars, stored only as Argon2id hash |
| `name` | optional, 1–100 chars, trimmed |
| `deviceName` | optional, 1–100 chars, label for this session |

Response `201`: `AuthResponse`. The account is created, a session (refresh
token) is opened and an access token is issued in one step.

Errors: `400 VALIDATION_ERROR`, `409 AUTH_EMAIL_ALREADY_EXISTS`,
`429 RATE_LIMITED`.

#### `POST /auth/login`

Public. Rate limit: login bucket.

Request:

```json
{ "email": "user@example.com", "password": "strong-password", "deviceName": "Pixel 8" }
```

Response `200`: `AuthResponse`. Each login creates an additional session; other
devices stay signed in.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_INVALID_CREDENTIALS` (unknown email
and wrong password are indistinguishable), `403 AUTH_ACCOUNT_SUSPENDED`,
`403 AUTH_ACCOUNT_DELETED` (only after the password matched),
`429 RATE_LIMITED`.

#### `POST /auth/refresh`

Public. Rate limit: refresh bucket.

Request:

```json
{ "refreshToken": "OMFiqaV6n2nBpCduoQyofW-7tYqv78Y1Gk6v3-jWEhY0T7v89qEePBVvzFVD5O-K" }
```

Response `200`: `TokenPair` with a **new** refresh token. The presented token
is revoked atomically; replace it on the client immediately.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_REFRESH_TOKEN_INVALID`,
`401 AUTH_REFRESH_TOKEN_EXPIRED`, `401 AUTH_REFRESH_TOKEN_REUSED` (the token
was already used or revoked — **all** of the user's sessions have now been
revoked and the user must log in again), `403 AUTH_ACCOUNT_SUSPENDED`,
`403 AUTH_ACCOUNT_DELETED`, `429 RATE_LIMITED`.

#### `POST /auth/logout`

Bearer required.

Request:

```json
{ "refreshToken": "..." }
```

Response `200`:

```json
{ "success": true, "data": null, "message": "Logged out", "requestId": "..." }
```

Revokes only the presented session. Idempotent: an unknown, already revoked
or foreign refresh token yields the same `200` so the endpoint cannot be used
to probe token state. The access token remains technically valid until it
expires (≤ 15 minutes); clients must discard it.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`.

#### `GET /auth/me`

Bearer required. Response `200`: `User`.

Errors: `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`.

### Users

#### `GET /users/me`

Bearer required. Same response and errors as `GET /auth/me`.

#### `PATCH /users/me`

Bearer required.

Request (all fields optional; `null` clears a field):

```json
{ "name": "Updated User", "avatarUrl": "https://cdn.example.com/avatars/me.png" }
```

| Field | Rules |
| ----- | ----- |
| `name` | string 1–100 chars (trimmed) or `null` |
| `avatarUrl` | absolute `http(s)` URL ≤ 2048 chars or `null` |

Any other property (`email`, `status`, `emailVerified`, `passwordHash`, `id`,
`createdAt`, `updatedAt`, …) is rejected with `400 VALIDATION_ERROR`
(`property <name> should not exist`). Email changes will arrive with email
verification in a later phase.

Response `200`: updated `User`.

Errors: `400 VALIDATION_ERROR`, `401 AUTH_UNAUTHORIZED | AUTH_INVALID_TOKEN`,
`403 AUTH_ACCOUNT_SUSPENDED | AUTH_ACCOUNT_DELETED`, `404 USER_NOT_FOUND`.

## Example client flow

```
register/login ──► store accessToken (memory) + refreshToken (secure storage)
       │
       ▼
call API with Authorization: Bearer <accessToken>
       │ 401 AUTH_INVALID_TOKEN (expired)
       ▼
POST /auth/refresh { refreshToken } ──► replace BOTH tokens
       │ 401 AUTH_REFRESH_TOKEN_* 
       ▼
clear tokens, show login screen
```
