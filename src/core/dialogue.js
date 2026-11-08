// Subtitle box with typewriter text.
//   await ctx.dialogue.say('Hello', { speaker: 'Fire Hydrant' });
//   await ctx.dialogue.play([{ speaker: 'Hydrant', text: '...' }, 'plain line', { text: '...', duration: 2000 }]);
// E / Enter / click: finish typing, then advance. `duration` (ms) auto-advances after typing.
// Optional per line: `color` (speaker name colour), `onStart(line, index)` (fires when the line appears).
// `dialogue.speaker` / `dialogue.typing` let scenes animate whoever is talking.
// While active, E is consumed here so it doesn't also trigger an interaction.

const CHARS_PER_SEC = 45;

export class Dialogue {
  constructor() {
    this.box = document.createElement('div');
    Object.assign(this.box.style, {
      position: 'fixed', left: '50%', bottom: '48px', transform: 'translateX(-50%)',
      width: 'min(800px, calc(100vw - 32px))', boxSizing: 'border-box', padding: '14px 20px',
      borderRadius: '10px', background: 'rgba(0,0,0,0.75)', color: '#fff',
      font: '20px/1.4 system-ui, sans-serif', zIndex: '40', display: 'none', pointerEvents: 'none',
    });
    this.speakerEl = document.createElement('div');
    Object.assign(this.speakerEl.style, { fontWeight: '700', color: '#ffd166', marginBottom: '4px' });
    this.textEl = document.createElement('div');
    this.hintEl = document.createElement('div');
    this.hintEl.textContent = 'E ▸';
    Object.assign(this.hintEl.style, { position: 'absolute', right: '12px', bottom: '6px', fontSize: '12px', opacity: '0.6' });
    this.box.append(this.speakerEl, this.textEl, this.hintEl);
    document.body.appendChild(this.box);

    this._lines = [];
    this._index = -1;
    this._current = null;
    this._resolve = null;
    this._typing = null;
    this._auto = null;

    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.code !== 'KeyE' && e.code !== 'Enter')) return;
      e.stopImmediatePropagation();
      if (!e.repeat) this._advance();
    }, true);
    window.addEventListener('mousedown', () => { if (this.active) this._advance(); }, true);
  }

  get active() { return this._current !== null; }

  /** Speaker of the line currently on screen, or null. */
  get speaker() { return this._current ? this._current.speaker || null : null; }

  /** True while the current line is still typing out. */
  get typing() { return this._typing !== null; }

  say(text, opts = {}) {
    return this.play([{ text, ...opts }]);
  }

  play(lines) {
    this.clear();
    return new Promise((resolve) => {
      this._lines = lines.map((l) => (typeof l === 'string' ? { text: l } : l));
      this._index = -1;
      this._resolve = resolve;
      this._next();
    });
  }

  /** Cancel any dialogue immediately (resolves the pending promise). */
  clear() {
    this._stopTimers();
    this._current = null;
    this._lines = [];
    this.box.style.display = 'none';
    const r = this._resolve;
    this._resolve = null;
    if (r) r();
  }

  _next() {
    this._stopTimers();
    this._index++;
    if (this._index >= this._lines.length) { this.clear(); return; }
    const line = this._lines[this._index];
    this._current = line;
    this.speakerEl.textContent = line.speaker || '';
    this.speakerEl.style.display = line.speaker ? 'block' : 'none';
    this.speakerEl.style.color = line.color || '#ffd166';
    this.textEl.textContent = '';
    this.box.style.display = 'block';
    if (line.onStart) {
      try { line.onStart(line, this._index); } catch (e) { console.error(e); }
    }

    let shown = 0;
    this._typing = setInterval(() => {
      shown++;
      this.textEl.textContent = line.text.slice(0, shown);
      if (shown >= line.text.length) this._finishTyping();
    }, 1000 / CHARS_PER_SEC);
  }

  _finishTyping() {
    clearInterval(this._typing);
    this._typing = null;
    this.textEl.textContent = this._current.text;
    if (this._current.duration != null) {
      this._auto = setTimeout(() => this._next(), this._current.duration);
    }
  }

  _advance() {
    if (this._typing) this._finishTyping();
    else this._next();
  }

  _stopTimers() {
    clearInterval(this._typing);
    clearTimeout(this._auto);
    this._typing = null;
    this._auto = null;
  }
}
