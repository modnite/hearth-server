import { describe, expect, it } from 'vitest';
import { decide, type PeerView, type SelfView } from './mirrorLogic.js';

const peer = (id: string, rank: number, o: Partial<PeerView> = {}): PeerView => ({ id, rank, reachable: true, writable: false, epoch: 1, primaryId: 'P', ...o });
const mirror = (rank: number, o: Partial<SelfView> = {}): SelfView => ({ id: `M${rank}`, rank, role: 'mirror', acting: false, epoch: 1, primaryId: 'P', ...o });
const primary = (o: Partial<SelfView> = {}): SelfView => ({ id: 'P', rank: 0, role: 'primary', acting: false, epoch: 1, primaryId: 'P', ...o });
const FAIL = 30_000;

describe('mirror decisions', () => {
  it('a mirror follows the main server while it serves', () => {
    expect(decide(mirror(1), [peer('P', 0, { writable: true }), peer('M2', 2)], 0, FAIL)).toEqual({ t: 'follow', from: 'P' });
  });

  it('waits out a short outage and takes over after the failover time', () => {
    const peers = [peer('P', 0, { reachable: false }), peer('M2', 2)];
    expect(decide(mirror(1), peers, 10_000, FAIL)).toEqual({ t: 'none' });
    expect(decide(mirror(1), peers, 31_000, FAIL)).toEqual({ t: 'promote', epoch: 2 });
  });

  it('a higher ranked mirror leaves it to the lower one while that one answers', () => {
    const peers = [peer('P', 0, { reachable: false }), peer('M1', 1)];
    expect(decide(mirror(2), peers, 60_000, FAIL)).toEqual({ t: 'none' });
  });

  it('a higher ranked mirror takes over when every lower one is gone too', () => {
    const peers = [peer('P', 0, { reachable: false }), peer('M1', 1, { reachable: false })];
    expect(decide(mirror(2), peers, 60_000, FAIL)).toEqual({ t: 'promote', epoch: 2 });
  });

  it('does not take over from a main server that answers but is still starting', () => {
    expect(decide(mirror(1), [peer('P', 0, { writable: false })], 90_000, FAIL)).toEqual({ t: 'none' });
  });

  it('follows the stand in once there is one, and the other mirrors follow it too', () => {
    const peers = [peer('P', 0, { reachable: false }), peer('M1', 1, { writable: true, epoch: 2 })];
    expect(decide(mirror(2), peers, 5_000, FAIL)).toEqual({ t: 'follow', from: 'M1' });
  });

  it('the main server takes back what the stand in collected', () => {
    expect(decide(primary(), [peer('M1', 1, { writable: true, epoch: 2 })], 0, FAIL)).toEqual({ t: 'reclaim', from: 'M1' });
    expect(decide(primary(), [peer('M1', 1)], 0, FAIL)).toEqual({ t: 'none' });
  });

  it('two stand ins after a split: the newer epoch wins, then the lower rank', () => {
    expect(decide(mirror(2, { acting: true, epoch: 2 }), [peer('M1', 1, { writable: true, epoch: 2 })], 0, FAIL)).toEqual({ t: 'demote', to: 'M1' });
    expect(decide(mirror(1, { acting: true, epoch: 2 }), [peer('M2', 2, { writable: true, epoch: 2 })], 0, FAIL)).toEqual({ t: 'none' });
    expect(decide(mirror(1, { acting: true, epoch: 2 }), [peer('M2', 2, { writable: true, epoch: 3 })], 0, FAIL)).toEqual({ t: 'demote', to: 'M2' });
  });

  it('a stand in steps back for the main server once it serves again at a newer epoch', () => {
    expect(decide(mirror(1, { acting: true, epoch: 2 }), [peer('P', 0, { writable: true, epoch: 3 })], 0, FAIL)).toEqual({ t: 'demote', to: 'P' });
  });

  it('a mirror made the main server for good turns the old main server into a mirror', () => {
    expect(decide(primary(), [peer('M1', 1, { writable: true, epoch: 5, primaryId: 'M1' })], 0, FAIL)).toEqual({ t: 'rebase', to: 'M1' });
  });
});
