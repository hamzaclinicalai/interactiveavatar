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

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 100);
    this.camera.position.set(0, 1.55, 2.6);
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
    const group = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xffd7b3, roughness: 0.55, metalness: 0.0 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2b1a3a, roughness: 0.5 });
    const eye = new THREE.MeshStandardMaterial({ color: 0x0c0c14, roughness: 0.2 });
    const mouth = new THREE.MeshStandardMaterial({ color: 0x6a1f2a, roughness: 0.4 });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 48), skin);
    head.position.y = 1.6;
    head.scale.set(0.9, 1.05, 0.95);
    group.add(head);

    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.58, 48, 48, 0, Math.PI * 2, 0, Math.PI / 2), hair);
    cap.position.y = 1.62;
    cap.scale.set(0.95, 0.85, 1.0);
    group.add(cap);

    const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 24), eye);
    leftEye.position.set(-0.16, 1.66, 0.46);
    group.add(leftEye);
    const rightEye = leftEye.clone();
    rightEye.position.x = 0.16;
    group.add(rightEye);

    const eyelidL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 24, 0, Math.PI * 2, 0, Math.PI / 2), skin);
    eyelidL.position.set(-0.16, 1.66, 0.46);
    eyelidL.rotation.x = -Math.PI / 2;
    eyelidL.scale.y = 0.001;
    group.add(eyelidL);
    const eyelidR = eyelidL.clone();
    eyelidR.position.x = 0.16;
    group.add(eyelidR);

    const mouthMesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 24), mouth);
    mouthMesh.position.set(0, 1.42, 0.5);
    mouthMesh.scale.set(1.2, 0.15, 0.4);
    group.add(mouthMesh);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 1.2, 32), new THREE.MeshStandardMaterial({ color: 0x4a3aa0, roughness: 0.6 }));
    body.position.y = 0.7;
    group.add(body);

    this.modelRoot = group;
    this.scene.add(group);

    this._fallback = { head, mouthMesh, eyelidL, eyelidR };
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
      f.mouthMesh.scale.y = 0.15 + this.lipLevel * 0.65;
      f.mouthMesh.scale.x = 1.2 - this.lipLevel * 0.25;
      f.eyelidL.scale.y = Math.max(0.001, blink * 1.2);
      f.eyelidR.scale.y = Math.max(0.001, blink * 1.2);
      f.head.rotation.y = Math.sin(this.idle * 0.5) * 0.08;
      f.head.rotation.x = Math.sin(this.idle * 0.7) * 0.04;
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
