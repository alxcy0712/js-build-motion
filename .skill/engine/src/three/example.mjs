/** Copy into src/three-scene.mjs, then design the film's own objects and choreography. */
export function createScene({ THREE, scene, camera, material, flatMaterial, theme }) {
  const group = new THREE.Group();
  scene.add(group);
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 2.3, 0.12), material('surface'));
  body.castShadow = true;
  group.add(body);
  const canvas = document.createElement('canvas');
  canvas.width = 1140; canvas.height = 690;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = theme.palette.surface; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = theme.palette.accent; ctx.fillRect(80, 100, 100, 12);
  ctx.fillStyle = theme.palette.text;
  ctx.font = `700 88px "${theme.fonts.stack[0]}", "Noto Sans CJK SC"`;
  ctx.fillText('让信息进入空间', 80, 260);
  ctx.fillStyle = theme.palette.textSecondary;
  ctx.font = '500 36px "Noto Sans CJK SC"';
  ctx.fillText('关系 · 变化 · 结果', 80, 350);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.3), flatMaterial({ map: texture }));
  face.position.z = 0.061; group.add(face);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 24), material('accent'));
  ball.castShadow = true; scene.add(ball);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), material('surface'));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.4; floor.receiveShadow = true; scene.add(floor);
  const kinetic = theme.id === 'kinetic';
  return { update({ time }) {
    const progress = Math.min(1, time / (kinetic ? 1.8 : 3));
    const ease = progress * progress * (3 - 2 * progress);
    group.rotation.y = (1 - ease) * -0.65 + 0.12;
    group.rotation.x = (1 - ease) * 0.15;
    ball.position.set(-1.4 + 2.8 * ease, kinetic ? -1.14 + 0.85 * Math.sin(Math.PI * ease) : -1.14, 0.65);
    camera.position.set(0.4 * (1 - ease), 1, 8 - 0.3 * ease); camera.lookAt(0, 0, 0);
  } };
}
