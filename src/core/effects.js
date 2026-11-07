// Screen effects (DOM overlays above the canvas).
//   await ctx.effects.fadeOut(600);  await ctx.effects.fadeIn(600);  ctx.effects.setFade(1);
//   await ctx.effects.error({ duration: 2500 });  // red tint + bubble "ERROR!" swarm + shake

const STYLE = `
.fx-fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; z-index: 30; }
.fx-error { position: fixed; inset: 0; pointer-events: none; z-index: 35; overflow: hidden; }
.fx-tint { position: absolute; inset: 0; background: #ff1a1a; mix-blend-mode: multiply;
  animation: fx-flicker 0.18s steps(2) infinite; }
.fx-word { position: absolute; font-family: 'Rubik Bubbles', 'Arial Black', sans-serif; color: #ff1a1a;
  -webkit-text-stroke: 2px #fff; text-shadow: 0 0 14px #f00, 5px 5px 0 #5a0000; white-space: nowrap;
  animation: fx-pop 0.25s ease-out both, fx-glitch 0.35s steps(2) infinite; }
#game.fx-shake { animation: fx-shake 0.12s steps(2) infinite; }
@keyframes fx-flicker { 0% { opacity: 0.75; } 100% { opacity: 0.55; } }
@keyframes fx-pop { 0% { scale: 0; } 70% { scale: 1.25; } 100% { scale: 1; } }
@keyframes fx-glitch {
  0%, 100% { clip-path: inset(0 0 0 0); translate: 0 0; }
  25% { clip-path: inset(15% 0 45% 0); translate: -8px 0; }
  50% { clip-path: inset(55% 0 5% 0); translate: 8px 2px; }
  75% { clip-path: inset(0 0 0 0); translate: 0 -3px; }
}
@keyframes fx-shake { 0% { translate: -4px 3px; } 50% { translate: 5px -3px; } 100% { translate: -2px -4px; } }
`;

export class Effects {
  constructor(canvas) {
    this.canvas = canvas;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'fx-fade';
    document.body.appendChild(this.fadeEl);

    this._errors = new Set(); // { el, timers, resolve }
  }

  /** Set the fade overlay instantly (0 = clear, 1 = fully covered). */
  setFade(opacity, color = '#000') {
    this.fadeEl.style.transition = 'none';
    this.fadeEl.style.background = color;
    this.fadeEl.style.opacity = String(opacity);
  }

  fade(to, ms = 600, color) {
    if (color) this.fadeEl.style.background = color;
    void this.fadeEl.offsetWidth; // flush so the transition always runs
    this.fadeEl.style.transition = `opacity ${ms}ms linear`;
    this.fadeEl.style.opacity = String(to);
    return new Promise((r) => setTimeout(r, ms));
  }

  fadeOut(ms = 600, color = '#000') { return this.fade(1, ms, color); }
  fadeIn(ms = 600) { return this.fade(0, ms); }

  /** Red ERROR! glitch. Resolves when finished. */
  error({ duration = 2500, count = 28, text = 'ERROR!' } = {}) {
    const el = document.createElement('div');
    el.className = 'fx-error';
    const tint = document.createElement('div');
    tint.className = 'fx-tint';
    el.appendChild(tint);
    document.body.appendChild(el);
    this.canvas.classList.add('fx-shake');

    const entry = { el, timers: [], resolve: null };
    const spawnWindow = duration * 0.6;
    for (let i = 0; i < count; i++) {
      entry.timers.push(setTimeout(() => {
        const w = document.createElement('div');
        w.className = 'fx-word';
        w.textContent = text;
        w.style.left = `${Math.random() * 85}%`;
        w.style.top = `${Math.random() * 88}%`;
        w.style.fontSize = `${40 + Math.random() * 80}px`;
        w.style.rotate = `${(Math.random() - 0.5) * 40}deg`;
        el.appendChild(w);
      }, (i / count) * spawnWindow));
    }

    return new Promise((resolve) => {
      entry.resolve = resolve;
      entry.timers.push(setTimeout(() => this._endError(entry), duration));
      this._errors.add(entry);
    });
  }

  /** Remove any running error effects (fade state is left alone). */
  clear() {
    for (const e of [...this._errors]) this._endError(e);
  }

  _endError(entry) {
    if (!this._errors.has(entry)) return;
    this._errors.delete(entry);
    entry.timers.forEach(clearTimeout);
    entry.el.remove();
    if (!this._errors.size) this.canvas.classList.remove('fx-shake');
    entry.resolve?.();
  }
}
