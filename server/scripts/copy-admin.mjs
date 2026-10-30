// The admin panel is plain files next to the compiled server: copy them into dist/ after tsc.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.rmSync(path.join(root, 'dist', 'admin'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'src', 'admin'), path.join(root, 'dist', 'admin'), { recursive: true });
console.log('admin panel copied to dist/admin');
