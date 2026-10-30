/**
 * Whether someone is *in* Hearth, as opposed to merely connected.
 *
 * This distinction is the whole reason push looked broken: a backgrounded tab, or
 * a phone sitting on another app, keeps its websocket open. Treating that as
 * "present" means the server decides there is nothing to notify and stays silent.
 * A notification is worth sending only when nobody has the app on screen.
 */
export interface PresenceState {
  /** Whether this tab is on screen. */
  visible: boolean;
}

export function isActivelyPresent(states: PresenceState[]): boolean {
  for (const state of states) {
    if (state.visible) return true;
  }
  return false;
}
