import {describe, expect, it} from 'vitest';
import {parseJsonIterative, parseSample, stringifyIterative, JsonParseError} from '../src/server/json-parse';

describe('iterative JSON parser', () => {
  it('parses ordinary values identically to JSON.parse', () => {
    const cases = [
      '0', '-1.5e3', 'true', 'false', 'null', '"hello\\n世界"',
      '[]', '{}', '[1, 2, 3]', '{"a": 1, "b": [true, null, {"c": "x"}]}',
    ];
    for (const text of cases) {
      expect(parseJsonIterative(text)).toEqual(JSON.parse(text));
    }
  });

  it('handles deep nesting without a call stack blowup', () => {
    const depth = 8000;
    const text = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const value = parseSample(text) as Record<string, unknown>;
    let cursor: unknown = value;
    let levels = 0;
    while (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>).a;
      levels++;
    }
    expect(levels).toBe(depth);
    expect(cursor).toBe(1);
  });

  it('rejects malformed input with position info', () => {
    const bad = ['', '{', '[', '{"a":}', '{"a" 1}', '[1,]', '{"a":1},', 'tru', '{"a":01}', '[1 2]'];
    for (const text of bad) {
      expect(() => parseJsonIterative(text), `should reject ${JSON.stringify(text)}`).toThrow(JsonParseError);
    }
  });

  it('falls back from the native parser only on stack overflow', () => {
    expect(() => parseSample('{"a":}')).toThrow(SyntaxError);
    expect(() => parseSample('{"a":}')).not.toThrow(JsonParseError);
  });

  it('serializes deep objects without a call stack blowup', () => {
    const depth = 8000;
    const root: Record<string, unknown> = {a: 1};
    let cursor = root;
    for (let i = 0; i < depth; i++) {
      cursor.a = {a: 1};
      cursor = cursor.a as Record<string, unknown>;
    }
    const text = stringifyIterative(root);
    expect((text.match(/{"a":/g) ?? []).length).toBe(depth + 1);
    const reparsed = parseSample(text) as Record<string, unknown>;
    let levels = 0;
    let c: unknown = reparsed;
    while (c && typeof c === 'object') {
      c = (c as Record<string, unknown>).a;
      levels++;
    }
    expect(levels).toBe(depth + 1);
  });
});
