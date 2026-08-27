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
export declare function apply(ctx: Context, config: ConfigT): void;
interface RecoveryEntry {
    ts: string;
    plan: string;
    detail: string;
}
export { Config, resolveConfig, satisfiesCaret, TESTED_PEER_RANGE, triage, diagnose, applySafeModePatch, clearSafeModePatch, isSafeModeActive, buildServiceSpec, writeServiceSpec, removeServiceSpec, currentPlatform, installWatchdogScript, isWatchdogInstalled, pluginVersion, WATCHDOG_STANDALONE_BODY, };
export type { ConfigT, ActionPlan, RecoveryEntry, ToolErrorEntry };
//# sourceMappingURL=index.d.ts.map