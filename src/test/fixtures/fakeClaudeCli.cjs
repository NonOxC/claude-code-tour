#!/usr/bin/env node
/**
 * Fake Claude Code CLI used by the unit tests.
 *
 * This is a real, separate process. It is told what to do through the
 * FAKE_CLAUDE_CLI_PLAN environment variable (JSON):
 *
 *   stdout    string  - raw text to write to stdout (overrides `envelope`)
 *   envelope  object  - object to JSON.stringify to stdout; the process's own
 *                       argv is merged in as an `argv` field so tests can prove
 *                       exactly what the CLI was invoked with
 *   stderr    string  - raw text to write to stderr
 *   exitCode  number  - process exit code (default 0)
 *   delayMs   number  - wait this long before writing anything
 *   hangMs    number  - stay alive this long after writing (used to exercise the
 *                       parent's timeout / SIGTERM path)
 *
 * It also writes its own `process.argv.slice(2)` to the file named by
 * FAKE_CLAUDE_CLI_ARGV_OUT, which is how the tests assert on the argument
 * vector the child really received (as opposed to what the parent intended),
 * and everything it reads from stdin to FAKE_CLAUDE_CLI_STDIN_OUT. The prompt
 * travels over stdin rather than argv, so recording it is what lets the tests
 * prove the question never reaches the command line.
 */
'use strict';

const fs = require('fs');

let plan = {};
if (process.env.FAKE_CLAUDE_CLI_PLAN) {
  plan = JSON.parse(process.env.FAKE_CLAUDE_CLI_PLAN);
}

const receivedArgv = process.argv.slice(2);

if (process.env.FAKE_CLAUDE_CLI_ARGV_OUT) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_CLI_ARGV_OUT, JSON.stringify(receivedArgv), 'utf8');
}

// Drain stdin and record it. Written incrementally so a test that kills us
// mid-run still sees whatever arrived, and so an empty stdin still produces the
// file (its absence would otherwise be indistinguishable from "never ran").
const stdinOut = process.env.FAKE_CLAUDE_CLI_STDIN_OUT;
if (stdinOut) {
  let received = '';
  fs.writeFileSync(stdinOut, '', 'utf8');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    received += chunk;
    try {
      fs.writeFileSync(stdinOut, received, 'utf8');
    } catch {
      /* best effort */
    }
  });
  process.stdin.on('error', () => {
    /* the parent may close the pipe first */
  });
}

function stdoutPayload() {
  if (typeof plan.stdout === 'string') {
    return plan.stdout;
  }
  if (plan.envelope === undefined) {
    return '';
  }
  if (plan.envelope !== null && typeof plan.envelope === 'object' && !Array.isArray(plan.envelope)) {
    return JSON.stringify(Object.assign({}, plan.envelope, { argv: receivedArgv }));
  }
  return JSON.stringify(plan.envelope);
}

function emit() {
  const out = stdoutPayload();
  if (out.length > 0) {
    process.stdout.write(out);
  }
  if (typeof plan.stderr === 'string' && plan.stderr.length > 0) {
    process.stderr.write(plan.stderr);
  }
  const code = typeof plan.exitCode === 'number' ? plan.exitCode : 0;
  if (typeof plan.hangMs === 'number' && plan.hangMs > 0) {
    // Deliberately keep the event loop alive so the parent has to kill us.
    setTimeout(() => {
      process.exitCode = code;
    }, plan.hangMs);
    return;
  }
  process.exitCode = code;
}

if (typeof plan.delayMs === 'number' && plan.delayMs > 0) {
  setTimeout(emit, plan.delayMs);
} else {
  emit();
}
