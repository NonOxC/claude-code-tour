/**
 * Structural tests for TOUR_PLAN_JSON_SCHEMA in src/tourTypes.ts.
 *
 * This object is stringified and handed to `claude --json-schema`, so a typo in a
 * `required` array (or a property that never got a description) does not fail
 * loudly - it just silently weakens what the model is held to. These checks are a
 * small hand-rolled JSON Schema linter; no schema library is needed for a schema
 * this size.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { TOUR_PLAN_JSON_SCHEMA, TourPlan, TourStep } from '../tourTypes';

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  required?: unknown;
  items?: SchemaNode;
  description?: unknown;
  [keyword: string]: unknown;
}

const schema = TOUR_PLAN_JSON_SCHEMA as unknown as SchemaNode;

const VALID_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

/** Keywords this schema is allowed to use; anything else is probably a typo. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'description',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'enum',
  'additionalProperties',
  '$schema',
  'title',
]);

/**
 * Compile-time guards: if TourStep or TourPlan gains a field, these object
 * literals stop type-checking, which forces a look at the schema below.
 */
type ExhaustiveKeys<T> = { [K in keyof Required<T>]: true };
const TOUR_STEP_KEYS: ExhaustiveKeys<TourStep> = {
  file: true,
  startLine: true,
  endLine: true,
  title: true,
  explanation: true,
  anchor: true,
  snapshot: true,
};
/** Captured from disk by the extension, never requested from the model. */
const STEP_KEYS_FILLED_LOCALLY = ['snapshot'];
const TOUR_PLAN_KEYS: ExhaustiveKeys<TourPlan> = {
  question: true,
  summary: true,
  steps: true,
  // Reported by the CLI envelope rather than requested from the model, so these two
  // are deliberately absent from TOUR_PLAN_JSON_SCHEMA.
  costUsd: true,
  durationMs: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks the schema, returning a list of human-readable structural problems. */
function lintSchema(node: SchemaNode, pointer = '#'): string[] {
  const problems: string[] = [];

  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      problems.push(`${pointer}: unrecognised keyword "${keyword}"`);
    }
  }

  if (typeof node.type !== 'string') {
    problems.push(`${pointer}: missing a string "type"`);
  } else if (!VALID_TYPES.has(node.type)) {
    problems.push(`${pointer}: invalid type "${node.type}"`);
  }

  if (node.description !== undefined && (typeof node.description !== 'string' || node.description.trim() === '')) {
    problems.push(`${pointer}: description must be a non-empty string`);
  }

  if (node.type === 'object') {
    if (!isPlainObject(node.properties)) {
      problems.push(`${pointer}: object schema has no "properties" map`);
    } else {
      const declared = Object.keys(node.properties);
      if (declared.length === 0) {
        problems.push(`${pointer}: object schema declares no properties`);
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
          problems.push(`${pointer}: "required" must be an array of strings`);
        } else {
          const required = node.required as string[];
          const dupes = required.filter((r, i) => required.indexOf(r) !== i);
          if (dupes.length > 0) {
            problems.push(`${pointer}: duplicate entries in "required": ${dupes.join(', ')}`);
          }
          for (const name of required) {
            if (!declared.includes(name)) {
              problems.push(`${pointer}: "required" names "${name}", which is not in "properties" (typo?)`);
            }
          }
        }
      }
      for (const [name, child] of Object.entries(node.properties)) {
        if (!isPlainObject(child)) {
          problems.push(`${pointer}/properties/${name}: not a schema object`);
          continue;
        }
        problems.push(...lintSchema(child, `${pointer}/properties/${name}`));
      }
    }
  } else if (node.properties !== undefined) {
    problems.push(`${pointer}: "properties" on a non-object schema (type "${String(node.type)}")`);
  }

  if (node.type === 'array') {
    if (!isPlainObject(node.items)) {
      problems.push(`${pointer}: array schema has no "items" schema`);
    } else {
      problems.push(...lintSchema(node.items, `${pointer}/items`));
    }
  } else if (node.items !== undefined) {
    problems.push(`${pointer}: "items" on a non-array schema (type "${String(node.type)}")`);
  }

  if (node.type !== 'object' && node.required !== undefined) {
    problems.push(`${pointer}: "required" on a non-object schema`);
  }

  return problems;
}

function stepItems(): SchemaNode {
  const steps = schema.properties?.steps;
  assert.ok(steps, 'schema must declare a "steps" property');
  assert.ok(steps.items, '"steps" must declare an "items" schema');
  return steps.items;
}

describe('TOUR_PLAN_JSON_SCHEMA - structure', () => {
  it('is a structurally valid JSON Schema', () => {
    const problems = lintSchema(schema);
    assert.deepEqual(problems, [], `schema problems:\n  ${problems.join('\n  ')}`);
  });

  it('survives the JSON round-trip it is subjected to on the command line', () => {
    // runTour sends JSON.stringify(TOUR_PLAN_JSON_SCHEMA); anything non-JSON
    // (undefined, a function, NaN) would vanish or corrupt silently.
    const serialized = JSON.stringify(TOUR_PLAN_JSON_SCHEMA);
    assert.ok(serialized.length > 0);
    assert.deepEqual(JSON.parse(serialized), TOUR_PLAN_JSON_SCHEMA);
    assert.ok(!serialized.includes('undefined'));
    assert.ok(!serialized.includes('null'), 'no accidental nulls in the schema');
  });

  it('describes an object at the top level', () => {
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['steps', 'summary']);
  });
});

describe('TOUR_PLAN_JSON_SCHEMA - required matches properties', () => {
  it('requires every property it declares at the top level', () => {
    const declared = Object.keys(schema.properties ?? {}).sort();
    assert.deepEqual([...(schema.required as string[])].sort(), declared);
  });

  it('requires every property it declares on a step', () => {
    const items = stepItems();
    const declared = Object.keys(items.properties ?? {}).sort();
    assert.deepEqual([...(items.required as string[])].sort(), declared);
  });

  it('never names a required property that does not exist', () => {
    // The specific typo class this suite exists to catch.
    for (const [pointer, node] of [
      ['#', schema],
      ['#/properties/steps/items', stepItems()],
    ] as Array<[string, SchemaNode]>) {
      for (const name of node.required as string[]) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(node.properties ?? {}, name),
          `${pointer}: required "${name}" is not declared in properties`,
        );
      }
    }
  });
});

describe('TOUR_PLAN_JSON_SCHEMA - agreement with the TypeScript types', () => {
  it('declares exactly the model-supplied TourStep fields, and requires all of them', () => {
    const expected = Object.keys(TOUR_STEP_KEYS)
      .filter((k) => !STEP_KEYS_FILLED_LOCALLY.includes(k))
      .sort();
    const declared = Object.keys(stepItems().properties ?? {}).sort();
    assert.deepEqual(declared, expected);
    assert.deepEqual([...(stepItems().required as string[])].sort(), expected);
    for (const local of STEP_KEYS_FILLED_LOCALLY) {
      assert.ok(!declared.includes(local), `${local} is captured locally and must not be asked of the model`);
    }
  });

  it('declares every model-supplied TourPlan field, and none of the locally-filled ones', () => {
    // `question` is echoed back by runTour; `costUsd`/`durationMs` are read off the
    // CLI's own result envelope. Asking the model for any of them would be wrong.
    const LOCALLY_FILLED = ['question', 'costUsd', 'durationMs'];
    const expected = Object.keys(TOUR_PLAN_KEYS)
      .filter((k) => !LOCALLY_FILLED.includes(k))
      .sort();
    const declared = Object.keys(schema.properties ?? {}).sort();
    assert.deepEqual(declared, expected);
    for (const local of LOCALLY_FILLED) {
      assert.ok(!declared.includes(local), `${local} must not be requested from the model`);
    }
  });

  it('types the line numbers as integers and the text fields as strings', () => {
    const props = stepItems().properties ?? {};
    assert.equal(props.startLine.type, 'integer');
    assert.equal(props.endLine.type, 'integer');
    assert.equal(props.file.type, 'string');
    assert.equal(props.title.type, 'string');
    assert.equal(props.explanation.type, 'string');
    assert.equal(schema.properties?.summary.type, 'string');
    assert.equal(schema.properties?.steps.type, 'array');
  });

  it('gives every field a description, since the model only sees these', () => {
    const nodes: Array<[string, SchemaNode]> = [
      ...Object.entries(schema.properties ?? {}).map(([k, v]) => [`#/${k}`, v] as [string, SchemaNode]),
      ...Object.entries(stepItems().properties ?? {}).map(
        ([k, v]) => [`#/steps/items/${k}`, v] as [string, SchemaNode],
      ),
    ];
    for (const [pointer, node] of nodes) {
      assert.equal(typeof node.description, 'string', `${pointer} has no description`);
      assert.ok((node.description as string).trim().length > 10, `${pointer} has a uselessly short description`);
    }
  });

  it('asks for at least one step, matching runTour rejecting an empty steps array', () => {
    assert.equal(schema.properties?.steps.minItems, 1);
  });
});
