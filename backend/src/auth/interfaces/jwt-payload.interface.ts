/**
 * Claims carried by an access token. Kept intentionally minimal: the subject
 * (user id) plus the standard timestamps added by the signer. No profile or
 * secret data ever goes into a token.
 */
export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

/**
 * What `JwtStrategy.validate` attaches to `request.user`. Resolved from the
 * token alone (no database round-trip); handlers that need the full user
 * record load it via `UsersService`.
 */
export interface AuthenticatedUser {
  userId: string;
}
