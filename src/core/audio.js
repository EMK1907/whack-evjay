// Minimal Web Audio wrapper. unlock() is called on the first click (browser autoplay rules).
//   ctx.audio.tone(220, 0.3, { type: 'square' });  ctx.audio.glitch();
//   const music = await ctx.audio.play('assets/hum.mp3', { loop: true, volume: 0.5 }); music?.stop();
// All playing files are stopped on scene change.

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._buffers = new Map();
    this._sources = new Set();
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      // master → compressor → makeup gain → speakers: lifts quiet sounds, stops loud ones clipping.
      this.master = this.ctx.createGain();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const makeup = this.ctx.createGain();
      makeup.gain.value = 2.2;
      this.master.connect(comp).connect(makeup).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq = 440, duration = 0.2, { type = 'sine', volume = 0.2 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration);
  }

  noise(duration = 0.3, { volume = 0.2 } = {}) {
    if (!this.ctx) return;
    const len = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buf;
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);
    src.connect(gain).connect(this.master);
    src.start();
  }

  /** Harsh digital burst — pairs with effects.error(). */
  glitch() {
    this.noise(0.4, { volume: 0.25 });
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.tone(80 + Math.random() * 900, 0.08, { type: 'square', volume: 0.12 }), i * 60);
    }
  }

  async play(url, { loop = false, volume = 1 } = {}) {
    if (!this.ctx) return null;
    try {
      let buf = this._buffers.get(url);
      if (!buf) {
        const res = await fetch(url);
        buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this._buffers.set(url, buf);
      }
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      src.buffer = buf;
      src.loop = loop;
      gain.gain.value = volume;
      src.connect(gain).connect(this.master);
      src.start();
      this._sources.add(src);
      src.onended = () => this._sources.delete(src);
      return { stop: () => { try { src.stop(); } catch {} }, gain };
    } catch (e) {
      console.warn(`audio: failed to play ${url}`, e);
      return null;
    }
  }

  stopAll() {
    for (const s of this._sources) { try { s.stop(); } catch {} }
    this._sources.clear();
  }
}
