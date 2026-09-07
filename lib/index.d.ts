/**
 * @d86e/dsh-doctor — plugin entry.
 *
 * Registers the `dsh_doctor_*` tools on the `tools` service and refuses to
 * load if the resolved `@deepseek-ai/dsh-tools` is outside the tested
 * range (see version.ts).
 *
 * Dual mode:
 *   1. Static package — mount as a DSH composition row (see cordis.patch.yml).
 *      The loader invokes `apply(ctx, config)` and the nine tools become
 *      available to every agent after the next `dsh web` start.
 *   2. Dynamic sandbox — paste the *built* `lib/index.js` into the
 *      `code.host` field of `cordis_define` and run it. The sandbox supplies
 *      the `harness` global, which we adapt to the same `ctx.tools` shape.
 *
 * @module @d86e/dsh-doctor
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigT, resolveConfig } from './config.js';
import { satisfiesCaret, TESTED_PEER_RANGE } from './version.js';
import { triage, diagnose, type ActionPlan } from './triage.js';
import { applySafeModePatch, clearSafeModePatch, isSafeModeActive } from './safe-mode.js';
import { buildServiceSpec, writeServiceSpec, removeServiceSpec, currentPlatform } from './platform.js';
import { installWatchdogScript, isWatchdogInstalled, pluginVersion } from './watchdog.js';
import { WATCHDOG_STANDALONE_BODY } from './watchdog.standalone.js';
import { type ToolErrorEntry } from './tool-errors.js';
export declare const name = "dsh-doctor";
export declare const inject: string[];
/** Snapshot of the resolved @deepseek-ai/dsh-tools version. Exposed for tests. */
export declare function resolvedDshToolsVersion(): string;
/** Turn a silent peer mismatch into a loud, actionable load error. */
export declare function assertPeerCompatible(): void;
/**
 * Does `process.argv` look like a genuine `dsh web` launch?
 *
 * The doctor's apply() runs in whatever process mounts the web profile,
 * and that is NOT always the web server: `dsh plugin --profile web add`,
 * a profile-check, or a one-shot `node` evaluating the profile all run
 * apply() too (observed live: a `dsh plugin add`'s short-lived pid
 * clobbered the running web's .dsh-web.pid). Only a process whose
 * first non-flag subcommand token is `web` is actually the server, so
 * only it should publish its pid.
 */
export declare function looksLikeDshWeb(argv?: readonly string[]): boolean;
export declare function apply(ctx: Context, config: ConfigT): void;
interface RecoveryEntry {
    ts: string;
    plan: string;
    detail: string;
}
/**
 * Human-readable uptime from a duration in seconds.
 *
 * Rule: drop leading zero units, show at most three units, drop
 * trailing zero units. '300s' -> '5m' (not '5m 0s'),
 * '86400+3600' -> '1d 1h', '2d 3h 1m 1s' -> '2d 3h 1m' (seconds fall
 * off the three-unit budget), '0' -> '0s'.
 */
declare function formatUptime(sec: number): string;
export { formatUptime, Config, resolveConfig, satisfiesCaret, TESTED_PEER_RANGE, triage, diagnose, applySafeModePatch, clearSafeModePatch, isSafeModeActive, buildServiceSpec, writeServiceSpec, removeServiceSpec, currentPlatform, installWatchdogScript, isWatchdogInstalled, pluginVersion, WATCHDOG_STANDALONE_BODY, };
export type { ConfigT, ActionPlan, RecoveryEntry, ToolErrorEntry };
//# sourceMappingURL=index.d.ts.map