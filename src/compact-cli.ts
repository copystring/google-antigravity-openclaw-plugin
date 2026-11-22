#!/usr/bin/env node
/**
 * Run native agy /compact on an existing conversation.
 * Succeed only after a completed native checkpoint and a matching terminal result.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

type Invocation = { conversation: string; model?: string; effort?: string };

function parseInvocation(argv: string[]): Invocation {
  const values: Record<string, string> = {};
  const accepted = new Set(['--conversation', '--model', '--effort']);
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i]!;
    const equals = entry.indexOf('=');
    const name = equals === -1 ? entry : entry.slice(0, equals);
    if (!accepted.has(name) || Object.hasOwn(values, name)) {
      throw new Error('Unsupported or duplicate Antigravity compaction argument: ' + name);
    }
    const value = equals === -1 ? argv[++i] : entry.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
    values[name] = value;
  }
  const conversation = values['--conversation'];
  if (!conversation || !/^[a-zA-Z0-9_-]{8,128}$/u.test(conversation)) {
    throw new Error('Native compaction requires an explicit conversation identifier');
  }
  const effort = values['--effort'];
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error('Invalid Antigravity effort');
  }
  return {
    conversation,
    ...(values['--model'] ? { model: values['--model'] } : {}),
    ...(effort ? { effort } : {}),
  };
}

function findAgy(): string {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const home = homedir();
  const candidates = [
    process.env.AGY_PATH,
    path.join(home, '.gemini', 'bin', name),
    path.join(home, '.local', 'bin', name),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .map((dir) => path.join(dir, name)),
  ];
  const resolved = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!resolved) throw new Error('Existing agy binary not found; refusing to download one');
  return resolved;
}

async function readLiteralPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 4096) throw new Error('Native compaction prompt exceeded limit');
    chunks.push(buffer);
  }
  const prompt = Buffer.concat(chunks).toString('utf8').trim();
  if (prompt !== '/compact') {
    throw new Error('Only bare /compact is supported; no follow-up instructions may execute');
  }
  return prompt;
}

async function compact(invocation: Invocation, prompt: string): Promise<void> {
  const args = [
    '--conversation=' + invocation.conversation,
    '--print', prompt, '--output-format=stream-json', '--print-timeout=0',
    ...(invocation.model ? ['--model=' + invocation.model] : []),
    ...(invocation.effort ? ['--effort=' + invocation.effort] : []),
  ];
  const { GEMINI_CLI_SYSTEM_SETTINGS_PATH: _bridge, GEMINI_SYSTEM_MD: _system, ...env } =
    process.env;
  const child = spawn(findAgy(), args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const terminate = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The child may already have exited.
    }
  };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);

  let checkpoint = false;
  let succeeded = false;
  let violatedToolPolicy = false;
  const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  stdout.on('line', (line) => {
    try {
      const event = JSON.parse(line) as {
        event?: string;
        step_update?: { conversation_id?: string; step_type?: string; state?: string };
        result?: { conversation_id?: string; status?: string };
      };
      if (event.event === 'step_update') {
        const step = event.step_update;
        if (step?.step_type === 'tool' || step?.step_type === 'tool_call') {
          violatedToolPolicy = true;
          terminate();
        }
        if (step?.step_type === 'checkpoint' && step.state === 'DONE' &&
            step.conversation_id === invocation.conversation) {
          checkpoint = true;
        }
      }
      if (event.event === 'result' && event.result?.conversation_id === invocation.conversation &&
          event.result.status === 'SUCCESS') {
        succeeded = true;
      }
    } catch {
      // Ignore non-JSON diagnostics; only structured events prove completion.
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  let spawnError: Error | undefined;
  child.once('error', (error: Error) => { spawnError = error; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  process.removeListener('SIGINT', terminate);
  process.removeListener('SIGTERM', terminate);
  if (spawnError) throw spawnError;
  if (violatedToolPolicy) throw new Error('Native compaction tried to execute a tool');
  if (exitCode !== 0 || !checkpoint || !succeeded) {
    throw new Error('Native compaction was not confirmed by a completed checkpoint');
  }
  process.stdout.write(JSON.stringify({
    type: 'compaction_complete', status: 'SUCCESS', checkpoint: true,
    conversation_id: invocation.conversation,
  }) + '\n');
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  const prompt = await readLiteralPrompt();
  await compact(invocation, prompt);
}

void main().catch((error: unknown) => {
  process.stderr.write('Antigravity compaction failed: ' +
    (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
