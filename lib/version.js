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
export const TESTED_PEER_RANGE = '^0.1.0-rc.6';
/**
 * Parse a semver string like `0.1.0-rc.6`, `0.1.0`, `1.2.3-alpha.1+sha`.
 * Returns `null` if the input does not look like a semver.
 */
export function parseSemver(version) {
    const m = String(version ?? '')
        .trim()
        .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!m)
        return null;
    return {
        maj: Number(m[1]),
        min: Number(m[2]),
        pat: Number(m[3]),
        pre: m[4] ? m[4].split('.') : [],
    };
}
/**
 * Semver prerelease ordering:
 * - a release beats any prerelease of the same `M.m.p` core
 * - numeric ids sort before alphanumeric ids
 * - a shorter prefix beats a longer one with the same prefix
 */
function preGt(a, b) {
    if (a.length === 0 && b.length === 0)
        return false;
    if (a.length === 0)
        return true; // release > prerelease
    if (b.length === 0)
        return false;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const x = a[i];
        const y = b[i];
        if (x === y)
            continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn)
            return Number(x) > Number(y);
        if (xn)
            return false; // numeric < alphanumeric
        if (yn)
            return true;
        return x > y;
    }
    return a.length > b.length;
}
function parsedGtOrEqual(a, b) {
    if (a.maj !== b.maj)
        return a.maj > b.maj;
    if (a.min !== b.min)
        return a.min > b.min;
    if (a.pat !== b.pat)
        return a.pat > b.pat;
    // Same core: a release is >= any prerelease. For two prereleases, use preGt.
    if (a.pre.length === 0)
        return true;
    if (b.pre.length === 0)
        return false;
    return !preGt(b.pre, a.pre); // a >= b iff b.pre is not greater than a.pre
}
/**
 * Return true if `version` satisfies a caret range like `^0.1.0-rc.6`.
 *
 * Caret semantics: keep the leftmost non-zero component fixed. `^0.1.x` allows
 * changes only in the patch (and prerelease) of `0.1.x`; `^1.2.3` allows any
 * `>=1.2.3 <2.0.0`; `^0.0.x` allows only the exact `0.0.x` core.
 */
export function satisfiesCaret(version, range) {
    if (!range.startsWith('^'))
        return false;
    const min = parseSemver(range.slice(1));
    const v = parseSemver(version);
    if (!min || !v)
        return false;
    // First check >= min.
    if (!parsedGtOrEqual(v, min))
        return false;
    // Then check upper bound, depending on the leftmost non-zero.
    if (min.maj > 0)
        return v.maj === min.maj;
    if (min.min > 0)
        return v.maj === min.maj && v.min === min.min;
    // 0.0.x — exact core
    return v.maj === min.maj && v.min === min.min && v.pat === min.pat;
}
//# sourceMappingURL=version.js.map