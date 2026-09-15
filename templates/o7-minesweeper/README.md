# O7 Minesweeper

This is a playable 2D Minesweeper board rendered with Three.js. It is the
committed source template used by `npm run setup:game-workspace`; the
materialized local workspace is disposable, but this game is reproducible from Git.

```bash
npm install
npm run dev
npm test
```

Left-click reveals a cell, right-click toggles a flag, and the first reveal is
safe along with its adjacent cells. `DESIGN.md` records the interaction and
accessibility guidance used by the game.
