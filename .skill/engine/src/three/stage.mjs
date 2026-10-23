import * as THREE from 'three';

/** Theme colours come from the film's fixed brand snapshot. These lighting/material values are starting points. */
export function createBrandStage({ theme, width, height, alpha }) {
  const scene = new THREE.Scene();
  scene.background = alpha ? null : new THREE.Color(theme.palette.bg);
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
  camera.position.set(0, 1, 8);
  camera.lookAt(0, 0, 0);
  const fill = new THREE.HemisphereLight('#FFFFFF', '#303038', 1.5);
  const key = new THREE.DirectionalLight('#FFFFFF', 2.5);
  key.position.set(-3, 5, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -5;
  key.shadow.camera.right = key.shadow.camera.top = 5;
  key.shadow.normalBias = 0.02;
  scene.add(fill, key);
  const material = (role = 'accent') => new THREE.MeshStandardMaterial({
    color: theme.palette[role], roughness: theme.id === 'minimal' ? 0.9 : 0.7, metalness: 0,
  });
  // Screenshots, logos and exact brand swatches keep their sRGB colour independently of lighting.
  const flatMaterial = (options = {}) => new THREE.MeshBasicMaterial({ toneMapped: false, ...options });
  return { scene, camera, material, flatMaterial, lights: { fill, key } };
}
