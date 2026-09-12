import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an Argon2id PHC string that does not contain the password', async () => {
    const hash = await service.hash('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('uses a random salt so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([
      service.hash('same'),
      service.hash('same'),
    ]);

    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects others', async () => {
    const hash = await service.hash('  spaced secret  ');

    await expect(service.verify('  spaced secret  ', hash)).resolves.toBe(true);
    await expect(service.verify('spaced secret', hash)).resolves.toBe(false);
    await expect(service.verify('', hash)).resolves.toBe(false);
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    await expect(service.verify('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(service.verify('anything', '')).resolves.toBe(false);
  });

  it('reports when a hash was produced with weaker parameters', async () => {
    const weak = '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$abc';

    expect(service.needsRehash(weak)).toBe(true);
    expect(service.needsRehash(await service.hash('x'))).toBe(false);
  });
});
