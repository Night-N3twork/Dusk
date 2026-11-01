import { test, expect } from 'vitest';
import { bytesAsArrays, decodeFrame, encodeFrame, toCloneable } from '../src/protocol/frame';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('frames without bytes stay plain JSON', () => {
  const target = new Uint8Array(1024);
  const size = encodeFrame({ value: 'hi', n: [1, 2] }, encoder, target);
  expect(decoder.decode(target.subarray(0, size))).toBe('{"value":"hi","n":[1,2]}');
  expect(decodeFrame(target, size, decoder)).toEqual({ value: 'hi', n: [1, 2] });
});

test('frames carry nested Uint8Array payloads as raw bytes', () => {
  const target = new Uint8Array(4096);
  const payload = new Uint8Array(1000).map((_, i) => i & 0xff);
  const size = encodeFrame({ value: { bytes: payload, bytesRead: 1000, extra: [payload.subarray(10, 13)] } }, encoder, target);
  expect(size).toBeLessThan(1100);
  const decoded = decodeFrame(target, size, decoder) as { value: { bytes: Uint8Array; bytesRead: number; extra: Uint8Array[] } };
  expect(decoded.value.bytes).toBeInstanceOf(Uint8Array);
  expect(Array.from(decoded.value.bytes)).toEqual(Array.from(payload));
  expect(Array.from(decoded.value.extra[0]!)).toEqual([10, 11, 12]);
  expect(decoded.value.bytesRead).toBe(1000);
});

test('frames reject payloads larger than the shared buffer', () => {
  expect(() => encodeFrame({ value: new Uint8Array(64) }, encoder, new Uint8Array(32))).toThrow(RangeError);
});

test('legacy JSON keeps byte payloads as number arrays', () => {
  expect(JSON.stringify({ data: new Uint8Array([1, 2, 3]) }, bytesAsArrays)).toBe('{"data":[1,2,3]}');
});

test('toCloneable mirrors JSON semantics while keeping bytes', () => {
  const bytes = new Uint8Array([9]);
  const value = toCloneable({ a: undefined, b: () => 1, c: NaN, d: new Date(0), e: [undefined, bytes], f: { toJSON: () => 'j' } });
  expect(value).toEqual({ c: null, d: '1970-01-01T00:00:00.000Z', e: [null, bytes], f: 'j' });
  expect((value as { e: unknown[] }).e[1]).toBe(bytes);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  expect(() => toCloneable(cyclic)).toThrow(TypeError);
});
