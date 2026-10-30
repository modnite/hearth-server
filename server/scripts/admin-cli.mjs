// Recovery and setup from the machine the server runs on, for when nobody can sign in to the panel.
//
//   docker compose exec hearth node scripts/admin-cli.mjs list
//   docker compose exec hearth node scripts/admin-cli.mjs make-admin <username>
//   docker compose exec hearth node scripts/admin-cli.mjs reset-password <username>
//
// Outside Docker: DATA_DIR=/path/to/data node scripts/admin-cli.mjs ...   (after `npm run build`)
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { db } = await import(pathToFileURL(path.join(root, 'dist', 'db.js')).href);
const { hashPassword } = await import(pathToFileURL(path.join(root, 'dist', 'auth.js')).href);

const [cmd, name] = process.argv.slice(2);
const user = (n) => db.prepare('SELECT id, username, is_admin, disabled FROM users WHERE username = ?').get(n);

function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of crypto.randomBytes(16)) out += alphabet[b % alphabet.length];
  return out.match(/.{1,4}/g).join('-');
}

if (cmd === 'list') {
  for (const u of db.prepare('SELECT username, is_admin, disabled FROM users ORDER BY created_at').all()) {
    console.log(`${u.username}${u.is_admin ? '  (administrator)' : ''}${u.disabled ? '  (switched off)' : ''}`);
  }
} else if (cmd === 'make-admin' && name) {
  const u = user(name);
  if (!u) { console.error(`No account named ${name}.`); process.exit(1); }
  db.prepare('UPDATE users SET is_admin = 1, disabled = 0 WHERE id = ?').run(u.id);
  console.log(`${name} is an administrator now.`);
} else if (cmd === 'reset-password' && name) {
  const u = user(name);
  if (!u) { console.error(`No account named ${name}.`); process.exit(1); }
  const password = temporaryPassword();
  db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(hashPassword(password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM remember_tokens WHERE user_id = ?').run(u.id);
  console.log(`New password for ${name}: ${password}`);
  console.log('Sign in with it and change it.');
} else {
  console.error('Usage: admin-cli.mjs list | make-admin <username> | reset-password <username>');
  process.exit(2);
}
process.exit(0);
