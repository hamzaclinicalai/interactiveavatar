// Three.js scene that renders the avatar and drives morph-target lip-sync
// from a 0..1 amplitude signal (tap from PlaybackQueue.getLevel()).
//
// If a GLB at AVATAR_MODEL_URL loads successfully, we use it. Otherwise we
// fall back to a stylized procedural character so the app still works
// before you supply a model.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MOUTH_PATTERNS = [
  /jawopen/i, /mouthopen/i, /viseme_aa/i, /viseme_o/i, /viseme_e/i,
];
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

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    this.camera.position.set(0, 1.5, 3.4);
    this.camera.lookAt(0, 1.5, 0);

    this._setupLights();
    this._setupBackdrop();

    this.mixer = null;
    this.clock = new THREE.Clock();
    this.morphTargets = []; // [{mesh, index, kind}]
    this.head = null;
    this.lipLevel = 0;
    this.lipTarget = 0;
    this.lastBlink = 0;
    this.blinkPhase = 0;
    this.idle = 0;
    this.modelRoot = null;
    this.getLevel = () => 0;

    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._onResize();
    this._tick = this._tick.bind(this);
    this.renderer.setAnimationLoop(this._tick);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xbcc7ff, 0x331a55, 0.7);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffe7c2, 1.7);
    key.position.set(2.2, 3, 2.5);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8aa6ff, 0.55);
    fill.position.set(-2.5, 1.6, 1.6);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xff7ad9, 0.9);
    rim.position.set(-1.0, 2.4, -2.4);
    this.scene.add(rim);
  }

  _setupBackdrop() {
    const geo = new THREE.SphereGeometry(20, 32, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x2a1a55) },
        bottomColor: { value: new THREE.Color(0x080814) },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vWorld = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vWorld; uniform vec3 topColor; uniform vec3 bottomColor;
        void main(){ float h = normalize(vWorld).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0); }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    this.scene.add(dome);
  }

  setLevelSource(fn) { this.getLevel = fn || (() => 0); }

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
          this.morphTargets.push({ mesh: obj, index: idx, kind: "mouth", name });
        } else if (BLINK_PATTERNS.some((r) => r.test(name))) {
          this.morphTargets.push({ mesh: obj, index: idx, kind: "blink", name });
        } else if (SMILE_PATTERNS.some((r) => r.test(name))) {
          this.morphTargets.push({ mesh: obj, index: idx, kind: "smile", name });
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
    // Aim camera at upper third (where the face is).
    const target = new THREE.Vector3(center.x, box.min.y + size.y * 0.85, center.z);
    const distance = Math.max(size.y, size.x) * 1.6;
    this.camera.position.set(target.x, target.y, target.z + distance);
    this.camera.lookAt(target);
    this._lookTarget = target;
  }

  _buildFallback() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xf2c8a8, roughness: 0.6, metalness: 0.0 });
    const blush = new THREE.MeshStandardMaterial({ color: 0xe79078, roughness: 0.7, transparent: true, opacity: 0.45 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.7, metalness: 0.05 });
    const sclera = new THREE.MeshStandardMaterial({ color: 0xfafaf6, roughness: 0.25 });
    const iris = new THREE.MeshStandardMaterial({ color: 0x4a6f8c, roughness: 0.3, metalness: 0.15 });
    const pupil = new THREE.MeshStandardMaterial({ color: 0x0a0a14, roughness: 0.15 });
    const highlight = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const lip = new THREE.MeshStandardMaterial({ color: 0xb3525a, roughness: 0.4 });
    const innerMouth = new THREE.MeshStandardMaterial({ color: 0x320812, roughness: 0.8 });
    const brow = new THREE.MeshStandardMaterial({ color: 0x2b1a14, roughness: 0.75 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x4a3aa0, roughness: 0.7 });

    // ── Head group: every facial feature attaches here so the head can
    //    rotate as one unit and the camera frames it cleanly. ─────────
    const headGroup = new THREE.Group();
    headGroup.position.y = 1.55;

    // Skull — slightly egg-shaped (narrower at the jaw)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 64, 64), skin);
    head.scale.set(1.0, 1.18, 1.0);
    headGroup.add(head);

    // Hair: back/top cap
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 64, 64, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hair,
    );
    hairCap.position.set(0, 0.04, -0.02);
    hairCap.scale.set(1.05, 1.15, 1.05);
    headGroup.add(hairCap);

    // Hair: side fringe (asymmetric — feels less mannequin-y)
    const fringe = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2),
      hair,
    );
    fringe.position.set(-0.1, 0.3, 0.28);
    fringe.rotation.set(0.4, 0.0, 0.45);
    fringe.scale.set(1.3, 0.55, 0.5);
    headGroup.add(fringe);

    // Ears
    const earGeom = new THREE.SphereGeometry(0.07, 24, 24);
    const earL = new THREE.Mesh(earGeom, skin);
    earL.position.set(-0.4, 0.0, 0);
    earL.scale.set(0.45, 1.15, 0.7);
    headGroup.add(earL);
    const earR = earL.clone();
    earR.position.x = 0.4;
    headGroup.add(earR);

    // Eyes — sclera + iris + pupil + specular highlight
    const makeEye = (side) => {
      const g = new THREE.Group();
      g.position.set(side * 0.13, 0.07, 0.345);
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.055, 32, 32), sclera);
      white.scale.set(1.25, 1.0, 0.7);
      g.add(white);
      const ir = new THREE.Mesh(new THREE.SphereGeometry(0.028, 24, 24), iris);
      ir.position.z = 0.04;
      g.add(ir);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.013, 16, 16), pupil);
      pu.position.z = 0.055;
      g.add(pu);
      const hi = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 12), highlight);
      hi.position.set(side * 0.008, 0.012, 0.062);
      g.add(hi);
      return g;
    };
    const leftEye = makeEye(-1);
    const rightEye = makeEye(1);
    headGroup.add(leftEye, rightEye);

    // Upper eyelids — flat half-shells we squash for blinks
    const lidGeom = new THREE.SphereGeometry(0.06, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2);
    const eyelidL = new THREE.Mesh(lidGeom, skin);
    eyelidL.position.set(-0.13, 0.082, 0.345);
    eyelidL.rotation.x = Math.PI;
    eyelidL.scale.set(1.3, 0.001, 0.78);
    headGroup.add(eyelidL);
    const eyelidR = eyelidL.clone();
    eyelidR.position.x = 0.13;
    headGroup.add(eyelidR);

    // Eyebrows — softly arched
    const browGeom = new THREE.BoxGeometry(0.12, 0.018, 0.02);
    const browL = new THREE.Mesh(browGeom, brow);
    browL.position.set(-0.13, 0.16, 0.36);
    browL.rotation.z = -0.1;
    browL.rotation.y = 0.2;
    headGroup.add(browL);
    const browR = browL.clone();
    browR.position.x = 0.13;
    browR.rotation.z = 0.1;
    browR.rotation.y = -0.2;
    headGroup.add(browR);

    // Nose — bridge + tip
    const noseBridge = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.038, 0.16, 20), skin);
    noseBridge.position.set(0, 0.0, 0.36);
    noseBridge.rotation.x = -0.18;
    headGroup.add(noseBridge);
    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 32, 32), skin);
    noseTip.position.set(0, -0.08, 0.4);
    noseTip.scale.set(0.95, 0.85, 0.95);
    headGroup.add(noseTip);

    // Cheeks — subtle blush dots
    const cheekGeom = new THREE.SphereGeometry(0.07, 24, 24);
    const cheekL = new THREE.Mesh(cheekGeom, blush);
    cheekL.position.set(-0.22, -0.06, 0.3);
    cheekL.scale.set(1.0, 0.6, 0.4);
    headGroup.add(cheekL);
    const cheekR = cheekL.clone();
    cheekR.position.x = 0.22;
    headGroup.add(cheekR);

    // Mouth — inner cavity (visible when open) + upper/lower lips
    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.04, 0.04),
      innerMouth,
    );
    inner.position.set(0, -0.2, 0.34);
    headGroup.add(inner);

    const lipGeom = new THREE.SphereGeometry(0.07, 32, 16);
    const upperLip = new THREE.Mesh(lipGeom, lip);
    upperLip.position.set(0, -0.183, 0.365);
    upperLip.scale.set(1.05, 0.22, 0.32);
    headGroup.add(upperLip);

    const lowerLip = new THREE.Mesh(lipGeom, lip);
    lowerLip.position.set(0, -0.218, 0.365);
    lowerLip.scale.set(0.95, 0.28, 0.36);
    headGroup.add(lowerLip);

    // Chin shadow indication via a small skin sphere just below mouth
    const chin = new THREE.Mesh(new THREE.SphereGeometry(0.18, 32, 32), skin);
    chin.position.set(0, -0.32, 0.18);
    chin.scale.set(0.85, 0.5, 0.7);
    headGroup.add(chin);

    // ── Body ────────────────────────────────────────────────────────
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.22, 24), skin);
    neck.position.y = 1.18;

    const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24), shirt);
    shoulders.position.y = 0.98;
    shoulders.scale.set(1.45, 0.45, 0.85);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.85, 32), shirt);
    torso.position.y = 0.5;

    const group = new THREE.Group();
    group.add(headGroup, neck, shoulders, torso);

    this.modelRoot = group;
    this.scene.add(group);

    this._fallback = {
      headGroup, head,
      leftEye, rightEye,
      eyelidL, eyelidR,
      upperLip, lowerLip, inner,
      browL, browR,
    };
    this._lookTarget = new THREE.Vector3(0, 1.55, 0);
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

    // Smooth amplitude → mouth open value.
    const level = this.getLevel();
    this.lipTarget = Math.min(1, level * 1.6);
    this.lipLevel += (this.lipTarget - this.lipLevel) * Math.min(1, dt * 18);

    // Blinks.
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

    // Apply morph targets when present.
    for (const m of this.morphTargets) {
      const arr = m.mesh.morphTargetInfluences;
      if (!arr) continue;
      if (m.kind === "mouth") arr[m.index] = this.lipLevel;
      else if (m.kind === "blink") arr[m.index] = blink;
      else if (m.kind === "smile") arr[m.index] = 0.15 + this.lipLevel * 0.2;
    }

    // Fallback rig animations.
    if (this._fallback) {
      const f = this._fallback;
      const open = this.lipLevel;
      // Lower lip drops and inner mouth scales open.
      f.lowerLip.position.y = -0.218 - open * 0.06;
      f.lowerLip.scale.y = 0.28 + open * 0.15;
      f.upperLip.position.y = -0.183 + open * 0.005;
      f.inner.scale.y = 1.0 + open * 4.0;
      f.inner.scale.x = 1.0 - open * 0.2;
      // Subtle smile — corners of mouth lift slightly when calm.
      const smile = 0.05 + (1 - open) * 0.05;
      f.upperLip.rotation.z = 0;
      f.lowerLip.rotation.z = 0;
      // Blinks
      f.eyelidL.scale.y = Math.max(0.001, blink * 1.3);
      f.eyelidR.scale.y = Math.max(0.001, blink * 1.3);
      // Head sway — rotate the whole head group, not just the skull.
      f.headGroup.rotation.y = Math.sin(this.idle * 0.5) * 0.07;
      f.headGroup.rotation.x = Math.sin(this.idle * 0.7) * 0.03;
      // Tiny eye saccades for life.
      const sx = Math.sin(this.idle * 0.9) * 0.05;
      const sy = Math.sin(this.idle * 0.6 + 1.3) * 0.03;
      f.leftEye.rotation.set(sy, sx, 0);
      f.rightEye.rotation.set(sy, sx, 0);
      // Brow lift when speaking.
      f.browL.position.y = 0.16 + open * 0.012;
      f.browR.position.y = 0.16 + open * 0.012;
      // Avoid unused warning
      void smile;
    }

    // Subtle head sway on rigged models too.
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
