// Everything the plugin does to the Mac goes through here: running a command and sending a
// signal. Tests replace it with `useSystem`, since their process lists are fake and a real signal
// would hit a real PID.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type System = {
  /** Runs a binary with arguments (no shell). With `allowFail`, output is kept even on exit ≠ 0. */
  run(bin: string, args: string[], opts?: { timeout?: number; allowFail?: boolean }): Promise<string>
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean
  sleep(ms: number): Promise<void>
}

const real: System = {
  run: (bin, args, opts = {}) =>
    new Promise((resolve, reject) =>
      execFile(bin, args, { timeout: opts.timeout ?? 15_000, maxBuffer: 64 * 2 ** 20 }, (error, stdout, stderr) =>
        error && !(opts.allowFail && stdout) ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)
      )
    ),
  signal: (pid, sig) => {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      return false
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}


// The worker's PATH may be minimal: use absolute paths.
const first = (paths: string[], fallback: string) => paths.find((p) => existsSync(p)) ?? fallback

export const BIN = {
  ps: '/bin/ps',
  top: '/usr/bin/top',
  lsof: '/usr/sbin/lsof',
  sysctl: '/usr/sbin/sysctl',
  orca: first(['/usr/local/bin/orca', '/opt/homebrew/bin/orca', '/Applications/Orca.app/Contents/Resources/bin/orca'], 'orca'),
  docker: first(['/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.docker/bin/docker')], '')
}

export const PS_ARGS = ['-Ao', 'pid=,ppid=,time=,rss=,command=']

const REAL_BIN = { ...BIN }

export let system: System = real

/** Tests only: replace part of the system, and binaries a CI machine may lack (docker); call
 *  with no argument to restore both. */
export function useSystem(fake?: Partial<System>, bins: Partial<typeof BIN> = {}): void {
  system = fake ? { ...real, ...fake } : real
  Object.assign(BIN, REAL_BIN, fake ? bins : {})
}
