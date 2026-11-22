import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SESSION_ID = '91f5da53-b929-467b-a052-e2224bd02679';
const SCRIPT = fileURLToPath(new URL('../src/compact-cli.ts', import.meta.url));

async function runCompaction(mode: string, prompt: string, conversation = SESSION_ID) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-compaction-cli-test-'));
  const executable = path.join(dir, 'agy');
  const fakeAgy = [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    "const id = args.find((arg) => arg.startsWith('--conversation='))?.split('=')[1];",
    "if (!id || !args.includes('/compact') || args.includes('--disable-slash-commands')) process.exit(2);",
    "if (process.env.FAKE_AGY_MODE !== 'missing-checkpoint') console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: id, step_type: 'checkpoint', state: 'DONE' } }));",
    "if (process.env.FAKE_AGY_MODE === 'tool') console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: id, step_type: 'tool', state: 'ACTIVE' } }));",
    "console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '' } }));",
  ].join('\n');
  await writeFile(executable, fakeAgy);
  await chmod(executable, 0o755);

  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types',
        SCRIPT,
        '--conversation=' + conversation,
      ], {
        env: { ...process.env, AGY_PATH: executable, FAKE_AGY_MODE: mode },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(prompt);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('native compaction executable', () => {
  it('recognizes a completed native checkpoint on an existing conversation', async () => {
    const result = await runCompaction('success', '/compact\n');
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output).toEqual({
      type: 'compaction_complete',
      status: 'SUCCESS',
      checkpoint: true,
      conversation_id: SESSION_ID,
    });
  });

  it('does not claim success when native checkpoint proof is absent', async () => {
    const result = await runCompaction('missing-checkpoint', '/compact\n');
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('compaction_complete');
    expect(result.stderr).toMatch(/not confirmed/);
  });

  it('rejects non-compaction instructions before starting agy', async () => {
    const result = await runCompaction('success', '/compact Continue editing\n');
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/bare \/compact/);
  });

  it('requires an explicit valid conversation', async () => {
    const result = await runCompaction('success', '/compact\n', 'invalid/session');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/conversation identifier/);
  });
});
