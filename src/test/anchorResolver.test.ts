import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchor } from '../anchorResolver';
import { TourStep } from '../tourTypes';

function step(extra: Partial<TourStep> = {}): TourStep {
  return {
    file: 'sample.ts',
    startLine: 1,
    endLine: 1,
    title: 't',
    explanation: 'e',
    ...extra,
  };
}

const FILE = [
  'import fs from "fs";', // 1
  '', // 2
  'function alpha() {', // 3
  '  return 1;', // 4
  '}', // 5
  '', // 6
  'function beta() {', // 7
  '  return 2;', // 8
  '}', // 9
];

describe('resolveAnchor - exact hits', () => {
  it('reports "exact" when the anchor sits on the predicted line', () => {
    const r = resolveAnchor(FILE, step({ anchor: 'function beta() {', startLine: 7, endLine: 9 }));
    assert.equal(r.resolution, 'exact');
    assert.equal(r.startLine, 6); // 0-based
    assert.equal(r.endLine, 8);
    assert.equal(r.note, undefined);
  });

  it('preserves the span length when relocating', () => {
    // Claimed 3 lines starting at 3; the anchor really lives at 7 (1-based).
    const r = resolveAnchor(FILE, step({ anchor: 'function beta() {', startLine: 3, endLine: 5 }));
    assert.equal(r.resolution, 'relocated');
    assert.equal(r.startLine, 6);
    assert.equal(r.endLine, 8, 'a 3-line span stays a 3-line span');
    assert.match(String(r.note), /re-located/);
  });
});

describe('resolveAnchor - drift tolerance', () => {
  it('finds an anchor that was re-indented', () => {
    const r = resolveAnchor(FILE, step({ anchor: '    return 2;', startLine: 8, endLine: 8 }));
    assert.ok(['exact', 'relocated'].includes(r.resolution));
    assert.equal(r.startLine, 7, 'matches "  return 2;" despite different indentation');
  });

  it('finds an anchor whose internal whitespace was reformatted', () => {
    const r = resolveAnchor(FILE, step({ anchor: 'function   beta()   {', startLine: 7, endLine: 7 }));
    assert.equal(r.startLine, 6);
  });

  it('reports "unresolved" and warns when the anchor is gone entirely', () => {
    const r = resolveAnchor(FILE, step({ anchor: 'function deleted() {', startLine: 3, endLine: 4 }));
    assert.equal(r.resolution, 'unresolved');
    // Falls back to the line hint, but must say so - silently showing the wrong
    // lines while confidently explaining them is the worst outcome here.
    assert.equal(r.startLine, 2);
    assert.match(String(r.note), /Could not find/);
    assert.match(String(r.note), /suspicion|best guess/);
  });

  it('reports "line-only" when no anchor was supplied at all', () => {
    const r = resolveAnchor(FILE, step({ startLine: 3, endLine: 5 }));
    assert.equal(r.resolution, 'line-only');
    assert.equal(r.startLine, 2);
    assert.equal(r.endLine, 4);
  });

  it('treats a whitespace-only anchor as no anchor', () => {
    const r = resolveAnchor(FILE, step({ anchor: '   ', startLine: 3, endLine: 3 }));
    assert.equal(r.resolution, 'line-only');
  });
});

describe('resolveAnchor - ambiguity', () => {
  const REPEATED = ['  return 1;', 'x', '  return 1;', 'y', '  return 1;'];

  it('picks the candidate closest to the line hint', () => {
    const r = resolveAnchor(REPEATED, step({ anchor: '  return 1;', startLine: 5, endLine: 5 }));
    assert.equal(r.startLine, 4, 'the third occurrence is nearest to the hint');
    assert.equal(r.resolution, 'exact');
  });

  it('still picks the nearest when the hint is between two occurrences', () => {
    const r = resolveAnchor(REPEATED, step({ anchor: '  return 1;', startLine: 4, endLine: 4 }));
    assert.equal(r.resolution, 'relocated');
    assert.ok([2, 4].includes(r.startLine));
  });

  it('prefers an exact match over a merely trimmed one', () => {
    const lines = ['    const x = 1;', 'const x = 1;'];
    const r = resolveAnchor(lines, step({ anchor: 'const x = 1;', startLine: 1, endLine: 1 }));
    assert.equal(r.startLine, 1, 'the byte-identical line wins even though it is further from the hint');
  });
});

describe('resolveAnchor - clamping', () => {
  it('clamps a start line past the end of the file', () => {
    const r = resolveAnchor(FILE, step({ startLine: 9999, endLine: 10000 }));
    assert.equal(r.startLine, FILE.length - 1);
    assert.equal(r.endLine, FILE.length - 1);
  });

  it('clamps a zero or negative start line', () => {
    const r = resolveAnchor(FILE, step({ startLine: -4, endLine: -1 }));
    assert.equal(r.startLine, 0);
    assert.ok(r.endLine >= r.startLine);
  });

  it('never returns an end before the start', () => {
    const r = resolveAnchor(FILE, step({ startLine: 6, endLine: 2 }));
    assert.ok(r.endLine >= r.startLine);
  });

  it('survives NaN line numbers', () => {
    const r = resolveAnchor(FILE, step({ startLine: NaN, endLine: NaN }));
    assert.ok(Number.isFinite(r.startLine));
    assert.ok(Number.isFinite(r.endLine));
    assert.ok(r.endLine >= r.startLine);
  });

  it('handles an empty file without throwing', () => {
    const r = resolveAnchor([], step({ anchor: 'anything', startLine: 5, endLine: 9 }));
    assert.equal(r.startLine, 0);
    assert.equal(r.endLine, 0);
  });
});
