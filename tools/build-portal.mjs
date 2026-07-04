// Build self-contained portal packages (CrazyGames / GameDistribution).
// Usage: node build-portal.mjs [--gd-id YOUR_GD_GAME_ID]
// Output: tools/dist/<portal>/ + tools/dist/spot-hunt-<portal>.zip
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(import.meta.dirname, 'dist');
const gdIdx = process.argv.indexOf('--gd-id');
const GD_ID = gdIdx > -1 ? process.argv[gdIdx + 1] : '';

const PORTALS = {
  crazygames: `<script>window.SH_PORTAL='crazygames'</script>`,
  gd: `<script>window.SH_PORTAL='gd';window.SH_GD_GAME_ID='${GD_ID || 'REPLACE_WITH_GD_GAME_ID'}'</script>`,
};

// portal builds: no PWA bits (no SW registration happens in portal mode anyway)
const COPY = ['index.html', 'css', 'js', 'vendor', 'icons'];

for (const [portal, stamp] of Object.entries(PORTALS)) {
  const out = join(DIST, portal);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const item of COPY) cpSync(join(ROOT, item), join(out, item), { recursive: true });

  let html = readFileSync(join(out, 'index.html'), 'utf8');
  html = html
    .replace(/^\s*<link rel="manifest"[^>]*>\r?\n/m, '')
    .replace('<script src="vendor/supabase.js" defer></script>',
      `${stamp}\n<script src="vendor/supabase.js" defer></script>`);
  if (!html.includes('SH_PORTAL')) throw new Error('portal stamp failed — supabase script tag not found');
  writeFileSync(join(out, 'index.html'), html);

  const zip = join(DIST, `spot-hunt-${portal}.zip`);
  rmSync(zip, { force: true });
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}' -Force"`);

  // report package size/count (CrazyGames limits: <=50MB initial, <=1500 files)
  let files = 0, bytes = 0;
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f), s = statSync(p);
      if (s.isDirectory()) walk(p); else { files++; bytes += s.size; }
    }
  })(out);
  console.log(`${portal}: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB unzipped -> ${zip}`);
  if (portal === 'gd' && !GD_ID) console.log('  (gd: placeholder game id — rebuild with --gd-id after registering the game)');
}
