#!/usr/bin/env node
/**
 * Forward an ordinary CLI turn verbatim, refreshing the per-attempt MCP overlay
 * after OpenClaw has rotated its capture credentials for this native process.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { refreshNormalMcpHome } from './bundled-mcp-home.js';

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const home = process.env.HOME;
  if (process.env.OPENCLAW_ANTIGRAVITY_NORMAL_MCP_OVERLAY === '1') {
    const originalHome = process.env.OPENCLAW_ANTIGRAVITY_ORIGINAL_HOME;
    const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (!home || !originalHome || !settingsPath ||
        !path.basename(home).startsWith('openclaw-antigravity-mcp-') ||
        path.resolve(home) === path.resolve(originalHome)) {
      throw new Error('Refusing to refresh Antigravity MCP outside the private overlay');
    }
    await refreshNormalMcpHome({
      home,
      sourceHome: originalHome,
      systemSettingsPath: settingsPath,
      env: process.env as Record<string, string>,
    });
  }

  const oneShotCli = require.resolve('google-antigravity-acp/dist/one-shot-cli.js');
  const child = spawn(process.execPath, [oneShotCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal);
  };
  const terminate = () => forwardSignal('SIGTERM');
  const interrupt = () => forwardSignal('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    if (exit.signal) {
      process.exitCode = exit.signal === 'SIGINT' ? 130 : 143;
    } else {
      process.exitCode = exit.code ?? 1;
    }
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write('Antigravity MCP bridge failed: ' +
    (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
