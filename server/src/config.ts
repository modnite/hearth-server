import fs from 'node:fs';
import path from 'node:path';

/**
 * Settings an operator can change without editing files. Every setting has an environment variable (the way a container is configured
 * from outside), a default, and optionally a value saved by the admin panel in DATA_DIR/config.json. Order of precedence: panel value,
 * then environment, then default. A setting marked `live` takes effect at once; the others are read when the server starts.
 *
 * This file imports nothing from the rest of the server on purpose: env.ts reads it before the database exists.
 */

export type SettingType = 'text' | 'secret' | 'number' | 'choice';

export interface SettingDef {
  key: string;
  env: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  default: string;
  choices?: string[];
  /** Takes effect immediately; otherwise the server must be restarted. */
  live: boolean;
  min?: number;
  max?: number;
}

export const SETTINGS: SettingDef[] = [
  { key: 'serverName', env: 'HEARTH_NAME', group: 'Server', label: 'Server name', help: 'Shown to people on the sign-in screen of any client.', type: 'text', default: 'Hearth', live: true },
  { key: 'motd', env: 'HEARTH_MOTD', group: 'Server', label: 'Welcome note', help: 'A line shown on the sign-in screen, for example who runs this server and who may join.', type: 'text', default: '', live: true },
  { key: 'domain', env: 'HEARTH_DOMAIN', group: 'Server', label: 'Public address', help: 'The name people reach this server by. Used in two-step sign-in labels and links.', type: 'text', default: 'localhost', live: false },

  { key: 'registration', env: 'REGISTRATION', group: 'Joining', label: 'Who can create an account', help: 'Invite: needs an invite code or the house key. Open: anyone who can reach the server (limited to five new accounts an hour from one address).', type: 'choice', default: 'invite', choices: ['invite', 'open'], live: true },
  { key: 'registrationKey', env: 'REGISTRATION_KEY', group: 'Joining', label: 'House key', help: 'A shared passphrase (8 or more characters) that works like an invite code for everyone who knows it. Empty switches it off.', type: 'secret', default: '', live: true },

  { key: 'backupStorage', env: 'BACKUP_STORAGE', group: 'Backups', label: 'Keep backups for people', help: 'Lets clients such as Ember store their sealed backups here. The server cannot read them.', type: 'choice', default: 'on', choices: ['on', 'off'], live: true },
  { key: 'backupQuotaMb', env: 'BACKUP_QUOTA_MB', group: 'Backups', label: 'Backup space per person (MB)', help: 'Each person gets this much room for backups.', type: 'number', default: '4096', live: true, min: 1, max: 1_000_000 },
  { key: 'backupMaxFileMb', env: 'BACKUP_MAX_FILE_MB', group: 'Backups', label: 'Largest single backup (MB)', help: 'A backup bigger than this is refused.', type: 'number', default: '1024', live: true, min: 1, max: 1_000_000 },

  { key: 'browser', env: 'BROWSE_PROXY', group: 'Features', label: 'Built-in browser proxy', help: 'Lets clients open web pages through this server. Switch off if you do not want the server fetching pages for people.', type: 'choice', default: 'on', choices: ['on', 'off'], live: true },

  { key: 'crashReports', env: 'CRASH_REPORTS', group: 'Crash reports', label: 'Collect crash reports', help: 'Clients such as Ember and the web app send their crash logs here for you to review.', type: 'choice', default: 'on', choices: ['on', 'off'], live: true },
  { key: 'crashKeepDays', env: 'CRASH_KEEP_DAYS', group: 'Crash reports', label: 'Keep reports for (days)', help: 'Older reports are deleted.', type: 'number', default: '90', live: true, min: 1, max: 3650 },

  { key: 'livekitUrl', env: 'LIVEKIT_URL', group: 'Calls', label: 'LiveKit address for clients', help: 'The wss:// address clients connect to for voice and video (the base address, no /rtc).', type: 'text', default: 'ws://localhost:7880', live: false },
  { key: 'livekitInternalUrl', env: 'LIVEKIT_INTERNAL_URL', group: 'Calls', label: 'LiveKit address for this server', help: 'How this server reaches LiveKit itself, usually http://127.0.0.1:7880 or the container name.', type: 'text', default: 'http://127.0.0.1:7880', live: false },
  { key: 'livekitKey', env: 'LIVEKIT_API_KEY', group: 'Calls', label: 'LiveKit API key', help: 'Must match the key in the LiveKit configuration.', type: 'text', default: 'hearth', live: false },
  { key: 'livekitSecret', env: 'LIVEKIT_API_SECRET', group: 'Calls', label: 'LiveKit API secret', help: 'Must match the secret in the LiveKit configuration. Long and random.', type: 'secret', default: 'devsecret', live: false },

  { key: 'vapidPublic', env: 'VAPID_PUBLIC_KEY', group: 'Notifications', label: 'Web push public key', help: 'For browser and PWA notifications. Generate a pair once with `npm run vapid`.', type: 'text', default: '', live: false },
  { key: 'vapidPrivate', env: 'VAPID_PRIVATE_KEY', group: 'Notifications', label: 'Web push private key', help: 'The matching private key.', type: 'secret', default: '', live: false },
  { key: 'vapidSubject', env: 'VAPID_SUBJECT', group: 'Notifications', label: 'Web push contact', help: 'A mailto: or https: address push services can reach you at.', type: 'text', default: '', live: false },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
const file = path.join(dataDir, 'config.json');

/** What the environment said before this file put anything into process.env, so the panel can tell the two apart. */
const originalEnv: Record<string, string | undefined> = {};
for (const s of SETTINGS) originalEnv[s.env] = process.env[s.env];

let overrides: Record<string, string> = {};

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (BY_KEY.has(k) && typeof v === 'string') next[k] = v;
    overrides = next;
  } catch {
    overrides = {};
  }
}
load();

// The settings read at start-up (env.ts and friends) see panel values through process.env.
for (const s of SETTINGS) if (s.key in overrides) process.env[s.env] = overrides[s.key];

export type Source = 'panel' | 'environment' | 'default';

export function sourceOf(key: string): Source {
  const def = BY_KEY.get(key);
  if (!def) return 'default';
  if (key in overrides) return 'panel';
  return originalEnv[def.env] !== undefined && originalEnv[def.env] !== '' ? 'environment' : 'default';
}

/** The value in force right now. */
export function cfg(key: string): string {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  if (key in overrides) return overrides[key]!;
  const fromEnv = originalEnv[def.env];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : def.default;
}

export function cfgNumber(key: string): number {
  const def = BY_KEY.get(key)!;
  const n = Number(cfg(key));
  return Number.isFinite(n) && n > 0 ? n : Number(def.default);
}

/** Registration is open when the setting says so; REGISTRATION=1/true/on from older setups still counts. */
export function registrationOpen(): boolean {
  return ['1', 'true', 'on', 'open'].includes(cfg('registration').trim().toLowerCase());
}

export function browserEnabled(): boolean {
  return cfg('browser').trim().toLowerCase() !== 'off';
}

export function backupStorageOn(): boolean {
  return cfg('backupStorage').trim().toLowerCase() !== 'off';
}

export class ConfigError extends Error {}

/** Check one value against its setting; returns the cleaned text. */
export function validate(def: SettingDef, raw: unknown): string {
  if (typeof raw !== 'string') throw new ConfigError(`${def.label} must be text`);
  const v = raw.trim();
  if (v.length > 500) throw new ConfigError(`${def.label} is too long`);
  if (def.type === 'choice' && !def.choices!.includes(v)) throw new ConfigError(`${def.label} must be one of: ${def.choices!.join(', ')}`);
  if (def.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ConfigError(`${def.label} must be a whole number`);
    if (def.min !== undefined && n < def.min) throw new ConfigError(`${def.label} must be at least ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new ConfigError(`${def.label} must be at most ${def.max}`);
  }
  if (def.key === 'registrationKey' && v !== '' && v.length < 8) throw new ConfigError('The house key needs 8 or more characters, or leave it empty to switch it off');
  if ((def.key === 'livekitUrl') && v !== '' && !/^(wss?|https?):\/\/[^\s]+$/i.test(v)) throw new ConfigError('The LiveKit address for clients must start with wss:// or ws://');
  if (def.key === 'livekitInternalUrl' && v !== '' && !/^https?:\/\/[^\s]+$/i.test(v)) throw new ConfigError('The LiveKit address for this server must start with http:// or https://');
  return v;
}

function save(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Apply a set of changes. A value of null clears the panel value (back to environment or default). Nothing is saved unless every
 * value is valid. Returns the keys that changed and whether any of them needs a restart.
 */
export function updateConfig(changes: Record<string, string | null>): { changed: string[]; restart: boolean } {
  const next = { ...overrides };
  const changed: string[] = [];
  let restart = false;
  for (const [key, value] of Object.entries(changes)) {
    const def = BY_KEY.get(key);
    if (!def) throw new ConfigError(`unknown setting ${key}`);
    const before = cfg(key);
    if (value === null) delete next[key];
    else next[key] = validate(def, value);
    const prev = overrides;
    overrides = next;
    const after = cfg(key);
    overrides = prev;
    if (before !== after) {
      changed.push(key);
      if (!def.live) restart = true;
    }
  }
  overrides = next;
  save();
  for (const key of changed) {
    const def = BY_KEY.get(key)!;
    if (key in overrides) process.env[def.env] = overrides[key];
    else if (originalEnv[def.env] === undefined) delete process.env[def.env];
    else process.env[def.env] = originalEnv[def.env];
  }
  return { changed, restart };
}

export interface SettingView {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  choices?: string[];
  live: boolean;
  source: Source;
  /** Plain value; for secrets only whether one is set. */
  value: string | null;
  set: boolean;
  default: string;
  min?: number;
  max?: number;
}

export function describeConfig(): SettingView[] {
  return SETTINGS.map((s) => {
    const v = cfg(s.key);
    return {
      key: s.key,
      group: s.group,
      label: s.label,
      help: s.help,
      type: s.type,
      choices: s.choices,
      live: s.live,
      source: sourceOf(s.key),
      value: s.type === 'secret' ? null : v,
      set: v !== '',
      default: s.type === 'secret' ? '' : s.default,
      min: s.min,
      max: s.max,
    };
  });
}
