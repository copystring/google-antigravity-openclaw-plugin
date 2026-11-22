import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type AgyCatalogModel = {
  id: string;
  name: string;
};

export type AgyCatalogSnapshot = {
  models: readonly AgyCatalogModel[];
  fetchedAt: number;
  expiresAt: number;
  source: 'live' | 'cache';
};

type CommandResult = { exitCode: number; stdout: string };

export type CatalogCommandRunner = (options: {
  command: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<CommandResult>;

export type DiscoverAgyModelsOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  runner?: CatalogCommandRunner;
  now?: () => number;
  ttlMs?: number;
};

export const CATALOG_TTL_MS = 5 * 60_000;
export const CATALOG_TIMEOUT_MS = 30_000;
const ERROR_RETRY_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

let lastGood: Omit<AgyCatalogSnapshot, 'source'> | null = null;
let nextAllowedAttempt = 0;
let inFlight: Promise<AgyCatalogSnapshot | null> | null = null;

export function clearAgyCatalogCache(): void {
  lastGood = null;
  nextAllowedAttempt = 0;
  inFlight = null;
}

/**
 * Read machine-readable model discovery only. A zero exit code with invalid
 * data, an error status, or an empty list is never a login success.
 */
export function parseAgyModelsJson(raw: string): AgyCatalogModel[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const result = payload as {
    status?: unknown;
    command?: { name?: unknown; data?: { models?: unknown } };
  };
  if (result.status !== 'SUCCESS' || result.command?.name !== 'models') return [];
  const items = result.command.data?.models;
  if (!Array.isArray(items) || items.length === 0 || items.length > 512) return [];

  const models: AgyCatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as { id?: unknown; label?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    if (!MODEL_ID_PATTERN.test(id) || !label || label.length > 256 || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: label });
  }
  return models;
}

/**
 * Find an existing agy executable without downloading, modifying, or logging
 * any local Google credentials.
 */
export function resolveAgyCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const basename = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    env.AGY_PATH,
    path.join(home, '.gemini', 'bin', basename),
    path.join(home, '.local', 'bin', basename),
    ...String(env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, basename)),
  ];
  return candidates.find((candidate) => Boolean(candidate && existsSync(candidate))) ?? null;
}

/**
 * Run the official CLI as a read-only catalog query. Stdin is closed from the
 * start to avoid the documented agy models deadlock with an open pipe.
 */
export const runAgyModelsCommand: CatalogCommandRunner = (options) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Antigravity model discovery aborted'));
      return;
    }
    const child = spawn(options.command, ['--output-format', 'json', 'models'], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let totalBytes = 0;
    const stdout: Buffer[] = [];

    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The subprocess may already have terminated.
      }
    };
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      kill();
      finish(new Error('Antigravity model discovery aborted'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error('Antigravity model discovery timed out'));
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        kill();
        finish(new Error('Antigravity model catalog exceeded size limit'));
        return;
      }
      stdout.push(data);
    });
    // Never include stderr in auth evidence or expose it to model consumers.
    child.stderr?.resume();
    child.once('error', (error) => finish(error));
    child.once('close', (exitCode) => {
      finish(undefined, { exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });

/**
 * Last successful account discovery is safe as UI readiness evidence while
 * warm. This is not an OAuth token and is never used as network credentials.
 */
export function hasVerifiedAgySession(now: number = Date.now()): boolean {
  return Boolean(lastGood && lastGood.expiresAt > now);
}

export async function discoverAgyModels(
  options: DiscoverAgyModelsOptions = {},
): Promise<AgyCatalogSnapshot | null> {
  const now = options.now ?? Date.now;
  const current = now();
  if (lastGood && lastGood.expiresAt > current) {
    return { ...lastGood, source: 'cache' };
  }
  if (inFlight) return inFlight;
  if (current < nextAllowedAttempt) {
    return lastGood ? { ...lastGood, source: 'cache' } : null;
  }
  const env = options.env ?? process.env;
  const binary = resolveAgyCommand(env);
  if (!binary) {
    nextAllowedAttempt = current + ERROR_RETRY_MS;
    return lastGood ? { ...lastGood, source: 'cache' } : null;
  }
  const runner = options.runner ?? runAgyModelsCommand;
  const refresh = async (): Promise<AgyCatalogSnapshot | null> => {
    try {
      const result = await runner({
        command: binary,
        env,
        timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? CATALOG_TIMEOUT_MS, 60_000)),
        signal: options.signal,
      });
      if (result.exitCode !== 0) throw new Error('Antigravity models command returned an error');
      const models = parseAgyModelsJson(result.stdout);
      if (models.length === 0) throw new Error('Antigravity models command returned no valid models');
      const fetchedAt = now();
      lastGood = {
        models,
        fetchedAt,
        expiresAt: fetchedAt + (options.ttlMs ?? CATALOG_TTL_MS),
      };
      nextAllowedAttempt = 0;
      return { ...lastGood, source: 'live' };
    } catch {
      nextAllowedAttempt = now() + ERROR_RETRY_MS;
      return lastGood ? { ...lastGood, source: 'cache' } : null;
    }
  };
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
