/**
 * Safe-mode patch layer.
 *
 * In the complex recovery path, dsh-doctor writes a `safe-mode.patch.yml`
 * that overrides every bundle in `dsh.profile.bundles` except the allow-list
 * in `Config.safeModeBundles`. The patch uses the same `- insert:` row format
 * the user can write by hand, so it composes with whatever the user already
 * has in `cordis.patch.yml`.
 *
 * The watchdog activates / deactivates safe mode by renaming the file in
 * place under a single rename call (atomic on POSIX, near-atomic on Windows).
 *
 * @module dsh-doctor/safe-mode
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StatePaths, ensureDir, readFileOrNull, writeFileAtomic } from './state.js';
/** Build a safe-mode patch file body. */
export function buildSafeModePatch(allowList) {
    // The patch uses `- insert:` rows to *override* every bundle in the
    // profile with a no-op config (`safeMode: true`). The allow-list bundles
    // get the safe-mode marker so the user can tell the layer apart. Bundles
    // that do not exist in the profile at all are silently ignored by cordis.
    const header = [
        '# dsh-doctor safe-mode patch (auto-generated).',
        '# Activated by the watchdog in the complex recovery path.',
        '# Remove this file (or rename to .disabled) to exit safe mode.',
    ].join('\n');
    const insertHeader = '- insert:';
    const rows = allowList.length > 0
        ? allowList.map((id) => `    - id: ${id}\n      name: ${id}\n      config: {safeMode: true}`)
        : ['    - id: dsh-doctor-safe-mode-sentinel\n      name: dsh-doctor\n      config: {safeModeSentinel: true}'];
    return `${header}\n${insertHeader}\n${rows.join('\n')}\n`;
}
/** Write the safe-mode patch to its target path. Idempotent. */
export async function applySafeModePatch(allowList) {
    await ensureDir(StatePaths.doctorHome());
    const p = StatePaths.safeModePatch();
    await writeFileAtomic(p, buildSafeModePatch(allowList));
    return p;
}
/** Read the current safe-mode patch, or `null` if absent. */
export async function readSafeModePatch() {
    return readFileOrNull(StatePaths.safeModePatch());
}
/** Remove the safe-mode patch. Idempotent. */
export async function clearSafeModePatch() {
    try {
        await fs.unlink(StatePaths.safeModePatch());
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
/** Is the safe-mode patch currently active (file present)? */
export async function isSafeModeActive() {
    const content = await readFileOrNull(StatePaths.safeModePatch());
    return content !== null;
}
/** Resolve the path of the safe-mode patch (for logging). */
export function safeModePatchPath() {
    return StatePaths.safeModePatch();
}
/** Suppress unused-import warning for `path` in environments that tree-shake. */
export const _unusedPath = path;
//# sourceMappingURL=safe-mode.js.map