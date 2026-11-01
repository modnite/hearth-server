/**
 * Who should do what in a group of servers (a main server and its mirrors), decided from what one server can see of the others. Pure, so the
 * rules can be tested without a network. Each server runs this about every five seconds and acts on its own answer; the rules are built so
 * that servers which see the same thing agree.
 *
 * A node is "writable" when it is the one serving people right now: the main server in good health, or a mirror that took over.
 */

export interface PeerView {
  id: string;
  rank: number;
  reachable: boolean;
  writable: boolean;
  epoch: number;
  /** The id of the node this peer counts as the main server (changes when a mirror is promoted for good). */
  primaryId: string;
}

export interface SelfView {
  id: string;
  rank: number;
  role: 'primary' | 'mirror';
  /** A mirror that has taken over. */
  acting: boolean;
  epoch: number;
  primaryId: string;
}

export type Action =
  | { t: 'none' }
  /** Copy from this node (it is the one serving people). */
  | { t: 'follow'; from: string }
  /** Take over as the main server, with this epoch. */
  | { t: 'promote'; epoch: number }
  /** Stop acting as the main server; another node outranks this one. */
  | { t: 'demote'; to: string }
  /** The main server is back: fetch what the stand-in collected, then serve again. */
  | { t: 'reclaim'; from: string }
  /** Another node was made the main server for good: become its mirror. */
  | { t: 'rebase'; to: string };

/** The node that should be serving, among the writable ones: the newest epoch, then the lowest rank. */
export function best(peers: PeerView[]): PeerView | null {
  const w = peers.filter((p) => p.reachable && p.writable);
  w.sort((a, b) => b.epoch - a.epoch || a.rank - b.rank);
  return w[0] ?? null;
}

export function decide(self: SelfView, peers: PeerView[], downForMs: number, failoverMs: number): Action {
  const top = best(peers);
  if (self.role === 'primary') {
    if (!top) return { t: 'none' };
    // A mirror was made the main server for good: this one steps down to be its mirror.
    if (top.primaryId !== self.id && top.epoch > self.epoch) return { t: 'rebase', to: top.id };
    // A mirror stood in while this one was away: get what it collected.
    if (top.epoch > self.epoch) return { t: 'reclaim', from: top.id };
    return { t: 'none' };
  }
  if (self.acting) {
    // Two stand-ins after a break in the network: the newer epoch wins, then the lower rank. The loser copies from the winner.
    if (top && (top.epoch > self.epoch || (top.epoch === self.epoch && top.rank < self.rank))) return { t: 'demote', to: top.id };
    return { t: 'none' };
  }
  if (top) return { t: 'follow', from: top.id };
  // Nobody is serving. The main server must be unreachable (not just busy starting) for a while, and every mirror ranked above this one too.
  const primary = peers.find((p) => p.id === self.primaryId);
  if (primary?.reachable) return { t: 'none' };
  if (downForMs < failoverMs) return { t: 'none' };
  if (peers.some((p) => p.id !== self.primaryId && p.rank < self.rank && p.reachable)) return { t: 'none' };
  return { t: 'promote', epoch: Math.max(self.epoch, ...peers.map((p) => p.epoch)) + 1 };
}
