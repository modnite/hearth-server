/**
 * Audio for the legacy (Windows XP and 7) call path: the G.711 mu-law the old client speaks, and the mixer that turns
 * everyone else in the call into the one mono stream it plays. Pure functions and a small class, no LiveKit in here,
 * so they are tested on their own.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** ITU-T G.711 mu-law, the same algorithm as client-win\legacy\LegacyProtocol.cs (MuLaw). */
export function mulawEncodeSample(pcm: number): number {
  let sample = pcm;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 7;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  DECODE[i] = sign !== 0 ? -sample : sample;
}

export function mulawDecode(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = DECODE[data[i]!]!;
  return out;
}

export function mulawEncode(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]!);
  return out;
}

/**
 * Mixes the audio of everyone else into 20 ms frames for the old client. Each source (a participant) has its own queue and
 * a small jitter buffer: a source starts contributing once `prime` samples are queued (40 ms), always contributes whole
 * frames, and when it runs dry it goes quiet and re-buffers instead of padding a half frame with silence (that is a click).
 * A source that has got far ahead (a stalled tick, a burst) is trimmed back so the delay cannot grow.
 */
export class DownMixer {
  private queues = new Map<string, { chunks: Int16Array[]; offset: number; samples: number; primed: boolean }>();

  constructor(
    private readonly frame = 320,
    private readonly maxQueued = 3840, // 240 ms at 16 kHz
    private readonly trimTo = 1600, // 100 ms
    private readonly prime = 640, // 40 ms
  ) {}

  push(id: string, samples: Int16Array): void {
    let q = this.queues.get(id);
    if (!q) {
      q = { chunks: [], offset: 0, samples: 0, primed: false };
      this.queues.set(id, q);
    }
    q.chunks.push(samples);
    q.samples += samples.length;
    if (q.samples > this.maxQueued) this.take(q, q.samples - this.trimTo); // drop the oldest
  }

  remove(id: string): void {
    this.queues.delete(id);
  }

  get sources(): number {
    return this.queues.size;
  }

  /** The next 20 ms frame, or null when no source has a whole frame ready. */
  next(): Int16Array | null {
    let any = false;
    const sum = new Int32Array(this.frame);
    for (const q of this.queues.values()) {
      if (!q.primed) {
        if (q.samples < this.prime) continue;
        q.primed = true;
      }
      if (q.samples < this.frame) {
        q.primed = false; // ran dry: wait until there is a little buffered again
        continue;
      }
      any = true;
      const got = this.take(q, this.frame);
      for (let i = 0; i < got.length; i++) sum[i]! += got[i]!;
    }
    if (!any) return null;
    const out = new Int16Array(this.frame);
    for (let i = 0; i < this.frame; i++) out[i] = Math.max(-32768, Math.min(32767, sum[i]!));
    return out;
  }

  /** Removes and returns up to n samples from the front of a queue. */
  private take(q: { chunks: Int16Array[]; offset: number; samples: number }, n: number): Int16Array {
    const out = new Int16Array(Math.min(n, q.samples));
    let filled = 0;
    while (filled < out.length) {
      const head = q.chunks[0]!;
      const avail = head.length - q.offset;
      const take = Math.min(avail, out.length - filled);
      out.set(head.subarray(q.offset, q.offset + take), filled);
      filled += take;
      q.offset += take;
      if (q.offset >= head.length) {
        q.chunks.shift();
        q.offset = 0;
      }
    }
    q.samples -= out.length;
    return out;
  }
}
