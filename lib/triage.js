/**
 * Triage engine. Given the tail of the dsh web boot log, returns an
 * `ActionPlan` describing the cheapest recovery that is likely to work.
 *
 * The engine is intentionally narrow. New failure modes are added by adding
 * a new `Pattern` entry — see CONTRIBUTING.md.
 *
 * @module dsh-doctor/triage
 */
/** The full pattern table, ordered by `priority` descending at match time. */
export const PATTERNS = [
    {
        id: 'eaddrinuse',
        description: 'Port already in use (probably an orphan dsh web pid).',
        regex: /EADDRINUSE.*?(?:127\.0\.0\.1|0\.0\.0\.0|::):(\d+)/,
        priority: 100,
        extractId: () => null,
        build: () => ({
            kind: 'kill-pid-and-restart',
            reason: 'EADDRINUSE — kill recorded pid and restart',
            via: 'simple',
        }),
    },
    {
        id: 'duplicate-loader-entry',
        description: 'duplicate loader entry id (a plugin row is registered twice).',
        regex: /duplicate loader entry id:\s*([A-Za-z0-9_.\-@/]+)/,
        priority: 90,
        extractId: (m) => m[1] ?? null,
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'duplicate loader entry id',
            via: 'simple',
        }),
    },
    {
        id: 'schema-parse-error',
        description: 'Schema parse error pointing at a plugin package.',
        // Match a scoped package (@scope/...) or a single bareword after the
        // keyword. The character class excludes "in"/"at"/"for" filler words
        // by requiring the package to start with a non-letter or be a bareword
        // preceded by whitespace at a token boundary.
        regex: /Schema (?:parse|validation) error[^\n]*?(?:@([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)|^([A-Za-z][A-Za-z0-9_.\-]{1,})$)/m,
        priority: 80,
        extractId: (m) => {
            if (m[1] && m[2])
                return `@${m[1]}/${m[2]}`;
            if (m[3])
                return m[3];
            return null;
        },
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'schema parse error',
            via: 'simple',
        }),
    },
    {
        id: 'cannot-find-module',
        description: 'Cannot find module (a plugin dependency is missing).',
        regex: /Cannot find module ['"]([^'"]+)['"]/,
        priority: 70,
        extractId: (m) => {
            const spec = m[1] ?? '';
            // Extract a plausible plugin id from a spec like '@scope/name/sub/path'.
            const parts = spec.replace(/^node:/, '').split('/');
            if (spec.startsWith('@') && parts.length >= 2)
                return `${parts[0]}/${parts[1]}`;
            return parts[0] || null;
        },
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'cannot find module',
            via: 'simple',
        }),
    },
    {
        id: 'plugin-load-error',
        description: 'Generic load error that names a plugin id.',
        regex: /(?:Failed to (?:load|apply)|Error (?:loading|applying)) plugin ['"]?([@A-Za-z0-9_.\-/]+)['"]?/,
        priority: 60,
        extractId: (m) => m[1] ?? null,
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'plugin load error',
            via: 'simple',
        }),
    },
    {
        id: 'plugin-export-missing',
        description: 'A plugin file did not export `name` and `apply`.',
        regex: /(?:Plugin|module|Bundle)\s+['"]?([@A-Za-z0-9_.\-/]+)?['"]?\s+(?:did not|must|should) export(?:\s+(?:a\s+)?['"]name['"]|['"]name['"]\s+and\s+['"]apply['"])/,
        priority: 75,
        extractId: (m) => m[1] || null,
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'plugin did not export name/apply',
            via: 'simple',
        }),
    },
    {
        id: 'plugin-file-missing',
        description: 'A plugin file path does not exist (ENOENT).',
        regex: /ENOENT.*?['"]([^'"]+\.(?:js|mjs|cjs|ts))['"]|Cannot find (?:module|file) ['"]([^'"]+\.(?:js|mjs|cjs|ts))['"]/,
        priority: 72,
        extractId: (m) => {
            const spec = m[1] ?? m[2] ?? '';
            const parts = spec.replace(/^node:/, '').split('/');
            if (spec.startsWith('@') && parts.length >= 2)
                return `${parts[0]}/${parts[1]}`;
            return parts[0] || null;
        },
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'plugin file not found',
            via: 'simple',
        }),
    },
    {
        id: 'cordis-schema-validate',
        description: 'cordis 4.x tried to call a non-standard-schema plugin Config.',
        regex: /Cannot read propert(?:y|ies) of undefined \(reading ['"]validate['"]\)|Config\["~standard"\]/,
        priority: 85,
        extractId: () => null,
        build: () => {
            // The plugin at fault is the LAST one in the boot log before
            // this error; without a clean identifier we cannot safely
            // disable a specific row, so fall back to safe-mode (which
            // keeps dsh-core only).
            return {
                kind: 'safe-mode',
                reason: 'cordis 4.x Config[~standard].validate missing on a plugin — falling back to safe-mode',
                via: 'complex',
            };
        },
    },
    {
        id: 'pnpm-peer-conflict',
        description: 'pnpm peer-dependency conflict (a plugin needs an incompatible version of a shared dep).',
        regex: /(?:peer dep|peerDependencies?|ERESOLVE).*?(?:@?[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+|[A-Za-z0-9_.\-]+)@[\^~]?[\d.]+.*?(?:incompatible|conflict)/i,
        priority: 78,
        extractId: (m) => {
            const pkg = m[1] ?? m[0];
            const match = (pkg ?? '').match(/(@?[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)/);
            return match ? match[1] : null;
        },
        build: (id) => ({
            kind: 'disable-row',
            pluginId: id ?? 'unknown',
            reason: 'pnpm peer-dependency conflict',
            via: 'simple',
        }),
    },
    {
        id: 'node-version-mismatch',
        description: 'A plugin requires a Node version newer than what is installed.',
        regex: /Requires Node(?:\.js)?\s+[`'"]?(\^?~?>?=?v?[\d.]+)/i,
        priority: 95,
        extractId: () => null,
        build: (m) => ({
            kind: 'notify-user',
            reason: 'plugin requires Node ' + (m ?? '?') + ' but dsh ships an older Node. Update dsh or remove the plugin.',
            via: 'complex',
        }),
    },
    {
        id: 'disk-full',
        description: 'ENOSPC: the disk holding dsh web state is full.',
        regex: /ENOSPC.*?(?:no space left|disk full)/i,
        priority: 90,
        extractId: () => null,
        build: () => ({
            kind: 'notify-user',
            reason: 'disk full (ENOSPC). Free space under ~/.dsh/doctor/logs or its parent filesystem.',
            via: 'complex',
        }),
    },
    {
        id: 'corrupt-patch-yaml',
        description: 'cordis.patch.yml failed to parse — user edited it badly or auto-install wrote garbage.',
        regex: /(?:patch|yaml|YAML).*?(?:parse|syntax)\s*error|cordis\.patch\.yml.*?invalid/i,
        priority: 88,
        extractId: () => null,
        build: () => ({
            kind: 'cleanup-and-restart',
            reason: 'corrupt cordis.patch.yml — backup the broken file and write a fresh empty patch',
            via: 'complex',
        }),
    },
];
/**
 * Run triage against a log buffer. Returns the first matching plan, or
 * a complex-path safe-mode plan if nothing matches.
 */
export function triage(logBuffer) {
    const joined = logBuffer.join('\n');
    const sorted = [...PATTERNS].sort((a, b) => b.priority - a.priority);
    for (const p of sorted) {
        const m = joined.match(p.regex);
        if (m) {
            const id = p.extractId(m);
            return p.build(id);
        }
    }
    return { kind: 'safe-mode', reason: 'no-pattern-matched', via: 'complex' };
}
export function diagnose(logBuffer) {
    const joined = logBuffer.join('\n');
    const sorted = [...PATTERNS].sort((a, b) => b.priority - a.priority);
    for (const p of sorted) {
        const m = joined.match(p.regex);
        if (m) {
            const id = p.extractId(m);
            return { plan: p.build(id), matched: p, reason: p.description };
        }
    }
    return {
        plan: { kind: 'safe-mode', reason: 'no-pattern-matched', via: 'complex' },
        matched: null,
        reason: 'no known pattern matched the log buffer',
    };
}
//# sourceMappingURL=triage.js.map