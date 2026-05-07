// Three.js scene for the procedural / GLB avatar.
//
// Stylized cartoon character: round head, two-layer hair (a "bob" wig
// behind the head + bangs across the forehead), big soft eyes, smile.
//
// Mouth animation is driven by `setSpeaking(bool)`. We synthesize a
// natural-looking amplitude curve while speaking — no audio analysis
// required, so this works with any TTS (browser SpeechSynthesis,
// Gemini TTS, ElevenLabs, etc.).

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MOUTH_PATTERNS = [/jawopen/i, /mouthopen/i, /viseme_aa/i, /viseme_o/i, /viseme_e/i];
const SMILE_PATTERNS = [/mouthsmile/i, /viseme_e/i];
const BLINK_PATTERNS = [/eyeblinkleft/i, /eyeblinkright/i, /blink/i];

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
    this.camera.position.set(0, 1.5, 3.6);
    this.camera.lookAt(0, 1.52, 0);

    this._setupLights();
    this._setupBackdrop();

    this.mixer = null;
    this.clock = new THREE.Clock();
    this.morphTargets = [];
    this.head = null;
    this.lipLevel = 0;
    this.lipTarget = 0;
    this.lastBlink = 0;
    this.blinkPhase = 0;
    this.idle = 0;
    this.modelRoot = null;
    this._speaking = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._onResize();
    this._tick = this._tick.bind(this);
    this.renderer.setAnimationLoop(this._tick);
  }

  setSpeaking(on) { this._speaking = !!on; }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xc6d6ff, 0x331a55, 0.7);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff0d8, 1.6);
    key.position.set(2.2, 3, 2.5);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8aa6ff, 0.55);
    fill.position.set(-2.5, 1.6, 1.6);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xff7ad9, 0.7);
    rim.position.set(-1.0, 2.4, -2.4);
    this.scene.add(rim);
  }

  _setupBackdrop() {
    const geo = new THREE.SphereGeometry(20, 32, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x221a48) },
        bottomColor: { value: new THREE.Color(0x07070f) },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vWorld = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vWorld; uniform vec3 topColor; uniform vec3 bottomColor;
        void main(){ float h = normalize(vWorld).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0); }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  async loadModel(url) {
    if (!url) {
      this._buildFallback();
      return;
    }
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      this.modelRoot = gltf.scene;
      this.scene.add(this.modelRoot);
      this._scanMorphs(this.modelRoot);
      this._findHead(this.modelRoot);
      if (gltf.animations && gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(this.modelRoot);
        const idle = gltf.animations.find((a) => /idle/i.test(a.name)) || gltf.animations[0];
        this.mixer.clipAction(idle).play();
      }
      this._frameModel();
    } catch (err) {
      console.warn("Avatar GLB failed to load, using fallback:", err);
      this._buildFallback();
    }
  }

  _scanMorphs(root) {
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.morphTargetDictionary) return;
      const dict = obj.morphTargetDictionary;
      for (const name of Object.keys(dict)) {
        const idx = dict[name];
        if (MOUTH_PATTERNS.some((r) => r.test(name))) {
          this.morphTargets.push({ mesh: obj, index: idx, kind: "mouth" });
        } else if (BLINK_PATTERNS.some((r) => r.test(name))) {
          this.morphTargets.push({ mesh: obj, index: idx, kind: "blink" });
        } else if (SMILE_PATTERNS.some((r) => r.test(name))) {
          this.morphTargets.push({ mesh: obj, index: idx, kind: "smile" });
        }
      }
    });
  }

  _findHead(root) {
    root.traverse((obj) => {
      if (obj.isBone && /head/i.test(obj.name) && !this.head) this.head = obj;
    });
  }

  _frameModel() {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const target = new THREE.Vector3(center.x, box.min.y + size.y * 0.85, center.z);
    const distance = Math.max(size.y, size.x) * 1.6;
    this.camera.position.set(target.x, target.y, target.z + distance);
    this.camera.lookAt(target);
  }

  _buildFallback() {
    // ── Materials ───────────────────────────────────────────────────
    const skin = new THREE.MeshStandardMaterial({ color: 0xf3c9a4, roughness: 0.65, metalness: 0.0 });
    const blush = new THREE.MeshStandardMaterial({ color: 0xe78a78, roughness: 0.7, transparent: true, opacity: 0.4 });
    const hair = new THREE.MeshStandardMaterial({ color: 0xc89455, roughness: 0.55, metalness: 0.05 });
    const sclera = new THREE.MeshStandardMaterial({ color: 0xfafaf6, roughness: 0.2 });
    const iris = new THREE.MeshStandardMaterial({ color: 0x7aa66c, roughness: 0.25, metalness: 0.1 });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 0.15 });
    const highlight = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const lip = new THREE.MeshStandardMaterial({ color: 0xc06c70, roughness: 0.4 });
    const innerMouth = new THREE.MeshStandardMaterial({ color: 0x3a0a14, roughness: 0.85 });
    const brow = new THREE.MeshStandardMaterial({ color: 0x6b3f1c, roughness: 0.75 });
    const lidLine = new THREE.MeshStandardMaterial({ color: 0x5a3220, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x8a4a55, roughness: 0.7 });

    // ── Head group: features attach here so the head rotates as one. ─
    const headGroup = new THREE.Group();
    headGroup.position.y = 1.55;

    // Round head — soft, slightly taller than wide.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 64, 64), skin);
    head.scale.set(1.0, 1.1, 1.0);
    headGroup.add(head);

    // ── Hair: BACK layer (the "bob" — covers back + sides + hangs to chin)
    // A large sphere positioned slightly behind the face. The face sphere
    // sits in front so the hair only shows around the back/sides of head
    // and below the chin line.
    const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.46, 64, 64), hair);
    backHair.scale.set(1.05, 1.32, 1.05);
    backHair.position.set(0, -0.06, -0.03);
    headGroup.add(backHair);

    // ── Hair: FRONT bangs across the forehead.
    // Partial sphere covering the front-top of the head, from the crown
    // down to just above the eyebrows.
    const bangsGeom = new THREE.SphereGeometry(
      0.42, 64, 32,
      -Math.PI / 2, Math.PI,        // azimuth: front half only
      0, Math.PI * 0.42,            // polar: top of head down to brow line
    );
    const bangs = new THREE.Mesh(bangsGeom, hair);
    bangs.position.set(0, 0.0, 0.0);
    bangs.scale.set(1.06, 1.14, 1.08);
    headGroup.add(bangs);

    // Tiny side-strands hanging in front of the ears for the "bob" feel.
    const sideStrandGeom = new THREE.CapsuleGeometry(0.05, 0.18, 4, 12);
    const strandL = new THREE.Mesh(sideStrandGeom, hair);
    strandL.position.set(-0.36, -0.12, 0.16);
    strandL.rotation.z = -0.12;
    strandL.scale.set(1.0, 1.0, 0.6);
    headGroup.add(strandL);
    const strandR = strandL.clone();
    strandR.position.x = 0.36;
    strandR.rotation.z = 0.12;
    headGroup.add(strandR);

    // ── Eyes ─────────────────────────────────────────────────────────
    const makeEye = (side) => {
      const g = new THREE.Group();
      g.position.set(side * 0.13, 0.04, 0.345);
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.062, 32, 32), sclera);
      white.scale.set(1.25, 1.05, 0.7);
      g.add(white);
      const ir = new THREE.Mesh(new THREE.SphereGeometry(0.034, 24, 24), iris);
      ir.position.z = 0.04;
      g.add(ir);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 16), pupil);
      pu.position.z = 0.058;
      g.add(pu);
      const hi = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 12, 12), highlight);
      hi.position.set(side * 0.011, 0.014, 0.066);
      g.add(hi);
      return g;
    };
    const leftEye = makeEye(-1);
    const rightEye = makeEye(1);
    headGroup.add(leftEye, rightEye);

    // Upper eyelid LINES (a thin dark crescent above the eye gives the
    // cartoon "drawn" look). Just thin tori arched above each eye.
    const lidLineGeom = new THREE.TorusGeometry(0.07, 0.005, 8, 24, Math.PI);
    const lidLineL = new THREE.Mesh(lidLineGeom, lidLine);
    lidLineL.position.set(-0.13, 0.085, 0.36);
    lidLineL.rotation.z = Math.PI;
    lidLineL.scale.set(1.05, 0.7, 0.6);
    headGroup.add(lidLineL);
    const lidLineR = lidLineL.clone();
    lidLineR.position.x = 0.13;
    headGroup.add(lidLineR);

    // Upper eyelids (skin) for blinking — squashed half-spheres.
    const eyelidGeom = new THREE.SphereGeometry(0.063, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2);
    const eyelidL = new THREE.Mesh(eyelidGeom, skin);
    eyelidL.position.set(-0.13, 0.052, 0.345);
    eyelidL.rotation.x = Math.PI;
    eyelidL.scale.set(1.3, 0.001, 0.78);
    headGroup.add(eyelidL);
    const eyelidR = eyelidL.clone();
    eyelidR.position.x = 0.13;
    headGroup.add(eyelidR);

    // ── Eyebrows: arched torus segments ──────────────────────────────
    const browGeom = new THREE.TorusGeometry(0.07, 0.012, 8, 24, Math.PI);
    const browL = new THREE.Mesh(browGeom, brow);
    browL.position.set(-0.13, 0.16, 0.36);
    browL.rotation.z = Math.PI;
    browL.scale.set(1.0, 0.55, 0.6);
    headGroup.add(browL);
    const browR = browL.clone();
    browR.position.x = 0.13;
    headGroup.add(browR);

    // ── Nose: a small soft button (no visible bridge cylinder) ───────
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.04, 24, 24), skin);
    nose.position.set(0, -0.05, 0.4);
    nose.scale.set(1.05, 1.0, 1.0);
    headGroup.add(nose);

    // Tiny shadow under the nose (a subtle skin-darker sphere)
    const noseShadow = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 24), blush);
    noseShadow.position.set(0, -0.085, 0.39);
    noseShadow.scale.set(1.0, 0.25, 0.5);
    headGroup.add(noseShadow);

    // ── Cheeks: subtle blush ─────────────────────────────────────────
    const cheekGeom = new THREE.SphereGeometry(0.075, 24, 24);
    const cheekL = new THREE.Mesh(cheekGeom, blush);
    cheekL.position.set(-0.22, -0.08, 0.3);
    cheekL.scale.set(1.0, 0.55, 0.35);
    headGroup.add(cheekL);
    const cheekR = cheekL.clone();
    cheekR.position.x = 0.22;
    headGroup.add(cheekR);

    // ── Mouth: smile-shaped lips with hidden inner cavity ────────────
    // Inner mouth (only really visible when the mouth opens widely).
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.04), innerMouth);
    inner.position.set(0, -0.2, 0.345);
    headGroup.add(inner);

    // Smile arc: a thin torus segment forming an upturned curve.
    const smileGeom = new THREE.TorusGeometry(0.08, 0.014, 10, 32, Math.PI);
    const smile = new THREE.Mesh(smileGeom, lip);
    smile.position.set(0, -0.21, 0.36);
    smile.rotation.z = Math.PI;        // curve facing up
    smile.scale.set(1.0, 0.5, 0.6);
    headGroup.add(smile);

    // Lower lip — a small ellipsoid below the smile arc.
    const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 32, 16), lip);
    lowerLip.position.set(0, -0.225, 0.36);
    lowerLip.scale.set(0.95, 0.18, 0.32);
    headGroup.add(lowerLip);

    // Chin — a soft skin sphere just below to round the jawline.
    const chin = new THREE.Mesh(new THREE.SphereGeometry(0.18, 32, 32), skin);
    chin.position.set(0, -0.32, 0.16);
    chin.scale.set(0.85, 0.45, 0.65);
    headGroup.add(chin);

    // ── Body ────────────────────────────────────────────────────────
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.18, 24), skin);
    neck.position.y = 1.18;

    // Soft shoulders + tapered torso — no balloon shape.
    const torsoTop = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.25, 32), shirt);
    torsoTop.position.y = 0.96;
    const torsoBody = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.85, 32), shirt);
    torsoBody.position.y = 0.42;

    const group = new THREE.Group();
    group.add(headGroup, neck, torsoTop, torsoBody);

    this.modelRoot = group;
    this.scene.add(group);

    this._fallback = {
      headGroup, head,
      leftEye, rightEye,
      eyelidL, eyelidR,
      lowerLip, smile, inner,
      browL, browR,
    };
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    const dt = this.clock.getDelta();
    this.idle += dt;

    if (this.mixer) this.mixer.update(dt);

    // Synthesize a "speaking" amplitude curve from layered sines so the
    // mouth opens and closes with natural rhythm even without audio
    // analysis. Browsers' SpeechSynthesis API doesn't expose audio data,
    // so we fake the envelope and gate it on _speaking.
    let level = 0;
    if (this._speaking) {
      const t = this.idle * 9;
      const a = Math.sin(t) * 0.5 + 0.5;
      const b = Math.sin(t * 1.7 + 1.3) * 0.5 + 0.5;
      const c = Math.sin(t * 2.6 + 0.4) * 0.5 + 0.5;
      level = Math.max(0, (a * 0.55 + b * 0.3 + c * 0.15) - 0.15);
    }
    this.lipTarget = Math.min(1, level);
    this.lipLevel += (this.lipTarget - this.lipLevel) * Math.min(1, dt * 16);

    // Blinks
    this.lastBlink += dt;
    if (this.blinkPhase === 0 && this.lastBlink > 3 + Math.random() * 4) {
      this.blinkPhase = 0.0001;
      this.lastBlink = 0;
    }
    let blink = 0;
    if (this.blinkPhase > 0) {
      this.blinkPhase += dt;
      const total = 0.18;
      const t = this.blinkPhase / total;
      blink = t < 0.5 ? t * 2 : Math.max(0, 1 - (t - 0.5) * 2);
      if (this.blinkPhase >= total) this.blinkPhase = 0;
    }

    // Drive GLB morph targets if we have them.
    for (const m of this.morphTargets) {
      const arr = m.mesh.morphTargetInfluences;
      if (!arr) continue;
      if (m.kind === "mouth") arr[m.index] = this.lipLevel;
      else if (m.kind === "blink") arr[m.index] = blink;
      else if (m.kind === "smile") arr[m.index] = 0.2 + this.lipLevel * 0.15;
    }

    // Drive procedural fallback rig.
    if (this._fallback) {
      const f = this._fallback;
      const open = this.lipLevel;
      f.lowerLip.position.y = -0.225 - open * 0.05;
      f.lowerLip.scale.y = 0.18 + open * 0.18;
      f.inner.scale.y = 1.0 + open * 3.2;
      f.inner.scale.x = 1.0 - open * 0.15;
      // Smile arc lifts a touch when calm, flattens when speaking widely.
      f.smile.scale.y = 0.5 - open * 0.15;
      // Blinks
      f.eyelidL.scale.y = Math.max(0.001, blink * 1.3);
      f.eyelidR.scale.y = Math.max(0.001, blink * 1.3);
      // Head sway
      f.headGroup.rotation.y = Math.sin(this.idle * 0.45) * 0.06;
      f.headGroup.rotation.x = Math.sin(this.idle * 0.65) * 0.025;
      // Eye saccades
      const sx = Math.sin(this.idle * 0.9) * 0.05;
      const sy = Math.sin(this.idle * 0.6 + 1.3) * 0.03;
      f.leftEye.rotation.set(sy, sx, 0);
      f.rightEye.rotation.set(sy, sx, 0);
      // Brow lift while speaking
      f.browL.position.y = 0.16 + open * 0.014;
      f.browR.position.y = 0.16 + open * 0.014;
    }

    if (this.head) {
      this.head.rotation.y = Math.sin(this.idle * 0.5) * 0.04;
      this.head.rotation.x = Math.sin(this.idle * 0.7) * 0.02 - 0.05;
    }
    if (this.modelRoot && !this._fallback) {
      this.modelRoot.position.y = Math.sin(this.idle * 1.4) * 0.005;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
