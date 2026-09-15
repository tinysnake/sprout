import * as THREE from 'three';
import './style.css';

const canvas = document.querySelector('#game-canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Expected the game canvas to exist.');
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x112033);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 6);

const board = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshBasicMaterial({ color: 0x2d7dd2 }),
);
scene.add(board);

function resize() {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (canvas.width === width && canvas.height === height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function render() {
  resize();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

render();
