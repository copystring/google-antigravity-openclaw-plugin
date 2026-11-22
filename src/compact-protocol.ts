/**
 * Validate a native agy checkpoint rather than assuming that a zero exit code
 * or an empty assistant response means compaction succeeded.
 */
export function validateNativeCompactionOutput(rawOutput: string): { ok: true } | { ok: false; reason: string } {
  for (const line of rawOutput.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        status?: unknown;
        checkpoint?: unknown;
      };
      if (
        record.type === 'compaction_complete' &&
        record.status === 'SUCCESS' &&
        record.checkpoint === true
      ) {
        return { ok: true };
      }
    } catch {
      // Ignore non-JSON output, but never treat it as proof of compaction.
    }
  }
  return { ok: false, reason: 'Antigravity did not confirm a completed native checkpoint.' };
}
