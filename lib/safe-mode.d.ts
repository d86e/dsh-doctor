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
import * as path from 'node:path';
/** Build a safe-mode patch file body. */
export declare function buildSafeModePatch(allowList: readonly string[]): string;
/** Write the safe-mode patch to its target path. Idempotent. */
export declare function applySafeModePatch(allowList: readonly string[]): Promise<string>;
/** Read the current safe-mode patch, or `null` if absent. */
export declare function readSafeModePatch(): Promise<string | null>;
/** Remove the safe-mode patch. Idempotent. */
export declare function clearSafeModePatch(): Promise<void>;
/** Is the safe-mode patch currently active (file present)? */
export declare function isSafeModeActive(): Promise<boolean>;
/** Resolve the path of the safe-mode patch (for logging). */
export declare function safeModePatchPath(): string;
/** Suppress unused-import warning for `path` in environments that tree-shake. */
export declare const _unusedPath: path.PlatformPath;
//# sourceMappingURL=safe-mode.d.ts.map