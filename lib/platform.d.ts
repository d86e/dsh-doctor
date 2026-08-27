/**
 * Platform-specific service registration.
 *
 * Generates the snippets that the watchdog needs to be a per-user, persistent
 * service independent of `dsh web`:
 *
 *   - macOS:   LaunchAgent plist under platform/com.deepseek-ai.dsh-doctor.plist
 *   - Linux:   systemd user unit  + cron @reboot fallback
 *   - Windows: Task Scheduler XML + VBS launcher (best-effort, unverified)
 *
 * Each function is `async` because it may need to mkdir the platform dir.
 * None of them call `launchctl` / `systemctl` / `schtasks` — that is the
 * install tool's job (or, in the watchdog's case, a one-time shell-out).
 *
 * @module dsh-doctor/platform
 */
export type Platform = 'darwin' | 'linux' | 'win32' | 'unknown';
export declare function currentPlatform(): Platform;
export interface ServiceSpec {
    /** Human-readable label, e.g. "LaunchAgent com.deepseek-ai.dsh-doctor". */
    label: string;
    /** The file path written under $DSH_HOME/doctor/platform/. */
    file: string;
    /** The file content. */
    content: string;
    /** The shell command the install tool would run to register this service. */
    registerCmd: string[];
    /** The shell command the install tool would run to start it. */
    startCmd: string[];
    /** The shell command the install tool would run to stop it. */
    stopCmd: string[];
    /** The shell command the install tool would run to unregister. */
    unregisterCmd: string[];
}
/** Build the service spec for the current platform. */
export declare function buildServiceSpec(opts: {
    nodeBin: string;
    dshHome: string;
    webPort: number;
}): Promise<ServiceSpec>;
/** Write the platform service file (or files) to disk. */
export declare function writeServiceSpec(spec: ServiceSpec): Promise<void>;
/** Convenience: remove the platform service file(s). */
export declare function removeServiceSpec(): Promise<void>;
//# sourceMappingURL=platform.d.ts.map