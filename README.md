# BLOC

A real-time chevron-routing puzzle. Two chevrons launch from a central emitter; rotate the mirror (`/ \`) and pipe (`| -`) blocks in real time to steer them into each other.

- **Route to collide** — bend chevrons with mirrors, bounce/avoid pipes, make the two meet.
- **Rotate in flight** — blocks only lock the instant a chevron is committing to them.
- **Endless + Daily** — levels scale from 5×5 to 10×10; progress saves to your browser.
- **Hostile animals** (level 10+) — emoji predators prowl the edges, telegraph a row/column, then nuke it. Don't be on that line when the beam fires.

Built with Vite + React + Tailwind. The grid tiles are a `pixel-canvas` web component.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
