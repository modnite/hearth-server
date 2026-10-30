import { describe, expect, it } from 'vitest';
import { DownMixer, mulawDecode, mulawEncode, mulawEncodeSample } from './legacyAudio.js';

describe('G.711 mu-law', () => {
  it('matches the reference values of the standard', () => {
    expect(mulawEncodeSample(0)).toBe(0xff);
    expect(mulawEncodeSample(32767)).toBe(0x80);
    expect(mulawEncodeSample(-32768)).toBe(0x00);
    expect(mulawEncodeSample(-1)).toBe(0x7f);
    expect(mulawDecode(Uint8Array.from([0xff, 0x80, 0x00]))).toEqual(Int16Array.from([0, 32124, -32124]));
  });

  it('round-trips a tone with a high signal-to-noise ratio', () => {
    const n = 1600;
    const x = new Int16Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.round(12000 * Math.sin((2 * Math.PI * 600 * i) / 16000));
    const y = mulawDecode(mulawEncode(x));
    let sig = 0;
    let err = 0;
    for (let i = 0; i < n; i++) {
      sig += x[i]! * x[i]!;
      err += (x[i]! - y[i]!) ** 2;
    }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(30);
  });
});

describe('DownMixer', () => {
  const ones = (n: number, v = 1000) => new Int16Array(n).fill(v);

  it('returns null until someone has audio', () => {
    expect(new DownMixer().next()).toBeNull();
  });

  it('waits for 40 ms to be buffered before a source starts', () => {
    const m = new DownMixer();
    m.push('a', ones(320));
    expect(m.next()).toBeNull(); // 20 ms is not enough yet
    m.push('a', ones(320));
    expect(m.next()).not.toBeNull();
  });

  it('adds the sources and takes 20 ms from each per tick', () => {
    const m = new DownMixer(320, 3840, 1600, 320);
    m.push('a', ones(640, 1000));
    m.push('b', ones(320, 500));
    const f1 = m.next()!;
    expect(f1.length).toBe(320);
    expect(f1[0]).toBe(1500);
    const f2 = m.next()!; // b has run dry: a alone
    expect(f2[0]).toBe(1000);
    expect(m.next()).toBeNull();
  });

  it('clips instead of wrapping', () => {
    const m = new DownMixer(320, 3840, 1600, 320);
    m.push('a', ones(320, 30000));
    m.push('b', ones(320, 30000));
    expect(m.next()![0]).toBe(32767);
  });

  it('never emits a half frame: a partial chunk stays queued until the rest arrives', () => {
    const m = new DownMixer(320, 3840, 1600, 320);
    m.push('a', Int16Array.from({ length: 480 }, (_, i) => i));
    expect(m.next()![319]).toBe(319);
    expect(m.next()).toBeNull(); // 160 left: wait, no padding with silence
    m.push('a', Int16Array.from({ length: 480 }, (_, i) => 480 + i));
    m.push('a', ones(320)); // the source re-buffers to its prime level first
    const f = m.next()!;
    expect(f[0]).toBe(320);
    expect(f[159]).toBe(479);
    expect(f[160]).toBe(480);
  });

  it('trims a source that has got far ahead so the delay cannot grow', () => {
    const m = new DownMixer();
    for (let i = 0; i < 40; i++) m.push('a', ones(320)); // 800 ms
    let frames = 0;
    while (m.next()) frames++;
    expect(frames).toBeLessThanOrEqual(12); // about 240 ms at most
  });

  it('forgets a source that left', () => {
    const m = new DownMixer();
    m.push('a', ones(640));
    m.remove('a');
    expect(m.next()).toBeNull();
    expect(m.sources).toBe(0);
  });
});
