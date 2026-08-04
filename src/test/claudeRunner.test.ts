/**
 * Unit tests for runTour() in src/claudeRunner.ts.
 *
 * claudeRunner.ts does not import `vscode`, so it runs under plain Node. Every
 * test here spawns a REAL child process (the fake CLI in
 * src/test/fixtures/fakeClaudeCli.cjs) through the REAL child_process.execFile,
 * so exit codes, SIGTERM kills, stdout truncation and ENOENT come from Node
 * rather than from a hand-rolled stub. See src/test/helpers/fakeCli.ts for why
 * the launcher (not the path) is what gets swapped.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runTour, RunTourOptions, resolveClaudeCli, clearCliCache, CliNotFoundError } from '../claudeRunner';
import { TOUR_PLAN_JSON_SCHEMA } from '../tourTypes';
import {
  FakeCli,
  SAMPLE_STEPS,
  installFakeCli,
  makeTempDir,
  removeTempDir,
  successEnvelope,
  withFakeCli,
} from './helpers/fakeCli';

const QUESTION = 'How does the tour panel talk to the extension host?';

function options(cli: FakeCli, extra: Partial<RunTourOptions> = {}): RunTourOptions {
  // An absolute path, not a bare name: resolveClaudeCli() PATH-searches bare names
  // and would (correctly) refuse to find a fixture that isn't on PATH.
  return { claudePath: cli.claudePath, workspaceRoot: cli.workspaceRoot, ...extra };
}

async function captureError(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the promise to reject, but it resolved' });
}

/** Value of a flag that must appear exactly once in argv. */
function flagValue(args: string[], flag: string): string {
  const hits = args.reduce<number[]>((acc, a, i) => (a === flag ? [...acc, i] : acc), []);
  assert.equal(hits.length, 1, `expected exactly one ${flag} in argv, saw ${hits.length}: ${JSON.stringify(args)}`);
  const value = args[hits[0] + 1];
  assert.equal(typeof value, 'string', `${flag} had no value`);
  return value;
}

describe('runTour - envelope handling', () => {
  it('maps a successful envelope onto a TourPlan', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      const plan = await runTour(QUESTION, options(cli));

      assert.equal(plan.question, QUESTION, 'question is echoed back from the caller, not from Claude');
      assert.equal(
        plan.summary,
        'Activation registers the command, which asks Claude and then drives the webview.',
      );
      assert.deepEqual(plan.steps, SAMPLE_STEPS);
      assert.equal(plan.steps.length, 2);
      assert.equal(plan.steps[0].file, 'src/extension.ts');
      assert.equal(plan.steps[0].startLine, 1);
      assert.equal(plan.steps[0].endLine, 12);
      // costUsd/durationMs are lifted off the CLI envelope, not asked of the model.
      assert.deepEqual(Object.keys(plan).sort(), ['costUsd', 'durationMs', 'question', 'steps', 'summary']);
    });
  });

  it('defaults a missing summary to an empty string rather than throwing', async () => {
    const envelope = successEnvelope({ structured_output: { steps: SAMPLE_STEPS } });
    await withFakeCli({ envelope }, async (cli) => {
      const plan = await runTour(QUESTION, options(cli));
      assert.equal(plan.summary, '');
      assert.equal(plan.steps.length, 2);
    });
  });

  it('throws with Claude\'s reported error when is_error is true', async () => {
    const envelope = successEnvelope({
      is_error: true,
      subtype: 'error_during_execution',
      result: 'Credit balance is too low to continue.',
      structured_output: undefined,
    });
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /^Claude reported an error: /);
      assert.ok(
        err.message.includes('Credit balance is too low to continue.'),
        `error should surface Claude's own text, got: ${err.message}`,
      );
    });
  });

  it('reports an is_error envelope even when it still carries structured output', async () => {
    const envelope = successEnvelope({ is_error: true, result: 'Tool use was denied.' });
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.ok(err.message.includes('Tool use was denied.'));
    });
  });

  it('falls back to stderr for the error text when is_error has no result', async () => {
    const envelope = { type: 'result', is_error: true };
    await withFakeCli({ envelope, stderr: 'claude: session aborted' }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.ok(err.message.includes('claude: session aborted'), err.message);
    });
  });

  it('produces an empty-detail message when is_error has neither result nor stderr (?? vs || quirk)', async () => {
    // Documented, not endorsed: `parsed.result ?? stderr ?? 'unknown error'` can
    // never reach 'unknown error', because stderr is always a string ('' is not
    // nullish). See the findings note in the task report.
    await withFakeCli({ envelope: { type: 'result', is_error: true } }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.equal(err.message, 'Claude reported an error: ');
    });
  });

  it('throws "did not return a usable tour" when structured_output is missing', async () => {
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I could not find anything relevant in this workspace.',
    };
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /^Claude did not return a usable tour\./);
      assert.ok(err.message.includes('I could not find anything relevant in this workspace.'));
    });
  });

  it('throws "did not return a usable tour" when steps is an empty array', async () => {
    const envelope = successEnvelope({
      structured_output: { summary: 'Nothing to show.', steps: [] },
      result: 'no steps',
    });
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /did not return a usable tour/);
    });
  });

  it('throws "did not return a usable tour" when steps is not an array', async () => {
    const envelope = successEnvelope({
      structured_output: { summary: 'Nothing to show.', steps: { '0': SAMPLE_STEPS[0] } },
    });
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /did not return a usable tour/);
    });
  });

  it('mentions the missing result field when there is nothing to quote', async () => {
    await withFakeCli({ envelope: { type: 'result', is_error: false } }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.equal(err.message, 'Claude did not return a usable tour. Raw result: (no result field)');
    });
  });

  it('drops malformed steps rather than letting them reach the editor', async () => {
    // The CLI's output is untrusted even though a JSON Schema was sent: a step with
    // a non-string file or nonsense line numbers must never reach tourController,
    // where it would throw from inside a navigation handler.
    const junk = [{ file: 42, startLine: '3', endLine: null, title: undefined }] as unknown;
    const envelope = successEnvelope({ structured_output: { summary: 's', steps: junk } });
    await withFakeCli({ envelope }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /did not return a usable tour/);
    });
  });

  it('keeps the valid steps when only some are malformed', async () => {
    const mixed = [
      { file: 'a.ts', startLine: 1, endLine: 2, title: 't', explanation: 'e' },
      { file: 42, startLine: 'x', endLine: null },
      { file: 'b.ts', startLine: 5, endLine: 9, title: 't2', explanation: 'e2' },
    ] as unknown;
    const envelope = successEnvelope({ structured_output: { summary: 's', steps: mixed } });
    await withFakeCli({ envelope }, async (cli) => {
      const plan = await runTour(QUESTION, options(cli));
      assert.equal(plan.steps.length, 2);
      assert.deepEqual(
        plan.steps.map((s) => s.file),
        ['a.ts', 'b.ts'],
      );
    });
  });

  it('clamps nonsensical line numbers instead of trusting them', async () => {
    const steps = [
      // startLine below 1, and an endLine before the start.
      { file: 'a.ts', startLine: -5, endLine: -20, title: 't', explanation: 'e' },
    ] as unknown;
    const envelope = successEnvelope({ structured_output: { summary: 's', steps } });
    await withFakeCli({ envelope }, async (cli) => {
      const plan = await runTour(QUESTION, options(cli));
      assert.equal(plan.steps[0].startLine, 1, 'startLine is clamped to the first line');
      assert.ok(plan.steps[0].endLine >= plan.steps[0].startLine, 'endLine never precedes startLine');
    });
  });
});

describe('runTour - malformed and non-JSON output', () => {
  it('throws "did not return valid JSON" and echoes the raw output', async () => {
    const raw = 'Error: unknown flag --json-schema\nUsage: claude [options]';
    await withFakeCli({ stdout: raw }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /^Claude Code CLI did not return valid JSON\. Raw output: /);
      assert.ok(err.message.includes('unknown flag --json-schema'), err.message);
    });
  });

  it('truncates very long raw output at 800 characters', async () => {
    const raw = `${'A'.repeat(900)}TAIL-MARKER`;
    await withFakeCli({ stdout: raw }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.ok(err.message.includes('A'.repeat(800)), 'should include the first 800 chars');
      assert.ok(!err.message.includes('A'.repeat(801)), 'should not include more than 800 chars');
      assert.ok(!err.message.includes('TAIL-MARKER'), 'tail must be dropped');
      assert.ok(err.message.includes('…'), 'should be marked as truncated with an ellipsis');
    });
  });

  it('rejects valid JSON followed by trailing chatter', async () => {
    const raw = `${JSON.stringify(successEnvelope())}\nwarning: something happened`;
    await withFakeCli({ stdout: raw }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /did not return valid JSON/);
    });
  });

  it('reports no-output separately from bad-output, and surfaces stderr as the detail', async () => {
    // Exit 0 with nothing on stdout is a distinct failure from unparseable stdout,
    // and stderr is the only clue the user has about why.
    await withFakeCli({ stdout: '', stderr: 'deprecation notice' }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /produced no output/);
      assert.ok(err.message.includes('deprecation notice'), err.message);
    });
  });

  it('still reports no-output when neither stdout nor stderr has anything', async () => {
    await withFakeCli({ stdout: '' }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /produced no output/);
    });
  });
});

describe('runTour - process failures', () => {
  it('parses a full JSON envelope even when the CLI exits non-zero', async () => {
    // execFile rejects on any non-zero exit; the documented fallback re-reads
    // err.stdout. This is the subtle branch - assert it really resolves.
    await withFakeCli({ envelope: successEnvelope(), exitCode: 3, stderr: 'note: exited 3' }, async (cli) => {
      const plan = await runTour(QUESTION, options(cli));
      assert.equal(plan.steps.length, 2);
      assert.equal(plan.question, QUESTION);
    });
  });

  it('still reports is_error from a non-zero exit envelope', async () => {
    const envelope = { type: 'result', is_error: true, result: 'Rate limit exceeded.' };
    await withFakeCli({ envelope, exitCode: 1 }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.ok(err.message.includes('Rate limit exceeded.'));
    });
  });

  it('reports the exit code and stderr on a non-zero exit with empty stdout', async () => {
    await withFakeCli({ stdout: '', stderr: 'Invalid API key. Run `claude login`.', exitCode: 7 }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /exited with code 7/);
      // The actionable part - how to fix it - must survive into the message.
      assert.ok(err.message.includes('Invalid API key.'), err.message);
    });
  });

  it('treats whitespace-only stdout as no stdout', async () => {
    await withFakeCli({ stdout: '   \n\t  ', stderr: 'boom', exitCode: 2 }, async (cli) => {
      const err = await captureError(runTour(QUESTION, options(cli)));
      assert.match(err.message, /exited with code 2/);
      assert.ok(err.message.includes('boom'), err.message);
    });
  });

  it('names the bad path and the setting when the configured executable does not exist', async () => {
    // Caught during resolution rather than by waiting for a spawn ENOENT, so the
    // user gets told which path was wrong before a process is ever launched.
    const workspaceRoot = makeTempDir();
    const missing = path.join(workspaceRoot, 'nope', 'definitely-not-claude');
    try {
      clearCliCache();
      const err = await captureError(runTour(QUESTION, { claudePath: missing, workspaceRoot }));
      assert.ok(err instanceof CliNotFoundError, `expected CliNotFoundError, got ${err.constructor.name}`);
      assert.ok(err.message.includes(missing), 'message should name the path that failed');
      assert.ok(
        err.message.includes('claudeCodeTour.claudePath'),
        'message should point at the setting the user can fix',
      );
    } finally {
      clearCliCache();
      removeTempDir(workspaceRoot);
    }
  });

  it('reports a timeout when the CLI is killed', async () => {
    // timeoutMs is injectable precisely so this branch is reachable in a fast test.
    // The kill itself is real: the fake CLI sits on a timer until it is terminated.
    await withFakeCli({ hangMs: 10_000 }, async (cli) => {
      const err = await captureError(runTour(QUESTION, { ...options(cli), timeoutMs: 700 }));
      assert.match(err.message, /^Claude Code took too long to respond/);
    });
  });

  it('discards a complete, valid envelope if the process is killed after writing it', async () => {
    // The timeout check deliberately runs before the stdout fallback: output from a
    // run we had to kill is not trustworthy enough to present as a finished tour.
    await withFakeCli({ envelope: successEnvelope(), hangMs: 10_000 }, async (cli) => {
      const err = await captureError(runTour(QUESTION, { ...options(cli), timeoutMs: 700 }));
      assert.match(err.message, /took too long to respond/);
    });
  });

  it('reports an output overflow in terms the user can act on', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      const err = await captureError(runTour(QUESTION, { ...options(cli), maxBufferBytes: 24 }));
      assert.match(err.message, /more data than expected/);
      assert.ok(/narrower question/.test(err.message), `should suggest a fix, got: ${err.message}`);
    });
  });

  it('unwraps a Windows .cmd shim to the real executable instead of failing', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only behaviour');
      return;
    }
    // The npm-installed shape on Windows is claude.cmd next to
    // node_modules/@anthropic-ai/claude-code/bin/claude.exe. Node cannot spawn the
    // .cmd without a shell, so the resolver must find the .exe sibling itself.
    const dir = makeTempDir();
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n', 'utf8');
    const binDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, 'claude.exe');
    fs.writeFileSync(exe, 'fake', 'utf8');
    try {
      clearCliCache();
      const resolved = resolveClaudeCli(shim);
      assert.equal(resolved.command, exe, 'the .cmd shim must resolve to its .exe sibling');
      assert.deepEqual(resolved.prefixArgs, [], 'no cmd.exe indirection when the .exe is found');
    } finally {
      clearCliCache();
      removeTempDir(dir);
    }
  });

  it('falls back to cmd.exe only when no .exe sibling exists', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only behaviour');
      return;
    }
    const dir = makeTempDir();
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n', 'utf8');
    try {
      clearCliCache();
      const resolved = resolveClaudeCli(shim);
      assert.ok(/cmd\.exe$/i.test(resolved.command), `expected a cmd.exe fallback, got ${resolved.command}`);
      assert.deepEqual(resolved.prefixArgs, ['/d', '/s', '/c', shim]);
    } finally {
      clearCliCache();
      removeTempDir(dir);
    }
  });

  it('rejects a configured path that does not exist, pointing at the setting', async () => {
    const dir = makeTempDir();
    try {
      clearCliCache();
      const err = await captureError(
        runTour(QUESTION, { claudePath: path.join(dir, 'no-such-claude'), workspaceRoot: dir }),
      );
      assert.ok(err instanceof CliNotFoundError, `expected CliNotFoundError, got ${err.constructor.name}`);
      assert.ok(err.message.includes('claudeCodeTour.claudePath'), 'must name the setting the user can fix');
    } finally {
      clearCliCache();
      removeTempDir(dir);
    }
  });
});

describe('runTour - CLI argument construction', () => {
  // -p, plus five flag/value pairs. The prompt is NOT here: it goes over stdin.
  const BASE_FLAG_COUNT = 11;

  it('always passes the read-only tool restriction, output format and schema', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      const { args, command } = cli.call;

      assert.equal(command, cli.claudePath, 'the resolved executable is spawned directly');
      assert.equal(args[0], '-p');

      // Security-relevant: the tool allowlist must never silently drop or widen.
      assert.equal(flagValue(args, '--tools'), 'Read,Grep,Glob');
      assert.deepEqual(flagValue(args, '--tools').split(','), ['Read', 'Grep', 'Glob']);
      assert.equal(flagValue(args, '--output-format'), 'json');
      assert.equal(flagValue(args, '--json-schema'), JSON.stringify(TOUR_PLAN_JSON_SCHEMA));
      assert.equal(flagValue(args, '--add-dir'), cli.workspaceRoot);
      assert.equal(args.length, BASE_FLAG_COUNT, `unexpected extra argv entries: ${JSON.stringify(args)}`);
    });
  });

  it('uses dontAsk, never bypassPermissions', async () => {
    // Not cosmetic. Measured: under bypassPermissions the CLI will read and quote
    // back files far outside the workspace (confirmed against a real ~/.claude.json),
    // turning prompt injection in any workspace file into credential exfiltration.
    // dontAsk still permits workspace reads and denies the rest.
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      const { args } = cli.call;
      assert.equal(flagValue(args, '--permission-mode'), 'dontAsk');
      assert.ok(!args.includes('bypassPermissions'), 'bypassPermissions must never be passed');
    });
  });

  it('never passes a write-capable tool name in any argv entry', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      const { args } = cli.call;
      for (const forbidden of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'WebFetch', 'default']) {
        for (const arg of args) {
          assert.ok(
            !arg.split(/[,\s]/).includes(forbidden),
            `argv entry "${arg}" must not grant ${forbidden}`,
          );
        }
      }
      assert.ok(args.includes('--tools'), 'the tool restriction flag itself must be present');
    });
  });

  it('includes --max-budget-usd only when a cost cap is configured', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      assert.ok(!cli.call.args.includes('--max-budget-usd'));
    });
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, { ...options(cli), maxCostUsd: 1.5 });
      assert.equal(flagValue(cli.call.args, '--max-budget-usd'), '1.5');
    });
  });

  it('includes --model when a model is configured', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli, { model: 'opus' }));
      const { args } = cli.call;
      assert.equal(flagValue(args, '--model'), 'opus');
      assert.equal(args.length, BASE_FLAG_COUNT + 2);
      // --model is appended last, after the variadic --tools value, so it cannot
      // be swallowed by it.
      assert.equal(args[args.length - 2], '--model');
      assert.ok(args.indexOf('--model') > args.indexOf('--tools') + 1);
    });
  });

  it('omits --model when it is undefined', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      assert.ok(!cli.call.args.includes('--model'));
      assert.equal(cli.call.args.length, BASE_FLAG_COUNT);
    });
  });

  it('omits --model when it is the empty-string default from settings', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli, { model: '' }));
      assert.ok(!cli.call.args.includes('--model'), 'an empty model setting must not produce `--model ""`');
      assert.equal(cli.call.args.length, BASE_FLAG_COUNT);
    });
  });

  it('runs the CLI in the workspace root, detached only where a process group is killable', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli));
      assert.equal(cli.call.options.cwd, cli.workspaceRoot);
      // POSIX kills the whole process group via kill(-pid), which only works if the
      // child leads its own group; Windows uses taskkill /T instead.
      assert.equal(cli.call.options.detached, process.platform !== 'win32');
      assert.equal(cli.call.options.windowsHide, true);
    });
  });

  it('the child process receives exactly the argv runTour built', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      await runTour(QUESTION, options(cli, { model: 'sonnet' }));
      assert.deepEqual(cli.childArgv(), cli.call.args);
    });
  });
});

describe('runTour - no shell is involved', () => {
  const NASTY = [
    '"; rm -rf /; echo "',
    '`touch backticked`',
    '$(touch substituted)',
    '&& touch andand',
    '| touch piped',
    '> redirected.txt',
    '%PATH%',
    "'; DROP TABLE steps; --",
  ].join(' ');

  it('keeps a question full of shell metacharacters off argv entirely, delivering it on stdin', async () => {
    await withFakeCli({ envelope: successEnvelope() }, async (cli) => {
      const plan = await runTour(NASTY, options(cli));
      assert.equal(plan.question, NASTY);

      // The strongest available property: user-controlled text is not on the command
      // line at all, so there is nothing for a shell (or cmd.exe) to reinterpret.
      const childArgv = cli.childArgv();
      assert.equal(
        childArgv.filter((a) => a.includes(NASTY)).length,
        0,
        `the question must never reach argv: ${JSON.stringify(childArgv)}`,
      );
      assert.deepEqual(childArgv, cli.call.args);

      // It must still arrive intact on stdin, unescaped and unsplit.
      const stdin = cli.childStdin();
      assert.ok(stdin.includes(`Question: ${NASTY}`), 'the question must reach the CLI verbatim over stdin');

      // No shell option is ever handed to spawn.
      assert.equal(cli.call.options.shell, undefined);
      assert.ok(!('shell' in cli.call.options));

      // Nothing the injected commands would have created exists.
      assert.deepEqual(fs.readdirSync(cli.workspaceRoot), []);
    });
  });

  it('cannot be made to execute an injected command even when the CLI path is bogus (real execFile)', async () => {
    // With `shell: true` this argument would run `touch`/`echo` even though the
    // command itself fails. With execFile's argv array it cannot.
    const workspaceRoot = makeTempDir();
    const sentinel = path.join(workspaceRoot, 'pwned.txt');
    const injected = [
      `; echo pwned > "${sentinel}"`,
      `& echo pwned > "${sentinel}"`,
      `&& echo pwned > "${sentinel}"`,
      `| echo pwned > "${sentinel}"`,
      `$(echo pwned > "${sentinel}")`,
      `\`echo pwned > "${sentinel}"\``,
    ].join(' ');
    try {
      const err = await captureError(
        runTour(injected, { claudePath: path.join(workspaceRoot, 'no-such-claude'), workspaceRoot }),
      );
      assert.ok(err instanceof CliNotFoundError, `expected CliNotFoundError, got ${err.constructor.name}`);
      assert.equal(fs.existsSync(sentinel), false, 'a shell ran the injected command - this is a security failure');
      assert.deepEqual(fs.readdirSync(workspaceRoot), [], 'the workspace must be untouched');
    } finally {
      removeTempDir(workspaceRoot);
    }
  });
});

describe('test harness self-check', () => {
  it('restores child_process.spawn after use', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const childProcess = require('node:child_process') as { spawn: unknown };
    const original = childProcess.spawn;
    const cli = installFakeCli({ envelope: successEnvelope() });
    assert.notEqual(childProcess.spawn, original, 'the fake CLI must actually be installed');
    cli.restore();
    assert.equal(childProcess.spawn, original);
  });
});
