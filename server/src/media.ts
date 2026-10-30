import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { env } from './env.js';
import type { LiveKitProbe, LkParticipant } from './callHealth.js';

export interface MediaRoom {
  id: string;
  name: string;
  participants: number;
  /** When the media room was created, in ms (best effort). */
  createdAt?: number;
}

export interface MintTokenOptions {
  identity: string;
  name: string;
  room: string;
  canPublish?: boolean;
}

/**
 * The one seam between Hearth and whatever moves the media.
 * Swap this implementation and the call component; nothing else changes.
 */
export interface MediaEngine {
  mintToken(opts: MintTokenOptions): Promise<string>;
  listRooms(): Promise<MediaRoom[]>;
  /** The identities currently connected to a media room. */
  listParticipants(room: string): Promise<string[]>;
  endRoom(room: string): Promise<void>;
}

class LiveKitEngine implements MediaEngine, LiveKitProbe {
  private svc = new RoomServiceClient(
    env.LIVEKIT_INTERNAL_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );

  async mintToken({ identity, name, room, canPublish = true }: MintTokenOptions): Promise<string> {
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity,
      name,
      ttl: '6h',
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });
    return at.toJwt();
  }

  async listRooms(): Promise<MediaRoom[]> {
    try {
      const rooms = await this.svc.listRooms();
      return rooms.map((r) => ({
        id: r.name,
        name: r.name,
        participants: r.numParticipants,
        createdAt: r.creationTime ? Number(r.creationTime) * 1000 : undefined,
      }));
    } catch {
      // LiveKit not reachable yet is not fatal: voice rooms are created on demand.
      return [];
    }
  }

  async listParticipants(room: string): Promise<string[]> {
    try {
      const parts = await this.svc.listParticipants(room);
      return parts.map((p) => p.identity);
    } catch {
      return [];
    }
  }

  /**
   * What each participant is really publishing. null = the engine could not be
   * asked (down, timing out); an unknown room is an empty list, not an outage.
   */
  async inspectRoom(room: string): Promise<LkParticipant[] | null> {
    try {
      const parts = await this.svc.listParticipants(room);
      return parts.map((p) => {
        const out: LkParticipant = {
          identity: p.identity,
          mic: false,
          cam: false,
          screen: false,
          published: { mic: false, cam: false, screen: false },
        };
        for (const t of p.tracks ?? []) {
          // TrackSource: 1 camera, 2 microphone, 3 screen share
          const kind = t.source === 1 ? 'cam' : t.source === 2 ? 'mic' : t.source === 3 ? 'screen' : null;
          if (!kind) continue;
          out.published[kind] = true;
          if (!t.muted) out[kind] = true;
        }
        return out;
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/not found|does not exist/i.test(msg)) return [];
      return null;
    }
  }

  async endRoom(room: string): Promise<void> {
    await this.svc.deleteRoom(room);
  }
}

const engine = new LiveKitEngine();
export const media: MediaEngine = engine;
/** The same engine, seen through the health cross-check's narrow interface. */
export const mediaProbe: LiveKitProbe = engine;

/** Chat rooms and voice rooms share an id: voice room = hearth_<roomId>. */
export const mediaRoomName = (roomId: string) => `hearth_${roomId}`;
export const roomIdFromMediaName = (name: string): string | null =>
  name.startsWith('hearth_') ? name.slice('hearth_'.length) : null;
