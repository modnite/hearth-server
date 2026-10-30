import path from 'node:path';
import './selfConfigure.js'; // first: fills in what was not given (see that file)
import './config.js'; // applies the admin panel's saved settings to process.env before it is read below
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), 'data')),
  HEARTH_DOMAIN: z.string().default('localhost'),

  SESSION_SECRET: z.string().default('dev-session-secret-change-me'),

  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_INTERNAL_URL: z.string().default('http://127.0.0.1:7880'),
  LIVEKIT_API_KEY: z.string().default('hearth'),
  LIVEKIT_API_SECRET: z.string().default('devsecret'),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),

  // The OpenSAPI4 speech service (Microsoft Sam and friends), spoken for the
  // assistant. Runs next to the app; see docs/DEPLOY-OMV.md.
  HEARTH_TTS_URL: z.string().default('http://127.0.0.1:5040'),

  // Speech to text, for having the assistant read a voice note aloud. Any
  // whisper-style HTTP service works (the whisper-asr-webservice API); empty
  // means the feature is simply off, and says so.
  HEARTH_STT_URL: z.string().default(''),
  HEARTH_STT_MODEL: z.string().default('base.en'),

  FIRST_USER_USERNAME: z.string().default(''),
  FIRST_USER_PASSWORD: z.string().default(''),
  FIRST_USER_DISPLAY_NAME: z.string().default(''),

  // A shared registration passphrase ("house key"): whoever knows it can create
  // an account without a one-off invite code. Empty = invite codes only.
  REGISTRATION_KEY: z.string().default(''),
});


export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';
