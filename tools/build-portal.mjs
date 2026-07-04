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
  // CrazyGames forbids external/absolute asset paths — bundle the whole puzzle
  // library so the package is fully self-contained (well under their 250MB cap)
  crazygames: { stamp: `<script>window.SH_PORTAL='crazygames';window.SH_LIB_BASE='library'</script>`, bundleLibrary: true },
  gd: { stamp: `<script>window.SH_PORTAL='gd';window.SH_GD_GAME_ID='${GD_ID || 'REPLACE_WITH_GD_GAME_ID'}'</script>`, bundleLibrary: false },
};

// portal builds: no PWA bits (no SW registration happens in portal mode anyway)
const COPY = ['index.html', 'css', 'js', 'vendor', 'icons'];
const LIBRARY = resolve(ROOT, '../spot-difference-studio/library');

for (const [portal, { stamp, bundleLibrary }] of Object.entries(PORTALS)) {
  const out = join(DIST, portal);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const item of COPY) cpSync(join(ROOT, item), join(out, item), { recursive: true });
  if (bundleLibrary) cpSync(LIBRARY, join(out, 'library'), { recursive: true });

  let html = readFileSync(join(out, 'index.html'), 'utf8');
  html = html
    .replace(/^\s*<link rel="manifest"[^>]*>\r?\n/m, '')
    .replace('<script src="vendor/supabase.js" defer></script>',
      `${stamp}\n<script src="vendor/supabase.js" defer></script>`);
  if (!html.includes('SH_PORTAL')) throw new Error('portal stamp failed — supabase script tag not found');
  writeFileSync(join(out, 'index.html'), html);

  const zip = join(DIST, `spot-hunt-${portal}.zip`);
  rmSync(zip, { force: true });
  // Windows bsdtar produces a fully standard zip (incl. directory entries) —
  // PowerShell's Compress-Archive omits directory entries, which some server-side
  // unzippers reject; GNU tar (git) would parse "C:" as a remote host, so use
  // System32's bsdtar explicitly. Items are listed by name so entries sit at the
  // zip root (a "-C dir ." archive prefixes everything with "./").
  const items = readdirSync(out).map(n => `"${n}"`).join(' ');
  execSync(`C:\\Windows\\System32\\tar.exe -a -cf "${zip}" -C "${out}" ${items}`, { stdio: 'pipe' });

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
