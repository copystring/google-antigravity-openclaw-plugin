import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = pkg.devDependencies?.openclaw;
const build = pkg.openclaw?.build;
const compatibility = pkg.openclaw?.compat;
const expectedRange = `>=${version}`;

if (!version || build?.openclawVersion !== version || build?.pluginSdkVersion !== version) {
  throw new Error('OpenClaw build and Plugin SDK versions must match the pinned devDependency.');
}
if (
  compatibility?.pluginApi !== expectedRange ||
  compatibility?.minGatewayVersion !== expectedRange ||
  pkg.openclaw?.install?.minHostVersion !== expectedRange ||
  pkg.peerDependencies?.openclaw !== expectedRange
) {
  throw new Error(`Plugin compatibility and host ranges must be ${expectedRange}.`);
}

console.log(`OpenClaw plugin SDK/build/compatibility aligned at ${version}.`);
