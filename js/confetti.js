// Minimal canvas confetti — 'burst' from center or 'rain' falling from the sky.
export function confetti(duration = 1600, mode = 'burst') {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = innerWidth; canvas.height = innerHeight; };
  resize();
  const colors = ['#ff5a5f', '#ffb03a', '#34d399', '#60a5fa', '#c084fc', '#f4f5fa'];
  const rain = mode === 'rain';
  const parts = Array.from({ length: rain ? 150 : 120 }, () => ({
    x: rain ? Math.random() * canvas.width : canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.5,
    y: rain ? -Math.random() * canvas.height * 0.6 - 10 : canvas.height * 0.35,
    vx: (Math.random() - 0.5) * (rain ? 3 : 11),
    vy: rain ? 3 + Math.random() * 5 : -Math.random() * 13 - 4,
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const el = t - t0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += rain ? 0.08 : 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - el / duration);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (el < duration) requestAnimationFrame(frame);
    else canvas.remove();
  })(t0);
}
