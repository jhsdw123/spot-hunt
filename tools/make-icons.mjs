import { Resvg } from 'C:/Users/User/AutoIncome_2026/spot-difference-studio/tools/node_modules/@resvg/resvg-js/index.js';
import { writeFileSync } from 'node:fs';

function logo(pad) {
  // pad: extra safe-zone padding for maskable variant
  const s = 100 - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a1e38"/><stop offset="1" stop-color="#101223"/>
    </linearGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff5a5f"/><stop offset="1" stop-color="#ffb03a"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <g transform="translate(${pad} ${pad}) scale(${s / 100})">
    <circle cx="44" cy="44" r="24" fill="none" stroke="url(#fg)" stroke-width="10"/>
    <path d="M62 62 L82 82" stroke="url(#fg)" stroke-width="12" stroke-linecap="round"/>
    <path d="M36 42 Q44 33 53 38" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" opacity=".85"/>
  </g>
</svg>`;
}

for (const [file, size, pad] of [
  ['icon-192.png', 192, 8], ['icon-512.png', 512, 8],
  ['icon-180.png', 180, 8], ['icon-maskable-512.png', 512, 16],
]) {
  writeFileSync('../icons/' + file, new Resvg(logo(pad), { fitTo: { mode: 'width', value: size } }).render().asPng());
  console.log(file);
}
