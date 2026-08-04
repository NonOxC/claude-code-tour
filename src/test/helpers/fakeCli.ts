/**
 * Test harness for startTour()/runTour() in src/claudeRunner.ts.
 *
 * The module is not injectable: it resolves a CLI path itself and then calls
 * child_process.spawn() directly. Pointing `claudePath` at a throwaway script is
 * only half a solution, because a script is not directly spawnable on Windows -
 * both of these were verified on the dev machine:
 *
 *   - spawn('...\\shim.cmd', args)   -> EINVAL (Node's CVE-2024-27980 fix refuses
 *     .cmd/.bat without `shell: true`, which this extension must never turn on).
 *   - spawn(process.execPath, args) -> node parses `args` as its own options and
 *     dies with `bad option: --output-format` before any script could run.
 *
 * So instead of replacing the *path*, this harness replaces the *launcher*: it
 * swaps child_process.spawn for a recorder that forwards to the REAL spawn as
 *
 *     spawn(process.execPath, [fakeClaudeCli.cjs, ...args], options)
 *
 * The fake CLI is therefore a real child process. It receives the exact argv the
 * module built, receives the prompt on real stdin, and the exit codes, kills and
 * pipe behaviour the module reacts to are real. `claudePath` still has to point at
 * a file that exists, because resolveClaudeCli() stats it before spawning - the
 * harness creates one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { clearCliCache } from '../../claudeRunner';

/**
 * Deliberately a bare `require`, not `import * as childProcess`: with
 * esModuleInterop a namespace import is emitted as `__importStar(require(...))`,
 * which copies the builtin's properties into a fresh object. Patching that copy
 * would leave claudeRunner's own `require('child_process')` untouched and the
 * tests would silently spawn the real CLI.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process') as {
  spawn: typeof import('child_process').spawn;
  execFile: typeof import('child_process').execFile;
};

export interface CliPlan {
  /** Raw stdout text. Takes precedence over `envelope`. */
  stdout?: string;
  /** Object written to stdout as JSON, with the child's own argv merged in. */
  envelope?: unknown;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  /** Stay alive this long after writing, so the parent has to kill us. */
  hangMs?: number;
  /** Write this many MiB of junk to stdout (for the output-overflow guard). */
  floodMiB?: number;
}

export interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

export interface FakeCli {
  /** Every spawn() the module made, as it made it. */
  calls: SpawnCall[];
  /** The single spawn call; throws if there was not exactly one. */
  readonly call: SpawnCall;
  /** argv the fake CLI process actually received (its own process.argv.slice(2)). */
  childArgv(): string[];
  /** Everything the module wrote to the child's stdin. */
  childStdin(): string;
  /** A real, empty directory usable as `workspaceRoot`. */
  readonly workspaceRoot: string;
  /** A real, spawnable-looking file to use as `claudePath`. */
  readonly claudePath: string;
  restore(): void;
}

export interface FakeCliOptions {
  /**
   * Rewrite the module's hardcoded 3-minute timeout to this many ms. The timeout
   * is neither configurable nor injectable, so the only way to exercise that
   * branch in a fast test is to intercept the setTimeout call itself.
   */
  shortenTimeoutTo?: number;
  /** The exact delay to rewrite (the module's DEFAULT_TIMEOUT_MS). */
  timeoutDelay?: number;
}

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Could not locate the repo root from ${__dirname}`);
}

export const FIXTURE_PATH = path.join(findRepoRoot(), 'src', 'test', 'fixtures', 'fakeClaudeCli.cjs');

export function makeTempDir(prefix = 'cct-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Creates a file that resolveClaudeCli() will accept as the CLI. */
export function makeFakeClaudeBinary(dir: string, base = 'fake-claude'): string {
  const name = process.platform === 'win32' ? `${base}.exe` : base;
  const target = path.join(dir, name);
  fs.writeFileSync(target, 'not a real binary; spawn is intercepted in tests', 'utf8');
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
  }
  return target;
}

export function installFakeCli(plan: CliPlan = {}, opts: FakeCliOptions = {}): FakeCli {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fake CLI fixture is missing: ${FIXTURE_PATH}`);
  }

  const calls: SpawnCall[] = [];
  const workspaceRoot = makeTempDir();
  const sideDir = makeTempDir('cct-side-');
  const argvOut = path.join(sideDir, 'argv.json');
  const stdinOut = path.join(sideDir, 'stdin.txt');
  const claudePath = makeFakeClaudeBinary(sideDir);

  clearCliCache();

  const realSpawn = childProcess.spawn;
  const realSetTimeout = globalThis.setTimeout;

  const patched = (command: unknown, args: unknown, options: unknown): unknown => {
    // A loud failure beats a silently skipped assertion if the module ever stops
    // passing (command, args[], options) - e.g. switches to a shell string.
    if (typeof command !== 'string' || !Array.isArray(args) || typeof options !== 'object' || options === null) {
      throw new Error(`fake CLI: unexpected spawn signature: (${typeof command}, ${typeof args}, ${typeof options})`);
    }
    const argList = args as string[];
    calls.push({ command, args: [...argList], options: { ...(options as Record<string, unknown>) } });

    const forwarded = {
      ...(options as Record<string, unknown>),
      env: {
        ...process.env,
        FAKE_CLAUDE_CLI_PLAN: JSON.stringify(plan),
        FAKE_CLAUDE_CLI_ARGV_OUT: argvOut,
        FAKE_CLAUDE_CLI_STDIN_OUT: stdinOut,
      },
    };
    return (realSpawn as unknown as (...a: unknown[]) => unknown)(
      process.execPath,
      [FIXTURE_PATH, ...argList],
      forwarded,
    );
  };

  (childProcess as unknown as { spawn: unknown }).spawn = patched;

  if (opts.shortenTimeoutTo !== undefined) {
    const target = opts.timeoutDelay ?? 3 * 60 * 1000;
    const shortened = opts.shortenTimeoutTo;
    const wrapper = ((handler: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) =>
      realSetTimeout(handler, delay === target ? shortened : delay, ...rest)) as unknown as typeof globalThis.setTimeout;
    wrapper.__promisify__ = realSetTimeout.__promisify__;
    globalThis.setTimeout = wrapper;
  }

  return {
    calls,
    get call(): SpawnCall {
      if (calls.length !== 1) {
        throw new Error(`expected exactly one spawn call, saw ${calls.length}`);
      }
      return calls[0];
    },
    childArgv(): string[] {
      if (!fs.existsSync(argvOut)) {
        throw new Error('the fake CLI never ran (no argv dump was written)');
      }
      return JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
    },
    childStdin(): string {
      if (!fs.existsSync(stdinOut)) {
        throw new Error('the fake CLI never recorded its stdin');
      }
      return fs.readFileSync(stdinOut, 'utf8');
    },
    workspaceRoot,
    claudePath,
    restore(): void {
      (childProcess as unknown as { spawn: unknown }).spawn = realSpawn;
      globalThis.setTimeout = realSetTimeout;
      clearCliCache();
      removeTempDir(workspaceRoot);
      removeTempDir(sideDir);
    },
  };
}

/** Installs the fake CLI, runs `body`, and always restores the patches afterwards. */
export async function withFakeCli<T>(
  plan: CliPlan,
  body: (cli: FakeCli) => Promise<T>,
  opts: FakeCliOptions = {},
): Promise<T> {
  const cli = installFakeCli(plan, opts);
  try {
    return await body(cli);
  } finally {
    cli.restore();
  }
}

/**
 * Same idea for preflight(), which uses execFile rather than spawn. Kept separate
 * because killTree() also uses execFile (for taskkill on Windows) and patching it
 * during a spawn test would stop the module from being able to kill anything.
 */
export function installFakeExecFile(plan: CliPlan = {}): {
  calls: SpawnCall[];
  restore(): void;
} {
  const calls: SpawnCall[] = [];
  const realExecFile = childProcess.execFile;

  const patched = (command: unknown, args: unknown, options: unknown, callback: unknown): unknown => {
    if (typeof command !== 'string' || !Array.isArray(args)) {
      throw new Error('fake CLI: unexpected execFile signature');
    }
    const argList = args as string[];
    calls.push({ command, args: [...argList], options: { ...(options as Record<string, unknown>) } });
    const forwarded = {
      ...((options as Record<string, unknown>) ?? {}),
      env: { ...process.env, FAKE_CLAUDE_CLI_PLAN: JSON.stringify(plan) },
    };
    return (realExecFile as unknown as (...a: unknown[]) => unknown)(
      process.execPath,
      [FIXTURE_PATH, ...argList],
      forwarded,
      callback,
    );
  };

  (childProcess as unknown as { execFile: unknown }).execFile = patched;

  return {
    calls,
    restore(): void {
      (childProcess as unknown as { execFile: unknown }).execFile = realExecFile;
    },
  };
}

export const SAMPLE_STEPS = [
  {
    file: 'src/extension.ts',
    startLine: 1,
    endLine: 12,
    title: 'Activation entry point',
    explanation: 'Registers the commands and wires up the webview provider.',
    anchor: "import * as vscode from 'vscode';",
  },
  {
    file: 'src/tourController.ts',
    startLine: 40,
    endLine: 58,
    title: 'Resolving a step to a range',
    explanation: "Turns a step's file + line numbers into an editor selection.",
    anchor: '  private async revealStep(index: number) {',
  },
];

/** A realistic `claude -p --output-format json` success envelope. */
export function successEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 8421,
    num_turns: 5,
    session_id: '2f6b1c1e-0000-4000-8000-abcdefabcdef',
    total_cost_usd: 0.0421,
    result: 'The tour is below.',
    structured_output: {
      summary: 'Activation registers the command, which asks Claude and then drives the webview.',
      steps: SAMPLE_STEPS,
    },
    ...overrides,
  };
}
