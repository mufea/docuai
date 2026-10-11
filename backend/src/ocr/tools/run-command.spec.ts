import { CommandNotFoundError, runCommand } from './run-command';

describe('runCommand', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await runCommand(
      'sh',
      ['-c', 'echo out; echo err >&2; exit 3'],
      {
        timeoutMs: 5000,
      },
    );
    expect(result.stdout.toString()).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('kills a runaway process group on timeout', async () => {
    const started = Date.now();
    const result = await runCommand('sh', ['-c', 'sleep 30; echo late'], {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout.toString()).toBe('');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('bounds captured output', async () => {
    const result = await runCommand('sh', ['-c', 'head -c 100000 /dev/zero'], {
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it('reports a missing binary distinctly', async () => {
    await expect(
      runCommand('definitely-not-installed-binary-xyz', [], {
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(CommandNotFoundError);
  });
});
