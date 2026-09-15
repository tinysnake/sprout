/**
 * Headless-browser verification for the preserved O7 Minesweeper workspace.
 *
 * It starts Vite and a disposable Edge profile, drives real CDP pointer input
 * against the rendered Three.js canvas, then reads the game's public smoke
 * handle to prove reveal and right-click flag state transitions.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const portBase = Number(process.env.PORT ?? 41000);
const host = process.env.O7_HOST ?? 'localhost';
const gamePort = Number(process.env.O7_GAME_PORT ?? portBase + 1);
const debugPort = Number(process.env.O7_BROWSER_DEBUG_PORT ?? portBase + 2);
const browserBinary = process.env.O7_HEADLESS_BROWSER ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const gameWorkspace = join('.sprout-game-workspaces', 'minesweeper');
const viteBinary = join('node_modules', '.bin', 'vite');
const profile = '.sprout-o7-browser-profile';
const gameEndpoint = new URL(`http://${host}:${gamePort}`);
const debugEndpoint = new URL(`http://${host}:${debugPort}`);

class CdpClient {
  #nextId = 0;
  #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      if (response.id === undefined) return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? 'CDP request failed'));
      else pending.resolve(response.result ?? {});
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('could not connect to Edge DevTools')), { once: true });
    });
    return new CdpClient(socket);
  }

  call(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.#nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close(): void { this.socket.close(); }
}

interface GameSnapshot { readonly revealed: number; readonly flags: number; readonly mines: number; }
interface FlagSnapshot { readonly flagged: number; readonly flags: number; readonly mines: number; }

process.env.NO_PROXY = [...new Set([...(process.env.NO_PROXY ?? '').split(',').filter(Boolean), host])].join(',');

let vite: ChildProcess | undefined;
let browser: ChildProcess | undefined;

try {
  vite = spawn(viteBinary, ['--host', host, '--port', String(gamePort), '--strictPort'], {
    cwd: gameWorkspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForVite(gameEndpoint);

  browser = spawn(browserBinary, [
    '--headless=new', '--use-angle=swiftshader', '--use-gl=angle', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const version = await waitForJson(new URL('/json/version', debugEndpoint), 'Edge');
  const client = await CdpClient.connect(String(version.webSocketDebuggerUrl));
  try {
    const target = await client.call('Target.createTarget', { url: 'about:blank' });
    const attached = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    await client.call('Page.enable', {}, sessionId);
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: "window.__o7Errors = []; addEventListener('error', event => window.__o7Errors.push(String(event.message)));" }, sessionId);
    await client.call('Page.navigate', { url: gameEndpoint.href }, sessionId);
    await waitForGame(client, sessionId);

    const initial = await evaluate<GameSnapshot>(client, sessionId, `
      (() => {
        const game = window.__minesweeper;
        return { revealed: game.board.revealedCount, flags: game.board.flagsPlaced, mines: game.board.minesRemaining };
      })()
    `);
    const revealPoint = await pointFor(client, sessionId, 'covered');
    await pointer(client, sessionId, revealPoint, 'left');
    const afterReveal = await evaluate<GameSnapshot>(client, sessionId, `
      (() => {
        const game = window.__minesweeper;
        return { revealed: game.board.revealedCount, flags: game.board.flagsPlaced, mines: game.board.minesRemaining };
      })()
    `);
    assert.ok(afterReveal.revealed > initial.revealed, 'primary pointer input did not reveal a cell');

    const flagPoint = await pointFor(client, sessionId, 'covered');
    await pointer(client, sessionId, flagPoint, 'right');
    const afterFlag = await evaluate<FlagSnapshot>(client, sessionId, `
      (() => {
        const game = window.__minesweeper;
        const cell = game.renderer.pick(${flagPoint.x}, ${flagPoint.y});
        return {
          flagged: Number(Boolean(cell && game.board.getCell(cell.c, cell.r).isFlagged)),
          flags: game.board.flagsPlaced,
          mines: game.board.minesRemaining,
        };
      })()
    `);
    assert.equal(afterFlag.flagged, 1, 'secondary pointer input did not flag its covered cell');
    assert.equal(afterFlag.flags, afterReveal.flags + 1, 'flag count did not increase after secondary pointer input');
    assert.equal(afterFlag.mines, afterReveal.mines - 1, 'mine counter did not update after flagging');
    console.log('PASS: headless Edge revealed and flagged rendered Minesweeper cells');
  } finally {
    client.close();
  }
} finally {
  await stop(browser);
  await stop(vite);
  await rm(profile, { recursive: true, force: true });
}

async function waitForGame(client: CdpClient, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate<boolean>(client, sessionId, 'Boolean(window.__minesweeper?.renderer?.pick)');
    if (ready) return;
    await delay(100);
  }
  const diagnostics = await evaluate<Record<string, unknown>>(client, sessionId, "({ href: location.href, canvas: Boolean(document.querySelector('#game-canvas')), errors: window.__o7Errors, body: document.body?.innerText })");
  throw new Error(`Minesweeper did not become ready in headless Edge: ${JSON.stringify(diagnostics)}`);
}

async function pointFor(client: CdpClient, sessionId: string, kind: 'covered'): Promise<{ x: number; y: number }> {
  return evaluate(client, sessionId, `
    (() => {
      const { board, renderer } = window.__minesweeper;
      const rect = document.querySelector('#game-canvas').getBoundingClientRect();
      for (let row = 0; row < board.rows; row += 1) {
        for (let column = 0; column < board.cols; column += 1) {
          const x = rect.left + ((column + 0.5) / board.cols) * rect.width;
          const y = rect.top + ((row + 0.5) / board.rows) * rect.height;
          const cell = renderer.pick(x, y);
          if (cell && !board.getCell(cell.c, cell.r).isRevealed && !board.getCell(cell.c, cell.r).isFlagged) return { x, y };
        }
      }
      throw new Error('no ${kind} cell is available for pointer verification');
    })()
  `);
}

async function pointer(client: CdpClient, sessionId: string, point: { x: number; y: number }, button: 'left' | 'right'): Promise<void> {
  const buttons = button === 'left' ? 1 : 2;
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 }, sessionId);
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: 1 }, sessionId);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1 }, sessionId);
  await delay(100);
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  const exception = result.exceptionDetails as { text?: string } | undefined;
  if (exception) throw new Error(exception.text ?? 'browser evaluation failed');
  return (result.result as { value: T }).value;
}

async function waitForVite(endpoint: URL): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(new URL('/src/main.js', endpoint));
      if (response.ok && (await response.text()).includes('BoardRenderer')) return;
    } catch {
      // Vite is still starting.
    }
    await delay(100);
  }
  throw new Error('Vite did not serve the Minesweeper entry point');
}

async function waitForJson(endpoint: URL, label: string, parseJson = true): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return parseJson ? await response.json() as Record<string, unknown> : {};
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error(`${label} did not start`);
}

async function stop(process: ChildProcess | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  process.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (process.exitCode === null) process.kill('SIGKILL');
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
