import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id parameters. These follow the OWASP Password Storage Cheat Sheet
 * recommendation for a backend API (m=64 MiB, t=3, p=4) and produce a PHC
 * string that embeds the parameters, so they can be raised later without
 * invalidating existing hashes (`needsRehash` detects outdated ones).
 */
export const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

@Injectable()
export class PasswordService {
  /**
   * Hashes a password. The input is treated as an opaque secret: it is never
   * trimmed, normalised or logged.
   */
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Constant-time verification. Returns false (never throws) for malformed
   * hashes so callers can keep a single generic failure path.
   */
  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }
}
