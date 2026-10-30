import { describe, expect, it } from 'vitest';
import { contentDisposition, parseRange } from './attachmentHttp.js';

describe('contentDisposition', () => {
  it('gives an ASCII fallback and an RFC 5987 name', () => {
    const h = contentDisposition('attachment', "Shot é (1)'.png");
    expect(h).toContain('attachment; filename="Shot _ (1)\'.png"');
    expect(h).toContain("filename*=UTF-8''Shot%20%C3%A9%20%281%29%27.png");
  });
  it('cannot be broken out of by quotes or newlines', () => {
    const h = contentDisposition('inline', 'a"b\r\nc.txt');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain('filename="a_b c.txt"');
  });
});

describe('parseRange', () => {
  it('ignores missing or multi ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
  it('parses closed, open and suffix ranges', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  it('flags ranges outside the file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable');
  });
});
