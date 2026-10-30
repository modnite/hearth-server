/**
 * Pure bookkeeping for the signalled media state of the people in an active
 * call. Kept free of any transport/database concerns so the rules below can be
 * reasoned about — and tested — on their own.
 */

export interface MediaState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  /**
   * Optional health, reported by the client and corrected by the server's
   * cross-check with the media engine. Old clients never send it.
   */
  health?: { mic: string; cam: string };
  /** When this device last reported (server clock, ms). */
  reportAt?: number;
  /** Set when the server, not the device, last changed this entry. */
  corrected?: { at: number; by: 'livekit'; reason: string };
}

/**
 * A user and the device they are on — the same shape LiveKit uses as identity,
 * so signalled state lines up with the participant's `identity` on the client.
 */
export function callIdentity(userId: string, device: string): string {
  return `${userId}:${device}`;
}

/** True for a state key that belongs to this user (on any of their devices). */
export function stateBelongsTo(key: string, userId: string): boolean {
  const at = key.indexOf(':');
  return (at === -1 ? key : key.slice(0, at)) === userId;
}

/**
 * Signalled media state for one call, keyed by device identity (`userId:device`)
 * — not by user. A person can be in the same call from more than one device
 * (desktop and phone), and those sessions are independent: muting the desktop
 * must not make the phone look (or act) muted, and vice versa. Keying by user
 * would let one device's report overwrite the other's.
 */
export class CallStates {
  private states = new Map<string, MediaState>();

  /** Record the media state reported by one device of a user. */
  set(userId: string, device: string, state: MediaState): void {
    this.states.set(callIdentity(userId, device), state);
  }

  /** Drop just the entry for this one device; other devices are untouched. */
  deleteDevice(userId: string, device: string): void {
    this.states.delete(callIdentity(userId, device));
  }

  /** Drop every device entry belonging to this user (they went fully offline). */
  deleteUser(userId: string): void {
    for (const key of [...this.states.keys()]) {
      if (stateBelongsTo(key, userId)) this.states.delete(key);
    }
  }

  /** The state this specific device last reported, if any. */
  get(userId: string, device: string): MediaState | undefined {
    return this.states.get(callIdentity(userId, device));
  }

  /** Number of device entries currently tracked. */
  get size(): number {
    return this.states.size;
  }

  /** The identity-keyed record the `call.active` frame broadcasts. */
  toJSON(): Record<string, MediaState> {
    return Object.fromEntries(this.states);
  }
}
