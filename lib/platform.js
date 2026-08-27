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
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { StatePaths, ensureDir } from './state.js';
export function currentPlatform() {
    switch (process.platform) {
        case 'darwin':
            return 'darwin';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'win32';
        default:
            return 'unknown';
    }
}
/** Build the service spec for the current platform. */
export async function buildServiceSpec(opts) {
    const { nodeBin, dshHome, webPort } = opts;
    const platform = currentPlatform();
    const platformDir = StatePaths.platformDir();
    await ensureDir(platformDir);
    if (platform === 'darwin') {
        const file = `${platformDir}/com.deepseek-ai.dsh-doctor.plist`;
        const content = plistBody({ nodeBin, dshHome, webPort });
        return {
            label: 'LaunchAgent com.deepseek-ai.dsh-doctor',
            file,
            content,
            registerCmd: ['launchctl', 'load', '-w', file],
            startCmd: ['launchctl', 'kickstart', '-k', `gui/${os.userInfo().uid}/com.deepseek-ai.dsh-doctor`],
            stopCmd: ['launchctl', 'stop', 'com.deepseek-ai.dsh-doctor'],
            unregisterCmd: ['launchctl', 'unload', '-w', file],
        };
    }
    if (platform === 'linux') {
        const file = `${platformDir}/dsh-doctor.service`;
        const content = systemdBody({ nodeBin, dshHome, webPort });
        const unitDir = `${os.homedir()}/.config/systemd/user`;
        const unitPath = `${unitDir}/dsh-doctor.service`;
        return {
            label: 'systemd user unit dsh-doctor.service',
            file,
            content,
            registerCmd: ['bash', '-c', `mkdir -p ${unitDir} && cp ${file} ${unitPath} && systemctl --user daemon-reload`],
            startCmd: ['systemctl', '--user', 'enable', '--now', 'dsh-doctor.service'],
            stopCmd: ['systemctl', '--user', 'stop', 'dsh-doctor.service'],
            unregisterCmd: ['systemctl', '--user', 'disable', '--now', 'dsh-doctor.service', '&&', 'rm', '-f', unitPath],
        };
    }
    if (platform === 'win32') {
        const xmlFile = `${platformDir}\\DshDoctorTask.xml`;
        const xml = windowsTaskXml({ dshHome, webPort });
        const vbs = windowsVbsLauncher({ nodeBin, dshHome, webPort });
        return {
            label: 'Task Scheduler DshDoctor (via VBS)',
            file: xmlFile,
            content: `${xml}\n---\n${vbs}`,
            registerCmd: [
                'cmd',
                '/c',
                `schtasks /Create /TN "DshDoctor" /XML "${xmlFile}"`,
            ],
            startCmd: ['cmd', '/c', 'schtasks /Run /TN "DshDoctor"'],
            stopCmd: ['cmd', '/c', 'schtasks /End /TN "DshDoctor"'],
            unregisterCmd: ['cmd', '/c', 'schtasks /Delete /TN "DshDoctor" /F'],
        };
    }
    throw new Error(`dsh-doctor: unsupported platform ${process.platform}`);
}
/** Write the platform service file (or files) to disk. */
export async function writeServiceSpec(spec) {
    if (process.platform === 'win32') {
        // Special case: write both the XML and the VBS from the joined content.
        const sep = '\n---\n';
        const sepIdx = spec.content.indexOf(sep);
        const xml = sepIdx >= 0 ? spec.content.slice(0, sepIdx) : spec.content;
        const vbs = sepIdx >= 0 ? spec.content.slice(sepIdx + sep.length) : '';
        await fs.writeFile(spec.file, xml, { mode: 0o600 });
        if (vbs.length > 0) {
            const vbsFile = spec.file.replace(/DshDoctorTask\.xml$/, 'dsh-doctor.vbs');
            await fs.writeFile(vbsFile, vbs, { mode: 0o600 });
        }
        return;
    }
    await fs.writeFile(spec.file, spec.content, { mode: 0o600 });
}
/** Convenience: remove the platform service file(s). */
export async function removeServiceSpec() {
    const dir = StatePaths.platformDir();
    try {
        const entries = await fs.readdir(dir);
        await Promise.all(entries.map((e) => fs.rm(pathJoin(dir, e), { force: true })));
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
function pathJoin(a, b) {
    return a.endsWith('/') || a.endsWith('\\') ? a + b : `${a}/${b}`;
}
function plistBody(opts) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.deepseek-ai.dsh-doctor</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodeBin)}</string>
    <string>${escapeXml(watchdogScriptPath())}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key>
    <string>${escapeXml(opts.dshHome)}</string>
    <key>DSH_WEB_PORT</key>
    <string>${opts.webPort}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath('watchdog.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath('watchdog.log'))}</string>
</dict>
</plist>
`;
}
function systemdBody(opts) {
    return `[Unit]
Description=dsh-doctor: self-healing watchdog for the DeepSeek Harness web profile
After=default.target

[Service]
Type=simple
ExecStart=${opts.nodeBin} ${watchdogScriptPath()}
Restart=always
RestartSec=10
StartLimitIntervalSec=0
Environment=DSH_HOME=${opts.dshHome}
Environment=DSH_WEB_PORT=${opts.webPort}

[Install]
WantedBy=default.target
`;
}
/** Windows Task Scheduler XML — best-effort, unverified on real hardware. */
function windowsTaskXml(opts) {
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dsh-doctor: self-healing watchdog for the DeepSeek Harness web profile</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B "${opts.dshHome}\\doctor\\platform\\dsh-doctor.vbs"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
/** Windows VBS launcher — sets env vars then starts node hidden. */
function windowsVbsLauncher(opts) {
    return `' dsh-doctor VBS launcher: sets DSH_HOME / DSH_WEB_PORT, then starts the watchdog hidden.
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("DSH_HOME") = "${opts.dshHome}"
shell.Environment("Process")("DSH_WEB_PORT") = "${opts.webPort}"
shell.Run """${opts.nodeBin}"" ""${watchdogScriptPath()}""", 0, False
`;
}
function watchdogScriptPath() {
    return StatePaths.watchdogScript();
}
function logPath(name) {
    return `${StatePaths.logsDir().replace(/\\/g, '/')}/${name}`;
}
function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
//# sourceMappingURL=platform.js.map