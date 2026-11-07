// Screen effects (DOM overlays above the canvas).
//   await ctx.effects.fadeOut(600);  await ctx.effects.fadeIn(600);  ctx.effects.setFade(1);
//   await ctx.effects.error({ duration: 2500, audio: ctx.audio });  // system-crash glitch, cuts out abruptly
//
// error() draws a WebGL overlay that samples the game canvas every frame and runs it through a
// distortion shader (chromatic split, slice displacement, tearing, rolls, static, scanlines, red
// grade). The corrupted ERROR! text is drawn on a 2D canvas and pushed through the same shader so it
// tears with the image. Pass `audio` (ctx.audio) for the crash sound, or set `effects.audio` once.
// The fade layer sits above the error layer, so fading/cutting to black mid-error covers it.

const STYLE = `
.fx-fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; z-index: 36; }
.fx-glitch { position: fixed; inset: -3%; width: 106%; height: 106%; pointer-events: none; z-index: 35; display: none; }
#game.fx-crash-fallback { filter: grayscale(1) sepia(1) saturate(9) hue-rotate(-45deg) contrast(1.6) brightness(0.8); }
`;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene, uText;
uniform vec2 uRes;
uniform float uTime, uI, uSpike, uSeed, uPulse, uRoll, uTearY, uTearX, uBlack;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  float I = uI;
  float tick = floor(uTime * 24.0);

  // Vertical roll + one hard tear line (everything above it shoved sideways).
  uv.y = fract(uv.y + uRoll);
  uv.x += step(uTearY, uv.y) * uTearX;

  // Horizontal slice displacement: random bands jump left/right.
  float bandH = mix(0.09, 0.012, hash(vec2(tick, uSeed)));
  float band = floor(uv.y / bandH);
  float r = hash(vec2(band, tick + uSeed));
  float active = step(1.0 - (0.12 + 0.55 * uSpike) * I, r);
  uv.x += active * (hash(vec2(band, uSeed + 3.0)) - 0.5) * (0.06 + 0.3 * uSpike) * I;

  // Fine per-line jitter (analog sync wobble).
  float line = floor(uv.y * uRes.y * 0.5);
  uv.x += (hash(vec2(line, tick)) - 0.5) * 0.004 * I;

  // Chromatic aberration that spikes.
  float ca = (0.003 + 0.035 * uSpike) * I;
  vec2 d = vec2(1.0, 0.12) * ca;
  vec3 col = vec3(
    texture2D(uScene, uv + d).r,
    texture2D(uScene, uv).g,
    texture2D(uScene, uv - d).b);

  // Deep red grade: luminance into the red channel, crush the rest, pulse.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 graded = vec3(pow(lum, 1.2) * 1.55 + 0.05 * uPulse, pow(lum, 2.2) * 0.22, pow(lum, 2.2) * 0.18);
  col = mix(col, graded, clamp(I * 1.4, 0.0, 0.96));
  col *= 0.8 + 0.35 * uPulse * I;

  // Corrupted text, split into offset RGB copies.
  float tca = ca * 1.8 + 0.002 * I;
  vec4 tR = texture2D(uText, uv + vec2(tca, 0.0));
  vec4 tG = texture2D(uText, uv);
  vec4 tB = texture2D(uText, uv - vec2(tca, 0.0));
  col.r = mix(col.r, tR.r, tR.a);
  col.g = mix(col.g, tG.g, tG.a);
  col.b = mix(col.b, tB.b, tB.a);

  // Static: grain everywhere, full-noise bands during spikes.
  float n = hash(gl_FragCoord.xy + fract(uTime * 7.13) * 917.0);
  col += (n - 0.5) * (0.12 + 0.3 * uSpike) * I;
  float sband = step(1.0 - 0.06 * uSpike * I, hash(vec2(floor(uv.y * 60.0), tick + 9.0)));
  col = mix(col, vec3(n * 0.9, n * 0.25, n * 0.25), sband * 0.85);

  // Scanlines + vignette.
  col *= 0.82 + 0.18 * sin(gl_FragCoord.y * 3.14159);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 1.6 * I;

  col *= 1.0 - uBlack;
  gl_FragColor = vec4(col, 1.0);
}
`;

const FONT = 'ui-monospace, Menlo, Consolas, "Courier New", monospace';
const GLYPHS = '█▓▒░#@%&$0';

/** 0..1 intensity over the effect's life: fast ramp, hard peak (the cut happens at p = 1). */
function envelope(p) {
  if (p < 0.12) return 0.7 * (p / 0.12) ** 2;
  return Math.min(1, 0.7 + 0.3 * ((p - 0.12) / 0.55) ** 1.5);
}

function corrupt(text, amount) {
  return [...text].map((ch) => (Math.random() < amount ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : ch)).join('');
}

export class Effects {
  constructor(canvas) {
    this.canvas = canvas;
    this.audio = null; // optional default AudioManager for error()
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'fx-fade';
    document.body.appendChild(this.fadeEl);

    this._gl = null;      // lazily built WebGL overlay
    this._active = null;  // the running error, if any
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

  /** System-crash glitch over the game. Ramps up fast, peaks, then cuts out. Resolves at the cut. */
  error({ duration = 2500, text = 'ERROR!', audio = this.audio } = {}) {
    this.clear();
    const fx = this._ensureGL();
    const run = {
      start: performance.now(), duration, text, raf: 0, timer: 0, frames: 0, resolve: null, sound: null,
      words: [], spike: 0, freeze: 0, roll: 0, rollFrames: 0, tearY: 0.5, tearX: 0, black: 0, seed: Math.random() * 100,
    };
    this._active = run;
    run.sound = this._crashSound(audio, duration / 1000);

    if (fx) this._sizeOverlay(fx);
    else this.canvas.classList.add('fx-crash-fallback');

    const frame = (now) => {
      if (this._active !== run) return;
      const p = (now - run.start) / duration;
      if (p >= 1) { this._end(run); return; }
      this._step(run, envelope(p), now / 1000);
      if (fx && run.frames++ === 0) fx.el.style.display = 'block'; // only once a real frame exists
      run.raf = requestAnimationFrame(frame);
    };
    // Our frames must run *after* three.js renders so its drawing buffer is still readable.
    // three re-queues itself at the end of its callback, so if error() is called from a scene's
    // update, a rAF queued right now would run before it. Queue from a fresh task instead;
    // once behind it, each frame re-queues behind it too.
    run.timer = setTimeout(() => { run.raf = requestAnimationFrame(frame); }, 0);

    return new Promise((resolve) => { run.resolve = resolve; });
  }

  /** Cut any running error effect immediately (fade state is left alone). */
  clear() {
    if (this._active) this._end(this._active);
  }

  // ---------- internals ----------

  _end(run) {
    if (this._active !== run) return;
    this._active = null;
    clearTimeout(run.timer);
    cancelAnimationFrame(run.raf);
    run.sound?.stop();
    if (this._gl) {
      this._gl.el.style.display = 'none';
      this._gl.el.style.translate = '';
    }
    this.canvas.classList.remove('fx-crash-fallback');
    run.resolve?.();
  }

  _step(run, I, t) {
    // Random spikes, more often and harder as intensity climbs.
    run.spike *= 0.82;
    if (Math.random() < 0.05 + 0.3 * I * I) run.spike = Math.max(run.spike, 0.5 + Math.random() * 0.5);
    if (run.rollFrames > 0) run.rollFrames--; else run.roll = 0;
    if (Math.random() < 0.02 + 0.06 * I) { run.roll = (Math.random() - 0.5) * 0.25 * I; run.rollFrames = 1 + Math.floor(Math.random() * 3); }
    if (Math.random() < 0.15 * run.spike) { run.tearY = Math.random(); run.tearX = (Math.random() - 0.5) * 0.12 * I; }
    else if (Math.random() < 0.2) run.tearX = 0;
    run.black = Math.random() < 0.015 * I ? 0.92 : 0;

    const fx = this._gl;
    if (!fx) return;

    // Frame stutter: hold the last captured frame for a few frames.
    if (run.frames === 0) this._uploadScene(fx);
    else if (run.freeze > 0) run.freeze--;
    else if (Math.random() < 0.03 + 0.07 * I) run.freeze = 2 + Math.floor(Math.random() * 5);
    else this._uploadScene(fx);

    this._drawText(run, I, fx);

    // Shake the overlay itself (it's oversized so edges never show).
    const s = (3 + 14 * run.spike) * I;
    fx.el.style.translate = `${(Math.random() - 0.5) * s}px ${(Math.random() - 0.5) * s}px`;

    const { gl, u } = fx;
    gl.viewport(0, 0, fx.el.width, fx.el.height);
    gl.uniform2f(u.uRes, fx.el.width, fx.el.height);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uI, I);
    gl.uniform1f(u.uSpike, run.spike);
    gl.uniform1f(u.uSeed, run.seed + Math.floor(t * 6));
    gl.uniform1f(u.uPulse, Math.pow(0.5 + 0.5 * Math.sin(t * 9), 3));
    gl.uniform1f(u.uRoll, run.roll);
    gl.uniform1f(u.uTearY, run.tearY);
    gl.uniform1f(u.uTearX, run.tearX);
    gl.uniform1f(u.uBlack, run.black);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _drawText(run, I, fx) {
    const c = fx.text, g = fx.g;
    const W = c.width, H = c.height, unit = Math.min(W, H);
    g.clearRect(0, 0, W, H);

    // Population grows with intensity; words relocate now and then.
    const target = Math.floor(3 + I * 30);
    while (run.words.length < target) run.words.push(this._newWord(W, H, unit));
    for (let i = 0; i < run.words.length; i++) if (Math.random() < 0.04) run.words[i] = this._newWord(W, H, unit);

    // A huge central ERROR! once the crash is in full swing.
    const words = I > 0.6 ? [...run.words, { x: W / 2, y: H / 2, size: unit * 0.26, alpha: 0.95, color: '#ffffff', mode: 'slice', big: true }] : run.words;

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const w of words) {
      if (Math.random() < (w.big ? 0.18 : 0.14)) continue; // flicker
      const jit = w.size * (0.02 + 0.08 * run.spike);
      const x = w.x + (Math.random() - 0.5) * jit * 2;
      const y = w.y + (Math.random() - 0.5) * jit;
      const str = corrupt(run.text, 0.04 + 0.12 * run.spike);
      g.font = `800 ${w.size}px ${FONT}`;
      g.globalAlpha = w.alpha * (0.75 + Math.random() * 0.25);

      if (w.mode === 'stroke') {
        g.lineWidth = Math.max(1, w.size * 0.03);
        g.strokeStyle = w.color;
        g.strokeText(str, x, y);
      } else if (w.mode === 'slice') {
        // Horizontal strips, each shoved sideways.
        const strips = 4 + Math.floor(Math.random() * 4);
        const top = y - w.size * 0.6, h = (w.size * 1.2) / strips;
        const tw = g.measureText(str).width + w.size;
        g.fillStyle = w.color;
        for (let k = 0; k < strips; k++) {
          g.save();
          g.beginPath();
          g.rect(x - tw / 2, top + k * h, tw, h + 0.5);
          g.clip();
          const dx = Math.random() < 0.45 ? (Math.random() - 0.5) * w.size * (0.3 + run.spike) : 0;
          g.fillText(str, x + dx, y);
          g.restore();
        }
      } else {
        g.fillStyle = w.color;
        g.fillText(str, x, y);
      }
    }
    g.globalAlpha = 1;

    const { gl } = fx;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fx.textTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }

  _newWord(W, H, unit) {
    const r = Math.random();
    const size = unit * (r < 0.55 ? 0.03 + Math.random() * 0.04 : r < 0.9 ? 0.07 + Math.random() * 0.08 : 0.16 + Math.random() * 0.14);
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      size,
      alpha: size > unit * 0.15 ? 0.15 + Math.random() * 0.3 : 0.35 + Math.random() * 0.65,
      color: Math.random() < 0.6 ? '#ffffff' : '#ff2a2a',
      mode: ['fill', 'fill', 'stroke', 'slice'][Math.floor(Math.random() * 4)],
    };
  }

  _uploadScene(fx) {
    // Only valid after three.js has rendered this frame (see the rAF note in error()).
    const { gl } = fx;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fx.sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
  }

  _sizeOverlay(fx) {
    const w = this.canvas.width || window.innerWidth, h = this.canvas.height || window.innerHeight;
    if (fx.el.width !== w || fx.el.height !== h) { fx.el.width = w; fx.el.height = h; }
    const tw = window.innerWidth, th = window.innerHeight;
    if (fx.text.width !== tw || fx.text.height !== th) { fx.text.width = tw; fx.text.height = th; }
  }

  _ensureGL() {
    if (this._gl !== null) return this._gl || null;
    this._gl = false;
    const el = document.createElement('canvas');
    el.className = 'fx-glitch';
    const gl = el.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) return null;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      console.warn('effects: glitch shader failed, using CSS fallback', e);
      return null;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const makeTex = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      return t;
    };
    const sceneTex = makeTex(0), textTex = makeTex(1);

    const u = {};
    for (const name of ['uScene', 'uText', 'uRes', 'uTime', 'uI', 'uSpike', 'uSeed', 'uPulse', 'uRoll', 'uTearY', 'uTearX', 'uBlack']) {
      u[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform1i(u.uScene, 0);
    gl.uniform1i(u.uText, 1);

    const text = document.createElement('canvas');
    document.body.appendChild(el);
    this._gl = { el, gl, u, sceneTex, textTex, text, g: text.getContext('2d') };
    return this._gl;
  }

  /** Harsh digital crash: bit-crushed noise, stuttering square tones, sub hit, hard cut at the end. */
  _crashSound(audio, dur) {
    const ac = audio?.ctx;
    if (!ac || ac.state === 'closed') return null;
    const t0 = ac.currentTime, end = t0 + dur;

    const out = ac.createGain();
    out.gain.value = 0.35;
    out.connect(audio.master);
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.max(-1, Math.min(1, x * 6));
    }
    shaper.curve = curve;
    shaper.connect(out);

    // Bit-crushed noise: random values held for random sample counts.
    const len = Math.ceil(ac.sampleRate * (dur + 0.1));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0, hold = 0, v = 0; i < len; i++) {
      if (hold-- <= 0) { v = Math.round((Math.random() * 2 - 1) * 4) / 4; hold = 1 + Math.floor(Math.random() * 14); }
      data[i] = v;
    }
    const noise = ac.createBufferSource();
    noise.buffer = buf;
    const noiseGain = ac.createGain();
    noise.connect(noiseGain).connect(shaper);

    const osc = ac.createOscillator();
    osc.type = 'square';
    const oscGain = ac.createGain();
    osc.connect(oscGain).connect(shaper);

    const sub = ac.createOscillator();
    const subGain = ac.createGain();
    sub.frequency.setValueAtTime(110, t0);
    sub.frequency.exponentialRampToValueAtTime(28, t0 + 0.6);
    subGain.gain.setValueAtTime(0.9, t0);
    subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
    sub.connect(subGain).connect(out);

    // Chop everything into stuttering on/off gates that tighten as intensity rises.
    noiseGain.gain.setValueAtTime(0, t0);
    oscGain.gain.setValueAtTime(0, t0);
    for (let t = 0; t < dur; ) {
      const I = envelope(t / dur);
      noiseGain.gain.setValueAtTime(Math.random() < 0.45 + 0.5 * I ? 0.15 + 0.35 * I : 0.01, t0 + t);
      oscGain.gain.setValueAtTime(Math.random() < 0.3 + 0.4 * I ? 0.06 + 0.14 * I : 0, t0 + t);
      osc.frequency.setValueAtTime(Math.random() < 0.3 ? 40 + Math.random() * 90 : 180 + Math.random() * 2600, t0 + t);
      t += 0.015 + Math.random() * 0.07 * (1.2 - I);
    }
    // Abrupt cut.
    out.gain.setValueAtTime(0.35, end - 0.002);
    out.gain.setValueAtTime(0, end);

    const nodes = [noise, osc, sub];
    nodes.forEach((n) => { n.start(t0); n.stop(end + 0.05); });
    return {
      stop() {
        out.gain.cancelScheduledValues(ac.currentTime);
        out.gain.setValueAtTime(0, ac.currentTime);
        nodes.forEach((n) => { try { n.stop(); } catch {} });
      },
    };
  }
}
