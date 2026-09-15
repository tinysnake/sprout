import * as THREE from 'three';
import './style.css';

const canvas = document.querySelector('#game-canvas');
const counter = document.querySelector('#mine-counter');
const status = document.querySelector('#game-status');
const reset = document.querySelector('#reset-game');
if (!(canvas instanceof HTMLCanvasElement) || !counter || !status || !(reset instanceof HTMLButtonElement)) throw new Error('The Minesweeper page is missing game controls.');

/** Pure board rules: first reveal is safe, empty cells flood, flags never reveal. */
class MinesweeperBoard {
  constructor(cols = 9, rows = 9, mineCount = 10) { this.cols = cols; this.rows = rows; this.mineCount = mineCount; this.reset(); }
  reset() {
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => ({ isMine: false, isRevealed: false, isFlagged: false, adjacent: 0 })));
    this.generated = false; this.finished = false; this.won = false; this.revealedCount = 0; this.flagsPlaced = 0;
  }
  get minesRemaining() { return this.mineCount - this.flagsPlaced; }
  getCell(c, r) { return this.cells[r]?.[c]; }
  neighbours(c, r) {
    const cells = [];
    for (let y = r - 1; y <= r + 1; y += 1) for (let x = c - 1; x <= c + 1; x += 1) if ((x !== c || y !== r) && this.getCell(x, y)) cells.push([x, y]);
    return cells;
  }
  generate(safeC, safeR) {
    const choices = [];
    for (let r = 0; r < this.rows; r += 1) for (let c = 0; c < this.cols; c += 1) if (Math.abs(c - safeC) > 1 || Math.abs(r - safeR) > 1) choices.push([c, r]);
    for (let i = choices.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [choices[i], choices[j]] = [choices[j], choices[i]]; }
    for (const [c, r] of choices.slice(0, this.mineCount)) this.getCell(c, r).isMine = true;
    for (let r = 0; r < this.rows; r += 1) for (let c = 0; c < this.cols; c += 1) this.getCell(c, r).adjacent = this.neighbours(c, r).filter(([x, y]) => this.getCell(x, y).isMine).length;
    this.generated = true;
  }
  reveal(c, r) {
    const selected = this.getCell(c, r);
    if (!selected || selected.isFlagged || selected.isRevealed || this.finished) return false;
    if (!this.generated) this.generate(c, r);
    if (selected.isMine) { selected.isRevealed = true; this.finished = true; return true; }
    const pending = [[c, r]];
    while (pending.length) {
      const [x, y] = pending.pop(); const cell = this.getCell(x, y);
      if (!cell || cell.isRevealed || cell.isFlagged || cell.isMine) continue;
      cell.isRevealed = true; this.revealedCount += 1;
      if (cell.adjacent === 0) pending.push(...this.neighbours(x, y));
    }
    if (this.revealedCount === this.cols * this.rows - this.mineCount) { this.finished = true; this.won = true; }
    return true;
  }
  toggleFlag(c, r) {
    const cell = this.getCell(c, r);
    if (!cell || cell.isRevealed || this.finished || (!cell.isFlagged && this.flagsPlaced >= this.mineCount)) return false;
    cell.isFlagged = !cell.isFlagged; this.flagsPlaced += cell.isFlagged ? 1 : -1; return true;
  }
}

/** Three.js view with a public coordinate picker for browser-level smoke checks. */
class BoardRenderer {
  constructor(target, board) {
    this.canvas = target; this.board = board;
    this.renderer = new THREE.WebGLRenderer({ canvas: target, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x101827);
    this.camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 20); this.camera.position.z = 10;
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.geometry = new THREE.PlaneGeometry(0.91, 0.91);
    this.materials = {
      covered: new THREE.MeshBasicMaterial({ color: 0x1f6f8b }), revealed: new THREE.MeshBasicMaterial({ color: 0xdbeafe }),
      flagged: new THREE.MeshBasicMaterial({ color: 0xf59e0b }), mine: new THREE.MeshBasicMaterial({ color: 0xef4444 }),
    };
    addEventListener('resize', () => this.resize()); this.resize();
  }
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return undefined;
    const c = Math.floor((clientX - rect.left) / rect.width * this.board.cols);
    const r = Math.floor((clientY - rect.top) / rect.height * this.board.rows);
    return this.board.getCell(c, r) ? { c, r } : undefined;
  }
  resize() {
    const width = Math.max(this.canvas.clientWidth, 1); const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setSize(width, height, false); const aspect = width / height;
    this.camera.left = -5 * aspect; this.camera.right = 5 * aspect; this.camera.updateProjectionMatrix(); this.draw();
  }
  draw() {
    this.group.clear();
    for (let r = 0; r < this.board.rows; r += 1) for (let c = 0; c < this.board.cols; c += 1) {
      const cell = this.board.getCell(c, r);
      const material = !cell.isRevealed ? (cell.isFlagged ? this.materials.flagged : this.materials.covered) : (cell.isMine ? this.materials.mine : this.materials.revealed);
      const tile = new THREE.Mesh(this.geometry, material); tile.position.set(c - 4, 4 - r, 0); this.group.add(tile);
      if (cell.isFlagged) { const marker = new THREE.Mesh(new THREE.CircleGeometry(0.18, 3), new THREE.MeshBasicMaterial({ color: 0xfffbeb })); marker.position.set(tile.position.x, tile.position.y, 0.01); this.group.add(marker); }
      if (cell.isRevealed && !cell.isMine && cell.adjacent) { const mark = new THREE.Mesh(new THREE.CircleGeometry(0.1 + cell.adjacent / 50, 12), new THREE.MeshBasicMaterial({ color: 0x1e3a8a })); mark.position.set(tile.position.x, tile.position.y, 0.01); this.group.add(mark); }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

const board = new MinesweeperBoard();
const renderer = new BoardRenderer(canvas, board);
function update() {
  counter.textContent = `Mines remaining: ${board.minesRemaining}`;
  status.textContent = board.finished ? (board.won ? 'Board cleared — you win!' : 'Mine hit — reset to try again.') : 'Reveal every safe cell.';
  renderer.draw();
}
canvas.addEventListener('click', (event) => { const cell = renderer.pick(event.clientX, event.clientY); if (cell && board.reveal(cell.c, cell.r)) update(); });
canvas.addEventListener('contextmenu', (event) => { event.preventDefault(); const cell = renderer.pick(event.clientX, event.clientY); if (cell && board.toggleFlag(cell.c, cell.r)) update(); });
reset.addEventListener('click', () => { board.reset(); update(); });
update();
window.__minesweeper = { board, renderer };
