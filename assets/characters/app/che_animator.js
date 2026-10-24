// CHE character animator: one state machine over the clips a GLB carries, with crossfades, an upper-body
// gesture layer, non-repeating idle, speed-matched gait, speech-timed lip sync, listening behaviour, expression
// states and the Animation & Personality settings. Presentation only: nothing here grants or changes a permission.
//
// Works with the crew GLBs the app ships today (12 clips, bones head/neck/eye.L/eye.R, morphs blink/mouth_open/
// mouth_wide/mouth_round) and with the reference build (CMU motion library, MPFB bone names, the viseme and
// expression morphs). Anything a model lacks is skipped, never faked.
(function (global) {
  'use strict';
  const THREE = global.THREE;

  const BONES = {
    head: ['head', 'Head'], neck: ['neck', 'neck_01', 'Neck'], eyeL: ['eye.L', 'eye_l', 'EyeL'], eyeR: ['eye.R', 'eye_r', 'EyeR'],
    spine: ['spine', 'spine_01', 'Spine'], chest: ['chest', 'spine_03', 'Chest'], pelvis: ['pelvis', 'Hips', 'hips'],
    shoulderL: ['shoulder.L', 'clavicle_l'], shoulderR: ['shoulder.R', 'clavicle_r'],
    handL: ['hand.L', 'hand_l'], handR: ['hand.R', 'hand_r'],
  };
  // Bones the gesture layer may drive (everything from the spine up). Lower body stays with the base clip.
  const UPPER = /^(spine|chest|neck|head|shoulder|upper_arm|forearm|hand|finger|thumb|index|middle|ring|pinky|clavicle|upperarm|lowerarm|spine_0[1-3]|neck_01)/i;
  // Lip sync: one mouth shape per sound class, as weights on the morphs the model has.
  const VISEMES = {
    rest: {}, aa: { mouth_open: 0.75, mouth_wide: 0.15 }, ee: { mouth_open: 0.25, mouth_wide: 0.7 },
    oh: { mouth_open: 0.55, mouth_round: 0.8 }, oo: { mouth_open: 0.3, mouth_round: 0.95 },
    mm: { mouth_open: 0.0 }, fv: { viseme_fv: 0.8, mouth_open: 0.1 }, ss: { viseme_s: 0.8, mouth_open: 0.12, mouth_wide: 0.3 },
    th: { mouth_open: 0.2, mouth_wide: 0.3 }, l: { mouth_open: 0.35 },
  };
  // Personality states: visibly different faces, built only from morphs the model carries.
  const MOODS = {
    neutral: {},
    happy: { smile: 0.75, eyes_wide: 0.1, brow_up_l: 0.1, brow_up_r: 0.1 },
    thinking: { brow_up_l: 0.5, squint: 0.3, mouth_round: 0.15, brow_furrow: 0.25 },
    focused: { squint: 0.4, brow_furrow: 0.45, mouth_wide: 0.05 },
    serious: { brow_furrow: 0.5, mouth_frown: 0.25, squint: 0.15 },
    alert: { eyes_wide: 0.8, brow_up_l: 0.6, brow_up_r: 0.6, mouth_open: 0.08 },
    playful: { smile: 0.6, brow_up_r: 0.5, squint: 0.2, mouth_wide: 0.1 },
    confident: { smile: 0.3, brow_outer_up: 0.2, squint: 0.12 },
    laugh: { smile: 1.0, mouth_open: 0.45, squint: 0.6, eyes_wide: 0.0 },
    skeptical: { brow_up_r: 0.7, squint: 0.4, mouth_frown: 0.2, nose_sneer: 0.15 },
    surprised: { eyes_wide: 1.0, brow_up_l: 0.9, brow_up_r: 0.9, mouth_open: 0.5, mouth_round: 0.4 },
    concerned: { brow_furrow: 0.45, brow_up_l: 0.4, brow_up_r: 0.4, mouth_frown: 0.5 },
  };
  const PRESETS = {
    natural: { fluidity: 0.6, gesture: 0.6, expressiveness: 0.6, walk: 'graceful', idleVariety: 0.6, eyeContact: 0.7, speed: 1.0, hairCloth: 0.6 },
    professional: { fluidity: 0.7, gesture: 0.35, expressiveness: 0.45, walk: 'plain', idleVariety: 0.4, eyeContact: 0.85, speed: 1.0, hairCloth: 0.4 },
    expressive: { fluidity: 0.55, gesture: 0.95, expressiveness: 0.95, walk: 'confident', idleVariety: 0.9, eyeContact: 0.7, speed: 1.05, hairCloth: 0.8 },
    cinematic: { fluidity: 0.9, gesture: 0.7, expressiveness: 0.8, walk: 'graceful', idleVariety: 0.7, eyeContact: 0.6, speed: 0.92, hairCloth: 1.0 },
  };
  // How each clip is played: loop, one-shot (returns to the state before it), seated base.
  const ONE_SHOT = new Set(['sit', 'stand', 'wave', 'greet', 'celebrate', 'elated', 'laugh', 'surprise', 'nod', 'shake', 'turn_left', 'turn_right']);
  const SEATED = new Set(['sit', 'type']);
  const GESTURE = new Set(['talk', 'talk_story', 'gesture_chat', 'think']);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  // Small deterministic noise (sum of sines), so idle motion never repeats on a visible period.
  const noise = (t, s) => 0.5 * Math.sin(t * 0.71 + s) + 0.3 * Math.sin(t * 1.93 + s * 1.7) + 0.2 * Math.sin(t * 0.23 + s * 2.3);

  function findBone(skeleton, names) { for (const n of names) { const b = skeleton.getBoneByName(n); if (b) return b; } return null; }

  // Text → viseme schedule. Used when the voice engine gives no word timings: syllables spread over the audio
  // duration, so the mouth opens on the vowels of the words actually spoken and closes at the end of the audio.
  function visemesFromText(text, durationMs) {
    const words = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
    const units = [];
    for (const w of words) {
      const parts = w.match(/[aeiouy]+|[^aeiouy]+/g) || [];
      for (const p of parts) {
        if (/^[aeiouy]+$/.test(p)) units.push({ v: /^(o|oo|ou|ow)$/.test(p) ? 'oo' : /^(a|ah|aw)$/.test(p) ? 'aa' : /^(e|ee|i|y|ea)$/.test(p) ? 'ee' : 'oh', w: 1.0 });
        else if (/^[mbp]+$/.test(p)) units.push({ v: 'mm', w: 0.6 });
        else if (/^[fv]+$/.test(p)) units.push({ v: 'fv', w: 0.6 });
        else if (/^(s|z|sh|ch|c|x)+$/.test(p)) units.push({ v: 'ss', w: 0.55 });
        else if (/^(th|d|t|n)+$/.test(p)) units.push({ v: 'th', w: 0.45 });
        else units.push({ v: 'l', w: 0.4 });
      }
      units.push({ v: 'rest', w: 0.3 });                       // the gap between words
    }
    if (!units.length) return [];
    const total = units.reduce((s, u) => s + (u.v === 'rest' ? 0.45 : u.v === 'aa' || u.v === 'oh' || u.v === 'oo' || u.v === 'ee' ? 1.0 : 0.6), 0);
    const scale = Math.max(1, durationMs) / total;
    let t = 0;
    return units.map((u) => { const d = (u.v === 'rest' ? 0.45 : /^(aa|oh|oo|ee)$/.test(u.v) ? 1.0 : 0.6) * scale; const out = { t, d, v: u.v, w: u.w }; t += d; return out; });
  }

  class CheAnimator {
    constructor(root, clips, options = {}) {
      this.root = root;
      this.mixer = new THREE.AnimationMixer(root);
      this.actions = {};
      this.upper = {};
      this.meta = options.meta || {};                           // {clip: {ground_speed_mps}} from the build report
      this.settings = Object.assign({}, PRESETS.natural, options.settings || {});
      this.seed = options.seed || 1;
      this.skeleton = null;
      this.morphs = [];
      this.bones = {};
      root.traverse((o) => {
        if (o.isSkinnedMesh && o.skeleton && !this.skeleton) this.skeleton = o.skeleton;
        if (o.isMesh && o.morphTargetDictionary) this.morphs.push(o);
      });
      if (this.skeleton) for (const [k, names] of Object.entries(BONES)) this.bones[k] = findBone(this.skeleton, names);
      for (const clip of clips) {
        this.actions[clip.name] = this.mixer.clipAction(clip);
        if (GESTURE.has(clip.name)) {
          const tracks = clip.tracks.filter((t) => UPPER.test(t.name.split('.')[0]));
          if (tracks.length) {
            const sub = new THREE.AnimationClip(`${clip.name}:upper`, clip.duration, tracks);
            this.upper[clip.name] = this.mixer.clipAction(sub);
          }
        }
      }
      this.base = null; this.baseName = null;
      this.gesture = null; this.gestureName = null;
      this.oneShot = null; this.returnTo = 'idle';
      this.state = 'idle';
      this.seated = false;
      this.speed = 0; this.wantSpeed = 0; this.heading = 0; this.wantHeading = 0;
      this.idleTimer = 0; this.idleClip = 'idle';
      this.blink = { t: -1, next: 2 + Math.random() * 3, v: 0 };
      this.look = { yaw: 0, pitch: 0, target: null, saccadeT: 0, sx: 0, sy: 0 };
      this.mood = 'neutral'; this.face = {}; this.faceGoal = {};
      this.speech = null; this.listening = false; this.mouth = {};
      this.time = 0;
      this.posture = { sway: 0, shift: 0, breathe: 0 };
      this.events = options.onEvent || (() => {});
      this.setBase(this.actions.idle ? 'idle' : Object.keys(this.actions)[0], 0);
    }

    // ---- settings and presets (presentation only)
    configure(patch) { Object.assign(this.settings, patch || {}); return this.settings; }
    preset(name) { const p = PRESETS[name]; if (p) Object.assign(this.settings, p); return Boolean(p); }
    get fade() { return lerp(0.12, 0.45, this.settings.fluidity); }
    has(name) { return Boolean(this.actions[name]); }
    get clips() { return Object.keys(this.actions); }

    // ---- base layer: one looping full-body clip at a time, crossfaded
    setBase(name, fade = this.fade) {
      const next = this.actions[name];
      if (!next || next === this.base) return false;
      next.reset(); next.enabled = true; next.setEffectiveWeight(1);
      next.setLoop(ONE_SHOT.has(name) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = ONE_SHOT.has(name);
      if (this.base) this.base.crossFadeTo(next, fade, false); else next.play();
      next.play();
      this.base = next; this.baseName = name;
      return true;
    }
    // ---- gesture layer: upper-body only, weighted by gesture intensity, over any base
    setGesture(name, weight = 1) {
      const next = name ? (this.upper[name] || null) : null;
      if (this.gesture && this.gesture !== next) { this.gesture.fadeOut(this.fade); }
      if (next && next !== this.gesture) { next.reset(); next.setLoop(THREE.LoopRepeat, Infinity); next.setEffectiveWeight(weight * this.settings.gesture); next.fadeIn(this.fade).play(); }
      else if (next) next.setEffectiveWeight(weight * this.settings.gesture);
      this.gesture = next; this.gestureName = next ? name : null;
    }
    // ---- one-shots return to the state they interrupted
    playOnce(name) {
      const act = this.actions[name];
      if (!act) return false;
      this.returnTo = this.seated ? 'sit' : 'idle';
      this.setBase(name);
      this.oneShot = act;
      this.state = name;
      return true;
    }

    // ---- high level states, from real activity only
    idle() { if (this.seated) return this.sitDown(); this.state = 'idle'; this.setGesture(null); this.setBase(this.idleClip); }
    sitDown() {
      if (!this.actions.sit) return false;
      this.seated = true; this.state = 'seated';
      if (this.baseName !== 'sit' && this.baseName !== 'type') { this.setBase('sit'); this.oneShot = this.actions.sit; this.returnTo = 'sit'; }
      return true;
    }
    standUp() {
      if (!this.seated) return false;
      this.seated = false; this.state = 'standing';
      if (this.actions.stand) { this.setBase('stand'); this.oneShot = this.actions.stand; this.returnTo = 'idle'; } else this.idle();
      return true;
    }
    type() { if (!this.actions.type) return false; this.seated = true; this.state = 'typing'; this.setGesture(null); this.setBase('type'); return true; }
    think() { this.state = 'thinking'; this.setMood('thinking'); if (this.upper.think) this.setGesture('think', 0.8); else if (!this.seated) this.setBase(this.actions.think ? 'think' : this.idleClip); }
    celebrate() { this.setMood('happy'); return this.playOnce(this.actions.celebrate ? 'celebrate' : 'wave'); }
    wave() { return this.playOnce(this.actions.wave ? 'wave' : 'greet'); }
    greet() { return this.playOnce(this.actions.greet ? 'greet' : 'wave'); }
    laugh() { this.setMood('laugh'); return this.playOnce(this.actions.laugh ? 'laugh' : 'celebrate'); }
    surprise() { this.setMood('surprised'); return this.playOnce(this.actions.surprise ? 'surprise' : 'wave'); }

    // Walking: the app gives a speed (m/s) and a heading; the gait clip plays at the matching stride rate.
    move(speed, heading) {
      this.wantSpeed = Math.max(0, speed) * this.settings.speed;
      if (speed > 0.01) this.wantHeading = heading;
    }
    walkClip() {
      const pick = { graceful: 'walk', confident: 'walk_confident', plain: 'walk_plain' }[this.settings.walk] || 'walk';
      return this.actions[pick] ? pick : 'walk';
    }

    // Speaking: real timing from the voice engine (durationMs, optional word/viseme marks); the mouth closes when
    // the audio ends, never on a random timer. Listening: eye contact, small nods and tilts, no mouth movement.
    speak({ text = '', durationMs = 0, visemes = null, startedAt = null } = {}) {
      const sched = Array.isArray(visemes) && visemes.length ? visemes : visemesFromText(text, durationMs);
      this.speech = { t0: startedAt != null ? startedAt : this.time * 1000, dur: Math.max(50, durationMs), sched, i: 0, stress: 0 };
      this.state = this.seated ? 'seated_talking' : 'talking';
      this.listening = false;
      const clip = this.upper.talk ? 'talk' : this.upper.gesture_chat ? 'gesture_chat' : null;
      if (clip) this.setGesture(clip, 0.9); else if (this.actions.talk && !this.seated) this.setBase('talk');
      return sched.length;
    }
    stopSpeaking() { this.speech = null; this.setGesture(null); if (this.state === 'talking' || this.state === 'seated_talking') this.state = this.seated ? 'seated' : 'idle'; if (!this.seated && this.baseName === 'talk') this.setBase(this.idleClip); }
    listen(on) { this.listening = Boolean(on); if (on) { this.speech = null; this.setGesture(null); this.state = this.seated ? 'seated_listening' : 'listening'; } else if (this.state.endsWith('listening')) this.state = this.seated ? 'seated' : 'idle'; }
    setMood(name) { if (!MOODS[name]) return false; this.mood = name; this.faceGoal = MOODS[name]; return true; }
    lookAt(v) { this.look.target = v || null; }

    // ---- per frame
    update(dt, cameraPos) {
      this.time += dt;
      const t = this.time, s = this.settings;
      // Locomotion: smooth acceleration, heading turns at a bounded rate, gait speed from the clip's measured stride.
      const accel = lerp(6, 2.5, s.fluidity);
      this.speed += clamp(this.wantSpeed - this.speed, -accel * dt, accel * dt);
      let dh = Math.atan2(Math.sin(this.wantHeading - this.heading), Math.cos(this.wantHeading - this.heading));
      this.heading += clamp(dh, -4.5 * dt, 4.5 * dt);
      const moving = this.speed > 0.05 && !this.seated && !this.oneShot;
      if (moving) {
        const run = this.speed > 1.3 && this.actions.run;
        const name = run ? 'run' : this.walkClip();
        if (this.baseName !== name) { this.setBase(name, 0.2); this.state = run ? 'running' : 'walking'; }
        const ground = (this.meta[name] && this.meta[name].ground_speed_mps) || (run ? 2.2 : 1.05);
        this.base.timeScale = clamp(this.speed / ground, 0.6, 1.6);
      } else if (this.state === 'walking' || this.state === 'running') {
        this.state = 'idle';
        this.setBase(this.idleClip, 0.25);
      }
      // One-shots: when finished, return to the interrupted state.
      if (this.oneShot && (this.oneShot.paused || (this.oneShot.time >= this.oneShot.getClip().duration - 1e-3 && !this.oneShot.isRunning()) || this.oneShot.time >= this.oneShot.getClip().duration - 0.05)) {
        const back = this.returnTo; this.oneShot = null;
        if (back === 'sit' && this.actions.sit) { this.seated = true; if (this.baseName !== 'sit') this.setBase('sit'); this.actions.sit.paused = false; this.actions.sit.time = this.actions.sit.getClip().duration - 0.001; this.state = 'seated'; }
        else { this.seated = false; this.state = 'idle'; this.setBase(this.idleClip); }
        if (this.mood === 'laugh' || this.mood === 'surprised') this.setMood('neutral');
      }
      // Idle variety: switch between the idle takes at irregular intervals; weight shifts and breathing on top.
      if (this.state === 'idle' && !moving) {
        this.idleTimer -= dt;
        if (this.idleTimer <= 0) {
          const takes = ['idle', 'idle_graceful', 'idle_relaxed'].filter((n) => this.actions[n]);
          if (takes.length > 1 && Math.random() < s.idleVariety) { const next = takes[(takes.indexOf(this.idleClip) + 1 + Math.floor(Math.random() * (takes.length - 1))) % takes.length]; this.idleClip = next; this.setBase(next, 0.6); }
          this.idleTimer = lerp(14, 6, s.idleVariety) + Math.random() * 6;
        }
      }
      this.mixer.update(dt);
      this.applyPosture(dt, t, moving);
      this.applyFace(dt, t, cameraPos);
    }

    // Procedural layers added after the mixer wrote the pose: breathing, weight shifts, head tilts, listening nods.
    applyPosture(dt, t, moving) {
      const s = this.settings, b = this.bones, n = this.seed;
      const breathe = 0.5 + 0.5 * Math.sin(t * (moving ? 2.6 : 1.7) + n);
      if (b.chest) b.chest.rotation.x += 0.012 * breathe;
      if (b.spine && !moving) b.spine.rotation.z += 0.015 * noise(t * 0.35, n) * s.idleVariety;
      if (b.spine && !moving && !this.seated) b.spine.rotation.x += 0.01 * noise(t * 0.2, n + 3);
      if (b.pelvis && !moving && !this.seated) b.pelvis.position.x += 0.012 * noise(t * 0.17, n + 7) * s.idleVariety;
      if (b.head) {
        let tilt = 0.035 * noise(t * 0.3, n + 11) * s.idleVariety;
        if (this.listening) tilt += 0.12 * Math.sin(t * 0.9 + n);                                   // attentive tilt
        if (this.listening && Math.sin(t * 1.4) > 0.9) b.head.rotation.x += 0.05 * Math.sin(t * 9);   // a small nod
        b.head.rotation.z += tilt;
        if (this.speech) b.head.rotation.x += 0.04 * this.speech.stress;                            // nods on stressed syllables
      }
      if (b.shoulderL && !moving) b.shoulderL.rotation.z += 0.01 * breathe;
      if (b.shoulderR && !moving) b.shoulderR.rotation.z -= 0.01 * breathe;
    }

    applyFace(dt, t, cameraPos) {
      const s = this.settings;
      // Blink: irregular interval, quicker when speaking, with a double blink now and then.
      this.blink.next -= dt;
      if (this.blink.next <= 0) { this.blink.t = 0; this.blink.next = (this.speech ? 1.8 : 2.6) + Math.random() * 3.5 + (Math.random() < 0.15 ? -1.9 : 0); }
      if (this.blink.t >= 0) { this.blink.t += dt; const k = this.blink.t / 0.15; this.blink.v = k < 0.5 ? k * 2 : Math.max(0, 2 - k * 2); if (k >= 1) { this.blink.t = -1; this.blink.v = 0; } }
      // Lip sync from the schedule: the current viseme, eased, and silence after the audio ends.
      const goal = {};
      if (this.speech) {
        const ms = t * 1000 - this.speech.t0;
        if (ms > this.speech.dur + 120) this.stopSpeaking();
        else {
          const sch = this.speech.sched;
          while (this.speech.i < sch.length - 1 && sch[this.speech.i + 1].t <= ms) this.speech.i += 1;
          const cur = sch[this.speech.i];
          if (cur && ms >= cur.t) { for (const [m, w] of Object.entries(VISEMES[cur.v] || {})) goal[m] = w * cur.w; this.speech.stress = cur.v === 'aa' || cur.v === 'oh' ? 1 : 0; }
          else this.speech.stress = 0;
          // Brows lift a little on emphasis, scaled by expressiveness.
          if (this.speech.stress) { goal.brow_up_l = (goal.brow_up_l || 0) + 0.25 * s.expressiveness; goal.brow_up_r = (goal.brow_up_r || 0) + 0.25 * s.expressiveness; }
        }
      }
      for (const [m, w] of Object.entries(this.faceGoal)) goal[m] = Math.max(goal[m] || 0, w * s.expressiveness);
      const names = new Set([...Object.keys(goal), ...Object.keys(this.face)]);
      for (const m of names) { const g = goal[m] || 0; const k = Math.min(1, dt * (this.speech ? 22 : 8)); this.face[m] = lerp(this.face[m] || 0, g, k); }
      for (const mesh of this.morphs) {
        const d = mesh.morphTargetDictionary;
        for (const [m, v] of Object.entries(this.face)) if (d[m] !== undefined) mesh.morphTargetInfluences[d[m]] = v;
        if (d.blink !== undefined) mesh.morphTargetInfluences[d.blink] = Math.max(this.blink.v, (this.face.squint || 0) * 0.35);
      }
      // Eye contact: head and eyes toward the target, with saccades; strength from the Eye Contact setting.
      const head = this.bones.head;
      const target = this.look.target || cameraPos;
      if (!head || !target) return;
      this.root.updateMatrixWorld(true);
      const v = new THREE.Vector3(); head.getWorldPosition(v);
      const d = target.clone().sub(v).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()).invert());
      const contact = this.listening ? Math.min(1, s.eyeContact + 0.2) : this.speech ? s.eyeContact * 0.85 : s.eyeContact;
      let yaw = clamp(Math.atan2(d.x, d.z), -0.9, 0.9) * contact;
      let pitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.35, 0.35) * contact;
      this.look.saccadeT -= dt;
      if (this.look.saccadeT <= 0) { this.look.saccadeT = 0.6 + Math.random() * 2.4; this.look.sx = (Math.random() - 0.5) * 0.12; this.look.sy = (Math.random() - 0.5) * 0.06; }
      const k = Math.min(1, dt * lerp(7, 3.5, s.fluidity));
      this.look.yaw += (yaw - this.look.yaw) * k; this.look.pitch += (pitch - this.look.pitch) * k;
      const e = new THREE.Euler(), q = new THREE.Quaternion();
      head.quaternion.multiply(q.setFromEuler(e.set(-this.look.pitch * 0.55, this.look.yaw * 0.6, 0)));
      if (this.bones.neck) this.bones.neck.quaternion.multiply(q.setFromEuler(e.set(-this.look.pitch * 0.2, this.look.yaw * 0.25, 0)));
      for (const eye of [this.bones.eyeL, this.bones.eyeR]) if (eye) eye.quaternion.multiply(q.setFromEuler(e.set(-this.look.pitch * 0.8 + this.look.sy, this.look.yaw * 0.8 + this.look.sx, 0)));
    }

    get snapshot() {
      return { state: this.state, base: this.baseName, gesture: this.gestureName, seated: this.seated, speed: Number(this.speed.toFixed(3)), mood: this.mood, speaking: Boolean(this.speech), listening: this.listening, blink: Number(this.blink.v.toFixed(2)), mouth: Number((this.face.mouth_open || 0).toFixed(2)), settings: Object.assign({}, this.settings), clips: this.clips.length };
    }
  }

  CheAnimator.PRESETS = PRESETS;
  CheAnimator.MOODS = Object.keys(MOODS);
  CheAnimator.visemesFromText = visemesFromText;
  global.CheAnimator = CheAnimator;
})(window);
