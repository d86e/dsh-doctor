/**
 * Tool error classifier + sink.
 *
 * Subscribes to dsh's `tools/execute` and `tools/post-execute` waterfalls
 * via the `cordis` event bus. Classifies every failed tool call into one
 * of three buckets and records it (rotating log + in-memory per-session
 * queue). Does **not** mutate the waterfall — `next()` is always called
 * with the original result. The agent's current task is sacred.
 *
 * @module dsh-doctor/tool-errors
 */
import type { Context } from '@deepseek-ai/cordis';
import { DoctorLog } from './doctor-log.js';
import type { Config as ConfigT } from './config.js';
/** Three-way classification used by the doctor. */
export type ToolErrorClass = 'transient' | 'agent' | 'business';
/** Public context object handed to user-supplied classifiers. */
export interface ToolErrorContext {
    /** Name of the tool that failed. */
    toolName: string;
    /** ToolErrorInfo (name + code) if present, else null. */
    info: {
        name: string;
        code: string;
    } | null;
    /** Human-readable error message. */
    message: string;
    /** Session id the tool call belongs to, if known. */
    sessionId: string | null;
    /** Agent id, if known. */
    agentId: string | null;
}
/** A user-supplied override. Returning a string overrides the default. */
export type ToolErrorClassifier = (ctx: ToolErrorContext) => ToolErrorClass | null | undefined;
/** A user-supplied policy: called after classification, returns whether to record. */
export type ToolErrorPolicy = (ctx: ToolErrorContext, klass: ToolErrorClass) => {
    record: boolean;
    log: boolean;
    defer: boolean;
};
/** One recorded error. */
export interface ToolErrorEntry {
    ts: string;
    toolName: string;
    klass: ToolErrorClass;
    message: string;
    info: {
        name: string;
        code: string;
    } | null;
    sessionId: string | null;
    agentId: string | null;
    policy: 'recorded' | 'silenced' | 'deferred';
}
/** Default per-session queue (FIFO with cap). */
export declare class ToolErrorQueue {
    private readonly cap;
    private readonly items;
    private readonly bySession;
    constructor(cap: number);
    push(entry: ToolErrorEntry): void;
    /** Drain the per-session queue; entries are removed. */
    drain(sessionId: string | null, max: number): ToolErrorEntry[];
    /** Read-only summary for `dsh_doctor_status`. */
    summary(sinceMs: number): {
        transient: number;
        agent: number;
        business: number;
        total: number;
    };
}
export declare function defaultClassify(ctx: ToolErrorContext): ToolErrorClass;
export declare function defaultPolicy(_ctx: ToolErrorContext, klass: ToolErrorClass): {
    record: boolean;
    log: boolean;
    defer: boolean;
};
/** Returned handle so the doctor can stop subscribing in tests. */
export interface ToolErrorCapture {
    queue: ToolErrorQueue;
    /** Total entries since the capture started (regardless of cap). */
    total: () => number;
    /** Stop listening and clear the file sink. */
    dispose: () => void;
}
/** Wire the capture into a cordis `Context`. */
export declare function installToolErrorCapture(ctx: Context, cfg: ConfigT, log: DoctorLog, classifier?: ToolErrorClassifier, policy?: ToolErrorPolicy): ToolErrorCapture;
/** Public read-only summary writer for `dsh_doctor_status`. */
export interface ToolErrorSummary {
    transient: number;
    agent: number;
    business: number;
    total: number;
    queueSize: number;
}
/** Read the latest summary for the `status` tool. */
export declare function readSummary(capture: ToolErrorCapture, windowMs?: number): ToolErrorSummary;
/** Make sure the tool-errors log file exists (touch). */
export declare function ensureToolErrorLogFile(cfg: ConfigT): Promise<string>;
//# sourceMappingURL=tool-errors.d.ts.map