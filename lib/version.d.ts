/**
 * Dependency-free semver caret-range matcher.
 *
 * Used to refuse to load when the resolved `@deepseek-ai/dsh-tools` does not
 * satisfy the peer range this plugin was tested against. The matcher is small
 * and intentionally narrow — it only handles the caret semantics that npm and
 * pnpm implement for the `0.1.0-rc.X` range we depend on. It is *not* a full
 * semver implementation.
 *
 * @module dsh-doctor/version
 */
export declare const TESTED_PEER_RANGE = "^0.1.0-rc.6";
interface ParsedSemver {
    readonly maj: number;
    readonly min: number;
    readonly pat: number;
    readonly pre: readonly string[];
}
/**
 * Parse a semver string like `0.1.0-rc.6`, `0.1.0`, `1.2.3-alpha.1+sha`.
 * Returns `null` if the input does not look like a semver.
 */
export declare function parseSemver(version: string): ParsedSemver | null;
/**
 * Return true if `version` satisfies a caret range like `^0.1.0-rc.6`.
 *
 * Caret semantics: keep the leftmost non-zero component fixed. `^0.1.x` allows
 * changes only in the patch (and prerelease) of `0.1.x`; `^1.2.3` allows any
 * `>=1.2.3 <2.0.0`; `^0.0.x` allows only the exact `0.0.x` core.
 */
export declare function satisfiesCaret(version: string, range: string): boolean;
export {};
//# sourceMappingURL=version.d.ts.map