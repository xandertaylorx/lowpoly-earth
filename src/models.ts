import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Optional glTF/GLB models. Drop files into public/models/ (airliner.glb, jet.glb, car.glb) and they replace the
// built-in low-poly vehicles automatically. Models should face +Z (glTF convention) and use metres or any scale:
// they are rescaled to `length` metres and sat on the ground.
const draco = new DRACOLoader().setDecoderPath('/draco/');
const loader = new GLTFLoader().setDRACOLoader(draco);

export async function loadModel(url: string, length: number, baseY = 0, facesPlusZ = true): Promise<THREE.Group | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    // the dev server answers unknown paths with index.html, so check it really is a model
    if (!head.ok || (head.headers.get('content-type') ?? '').includes('html')) return null;
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = true; } });
    const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const k = length / Math.max(size.x, size.z, 1e-6);
    root.scale.multiplyScalar(k);
    root.position.set(-mid.x * k, -box.min.y * k + baseY, -mid.z * k);
    const wrap = new THREE.Group();
    wrap.add(root);
    if (facesPlusZ) wrap.rotation.y = Math.PI; // +Z-facing models -> our forward is -Z
    const out = new THREE.Group(); out.add(wrap);
    return out;
  } catch (e) {
    console.warn('model failed', url, e);
    return null;
  }
}
