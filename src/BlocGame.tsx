import { useEffect, useMemo, useRef, useState } from "react"
import {
  Eraser,
  FastForward,
  FlipHorizontal2,
  RotateCcw,
  Settings2,
  Slash,
  Trophy,
  Volume2,
  VolumeX,
} from "lucide-react"
import type { ComponentType } from "react"
import { PixelCanvas } from "@/components/ui/pixel-canvas"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import {
  duckMusic,
  initAudio,
  playBell,
  playLose,
  playWin,
  restartMusic,
  restoreMusic,
  setMusicMuted,
  startMusic,
} from "@/audio"

/* ------------------------------------------------------------------ *
 *  chevro - a real-time chevron routing puzzle
 * ------------------------------------------------------------------ */

type Dir = "UP" | "DOWN" | "LEFT" | "RIGHT"
type CellType = "EMPTY" | "EMITTER" | "MIRROR" | "PIPE"
type Mode = "ENDLESS" | "DAILY"
type Status = "IDLE" | "PLAYING" | "WON" | "LOST"

interface Cell {
  type: CellType
  orient: string // mirror: "/" | "\\" ; pipe: "|" | "-"
  rot?: number // display rotation (deg); accumulates so clicks spin smoothly
  flip?: boolean // a "flip" item is on this block: toggles after first contact
  flipped?: boolean // the flip has already fired this run
  player?: boolean // block was placed by the player (a "slash" item)
}

// Drag-on items you collect one of each of, deep into a run.
type ItemType = "CLEAR" | "FLIP" | "SLASH"
const ITEM_TYPES: ItemType[] = ["CLEAR", "FLIP", "SLASH"]

interface ItemMeta {
  name: string
  blurb: string
  Icon: ComponentType<{ className?: string }>
  // full class strings (Tailwind needs literals, so no dynamic accent names)
  ring: string // border/ring accent for the cube + valid targets
  chip: string // idle cube background
  glyph: string // colour of the affected block on the board
}
const ITEM_META: Record<ItemType, ItemMeta> = {
  CLEAR: {
    name: "clear",
    blurb: "wipe a block off its square",
    Icon: Eraser,
    ring: "border-slate-400 ring-slate-400/70",
    chip: "border-slate-300 bg-white text-slate-500",
    glyph: "",
  },
  FLIP: {
    name: "flip",
    blurb: "block flips after the first chevron touches it",
    Icon: FlipHorizontal2,
    ring: "border-amber-400 ring-amber-400/70",
    chip: "border-amber-300 bg-amber-50 text-amber-600",
    glyph: "text-amber-500",
  },
  SLASH: {
    name: "slash",
    blurb: "drop a new mirror on an empty square",
    Icon: Slash,
    ring: "border-teal-400 ring-teal-400/70",
    chip: "border-teal-300 bg-teal-50 text-teal-600",
    glyph: "text-teal-500",
  },
}

interface Chevron {
  id: number
  r: number
  c: number
  dir: Dir
  pr: number
  pc: number
  alive: boolean
  angle: number // accumulated rotation (deg) for smooth turning
}

type AnimalSide = "left" | "right" | "top" | "bottom"
type AnimalPhase = "REST" | "TELEGRAPH" | "FIRE"

interface Animal {
  id: number
  side: AnimalSide // left/right nuke rows, top/bottom nuke columns
  emoji: string
  phase: AnimalPhase
  ticksLeft: number
  line: number // targeted row or column index
}

interface Puzzle {
  grid: Cell[][]
  size: number
  er: number
  ec: number
}

const TICK_MS = 600
const MAX_TICKS = 90
const LOCK_FRAC = 0.62 // block locks only in the last ~38% of a tick
const FLY_OFF = 1200 // px the chevrons travel off-screen on a win
const TELEGRAPH_TICKS = 3 // ticks a nuke is telegraphed before firing
const REST_MIN = 4 // min ticks an animal waits between attacks
const REST_VAR = 4
const ANIMAL_EMOJIS = ["🦈", "🐊", "🦖", "🦂", "🦅", "🐍", "🦀", "🐙"]

const DELTA: Record<Dir, [number, number]> = {
  UP: [-1, 0],
  DOWN: [1, 0],
  LEFT: [0, -1],
  RIGHT: [0, 1],
}
const OPPOSITE: Record<Dir, Dir> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
}
const DIR_ANGLE: Record<Dir, number> = { RIGHT: 0, DOWN: 90, LEFT: 180, UP: 270 }

// The chevron entity - one glyph, drawn identically whether it's resting in
// the emitter or flying. Direction is pure rotation, so it's always the same
// shape / colour / glow. Left-facing is just the same mark rotated 180°.
const CHEVRON = "❯" // ❯
const TURN_MS = 240 // snappy pivot at a corner (movement stays linear)

function ChevronMark({
  px,
  angle,
  animate,
  dead = false,
  turnMs = TURN_MS,
}: {
  px: number
  angle: number
  animate: boolean
  dead?: boolean
  turnMs?: number
}) {
  return (
    <span
      className={cn("font-mono font-black", dead ? "text-rose-400" : "text-sky-500")}
      style={{
        fontSize: px,
        lineHeight: 1,
        opacity: dead ? 0.65 : 1,
        transform: `rotate(${angle}deg)`,
        transition: animate ? `transform ${turnMs}ms ease-out` : "none",
        textShadow: dead
          ? "none"
          : "0 0 8px rgba(14,165,233,0.55), 0 0 16px rgba(14,165,233,0.35)",
      }}
    >
      {CHEVRON}
    </span>
  )
}

/** New accumulated angle after turning oldDir -> newDir, going the short way
 *  so the arrow pivots 90° rather than spinning all the way round. */
function turnAngle(cur: number, oldDir: Dir, newDir: Dir): number {
  let d = (DIR_ANGLE[newDir] - DIR_ANGLE[oldDir]) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return cur + d
}

const PIXEL_COLORS = ["#e0f2fe", "#7dd3fc", "#0ea5e9"]

/* -------------------------- seeded PRNG --------------------------- */

function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------- mirror physics ------------------------- */

function reflect(dir: Dir, mirror: string): Dir {
  if (mirror === "/") {
    return { UP: "RIGHT", RIGHT: "UP", DOWN: "LEFT", LEFT: "DOWN" }[dir] as Dir
  }
  return { UP: "LEFT", LEFT: "UP", DOWN: "RIGHT", RIGHT: "DOWN" }[dir] as Dir
}

/* ------------------------ cell builders --------------------------- */

// Base glyph is drawn rotated, so "\" is just "/" turned 90° and "-" is "|"
// turned 90°. `rot` tracks that angle and accumulates on click so rotating a
// block spins smoothly instead of snapping between characters.
const rotOf = (orient: string) => (orient === "/" || orient === "|" ? 0 : 90)
const mkMirror = (o: string): Cell => ({ type: "MIRROR", orient: o, rot: rotOf(o) })
const mkPipe = (o: string): Cell => ({ type: "PIPE", orient: o, rot: rotOf(o) })

// flip a block to its other orientation (mirror / <-> \, pipe | <-> -), keeping
// the glyph spinning the same way (+90) rather than snapping back.
function toggleOrient(cell: Cell): Cell {
  if (cell.type === "MIRROR")
    return { ...cell, orient: cell.orient === "/" ? "\\" : "/", rot: (cell.rot ?? rotOf(cell.orient)) + 90 }
  if (cell.type === "PIPE")
    return { ...cell, orient: cell.orient === "|" ? "-" : "|", rot: (cell.rot ?? rotOf(cell.orient)) + 90 }
  return cell
}
// apply a set of flip-item toggles to a grid copy (once each, via `flipped`)
function applyFlips(grid: Cell[][], cells: [number, number][]): Cell[][] {
  const g = grid.map((row) => row.slice())
  for (const [r, c] of cells) {
    const cell = g[r][c]
    if (!cell.flip || cell.flipped) continue
    g[r][c] = { ...toggleOrient(cell), flipped: true }
  }
  return g
}

/* ------------------------ level generation ------------------------ */

const SIZE_BY_DIFF = [5, 5, 6, 6, 7, 7, 8, 8, 9, 10]
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

type Pt = [number, number]

function dirOf(a: Pt, b: Pt): Dir {
  if (b[0] < a[0]) return "UP"
  if (b[0] > a[0]) return "DOWN"
  if (b[1] < a[1]) return "LEFT"
  return "RIGHT"
}

/** The mirror that turns an incoming direction into an outgoing one. */
function orientForTurn(inD: Dir, outD: Dir): string | null {
  if (reflect(inD, "/") === outD) return "/"
  if (reflect(inD, "\\") === outD) return "\\"
  return null
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

/** Randomised self-avoiding walk from A to B avoiding `blocked` cells. */
function randomMiddle(
  size: number,
  A: Pt,
  B: Pt,
  blocked: Set<number>,
  rng: () => number,
  minLen: number,
  maxLen: number,
): Pt[] | null {
  const keyf = (r: number, c: number) => r * size + c
  const bt = keyf(B[0], B[1])
  const path: Pt[] = []
  const visited = new Set<number>()
  let result: Pt[] | null = null
  let budget = 80000
  const dfs = (r: number, c: number) => {
    if (result || budget-- <= 0) return
    path.push([r, c])
    visited.add(keyf(r, c))
    if (r === B[0] && c === B[1]) {
      if (path.length - 1 >= minLen) result = path.slice()
    } else if (path.length - 1 < maxLen) {
      const dirs = shuffle(
        [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as Pt[],
        rng,
      )
      for (const [dr, dc] of dirs) {
        const nr = r + dr
        const nc = c + dc
        if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue
        const k = keyf(nr, nc)
        if (visited.has(k)) continue
        if (blocked.has(k) && k !== bt) continue
        dfs(nr, nc)
        if (result) break
      }
    }
    path.pop()
    visited.delete(keyf(r, c))
  }
  dfs(A[0], A[1])
  return result
}

interface WindPuzzle extends Puzzle {
  reserved: Set<number>
  mirrors: { r: number; c: number; solved: string }[]
}

/**
 * Winding-loop generation. The emitter sits at the centre with a straight
 * lead-in either side; a random self-avoiding walk joins the two ends into a
 * single simple loop through the emitter. Grid graphs are bipartite so every
 * such loop has even length - split it at the antipode and the two chevrons
 * (one each way round the loop) reach that meeting cell on the same tick.
 * Every 90° turn on the loop gets a mirror (correctly oriented here); the
 * caller then scrambles the rotations and scatters decoys off the path.
 */
function generateWinding(difficulty: number, seed: number): WindPuzzle | null {
  const rng = mulberry32(seed)
  const size = SIZE_BY_DIFF[clamp(difficulty, 1, 10) - 1]
  const R = Math.floor(size / 2)
  const C = Math.floor(size / 2)
  const lead = clamp(Math.min(3, C, size - 1 - C), 2, 3)
  const A: Pt = [R, C - lead]
  const B: Pt = [R, C + lead]

  const leftLead: Pt[] = []
  const rightLead: Pt[] = []
  for (let k = 1; k <= lead; k++) leftLead.push([R, C - k])
  for (let k = lead; k >= 1; k--) rightLead.push([R, C + k])

  const keyf = (r: number, c: number) => r * size + c
  const blocked = new Set<number>([keyf(R, C)])
  for (const [r, c] of leftLead) blocked.add(keyf(r, c))
  for (const [r, c] of rightLead) blocked.add(keyf(r, c))

  const minLen = 3 + Math.floor(difficulty / 2)
  const maxLen = size + difficulty * 2
  const middle = randomMiddle(size, A, B, blocked, rng, minLen, maxLen)
  if (!middle) return null

  const P = leftLead
    .slice(0, lead - 1)
    .concat(middle)
    .concat(rightLead.slice(1))
  const cycle: Pt[] = [[R, C] as Pt].concat(P)
  const n = cycle.length
  if (n % 2 !== 0) return null
  const M = n / 2

  const grid: Cell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ type: "EMPTY", orient: "" })),
  )
  grid[R][C] = { type: "EMITTER", orient: "<>" }

  const reserved = new Set<number>()
  for (const [r, c] of cycle) reserved.add(keyf(r, c))

  const mirrors: { r: number; c: number; solved: string }[] = []
  const place = (cur: Pt, inD: Dir, outD: Dir) => {
    if (inD === outD) return
    const o = orientForTurn(inD, outD)
    if (!o) return
    grid[cur[0]][cur[1]] = mkMirror(o)
    mirrors.push({ r: cur[0], c: cur[1], solved: o })
  }
  // chevron travelling one way round the loop (emitter -> meeting)
  for (let i = 1; i < M; i++)
    place(cycle[i], dirOf(cycle[i - 1], cycle[i]), dirOf(cycle[i], cycle[i + 1]))
  // chevron travelling the other way round
  for (let i = n - 1; i > M; i--) {
    const before = cycle[(i + 1) % n]
    place(cycle[i], dirOf(before, cycle[i]), dirOf(cycle[i], cycle[i - 1]))
  }

  return { grid, size, er: R, ec: C, reserved, mirrors }
}

/**
 * Simulate the solved board *against the animals* (same schedule the player
 * will face): true only if the chevrons collide before any is destroyed by a
 * wall, pipe, or a nuke. This makes level feasibility account for the animals.
 */
function survivesAnimals(
  p: Puzzle,
  animals: Animal[],
  rngSeed: number,
): boolean {
  const rng = mulberry32(rngSeed >>> 0)
  let chev: Chevron[] = [
    { id: 0, r: p.er, c: p.ec, dir: "LEFT", pr: p.er, pc: p.ec, alive: true, angle: 180 },
    { id: 1, r: p.er, c: p.ec, dir: "RIGHT", pr: p.er, pc: p.ec, alive: true, angle: 0 },
  ]
  let anim = animals
  for (let t = 0; t <= MAX_TICKS; t++) {
    const next = step(p.grid, chev, p.size)
    const won = collided(next, p.grid)
    if (anim.length) {
      const res = stepAnimals(anim, rng, p.size)
      anim = res.next
      if (!won) {
        for (const f of res.fired) {
          for (const ch of next) {
            if (
              ch.alive &&
              ((f.axis === "row" && ch.r === f.index) ||
                (f.axis === "col" && ch.c === f.index))
            ) {
              ch.alive = false
            }
          }
        }
      }
    }
    chev = next
    if (won) return true
    if (chev.some((c) => !c.alive)) return false
  }
  return false
}

/** Turn a solved candidate into a playable level: scramble the path mirrors so
 *  the player has to fix them, then scatter decoys onto the untouched cells. */
function finalizePuzzle(
  p: WindPuzzle,
  difficulty: number,
  seed: number,
): Puzzle {
  const rng = mulberry32(seed ^ 0x5bd1e995)
  const { grid, size, mirrors, reserved } = p

  let anyWrong = false
  for (const m of mirrors) {
    const o = rng() < 0.5 ? "/" : "\\"
    grid[m.r][m.c] = mkMirror(o)
    if (o !== m.solved) anyWrong = true
  }
  if (!anyWrong && mirrors.length) {
    const m = mirrors[Math.floor(rng() * mirrors.length)]
    grid[m.r][m.c] = mkMirror(m.solved === "/" ? "\\" : "/")
  }

  const decoyProb = Math.min(0.5, 0.16 + difficulty * 0.03)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved.has(r * size + c)) continue
      if (rng() < decoyProb) {
        if (rng() < 0.62) grid[r][c] = mkMirror(rng() < 0.5 ? "/" : "\\")
        else grid[r][c] = mkPipe(rng() < 0.5 ? "|" : "-")
      }
    }
  }

  return { grid, size, er: p.er, ec: p.ec }
}

/** Guaranteed-solvable symmetric fallback (rarely used). */
function generateFallback(difficulty: number, _seed: number): Puzzle {
  const size = SIZE_BY_DIFF[clamp(difficulty, 1, 10) - 1]
  const grid: Cell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ type: "EMPTY", orient: "" })),
  )
  const R = Math.floor(size / 2)
  const C = Math.floor(size / 2)
  const arm = clamp(2, 2, Math.min(C, size - 1 - C))
  const height = clamp(2, 1, R)
  const reserved = new Set<string>()
  const key = (r: number, c: number) => `${r},${c}`
  const reserve = (r: number, c: number) => reserved.add(key(r, c))

  grid[R][C] = { type: "EMITTER", orient: "<>" }
  reserve(R, C)
  const critical = [
    { r: R, c: C - arm, solved: "\\" },
    { r: R - height, c: C - arm, solved: "/" },
    { r: R, c: C + arm, solved: "/" },
    { r: R - height, c: C + arm, solved: "\\" },
  ]
  for (let c = C - 1; c > C - arm; c--) reserve(R, c)
  for (let r = R - 1; r > R - height; r--) reserve(r, C - arm)
  for (let c = C - arm + 1; c < C; c++) reserve(R - height, c)
  for (let c = C + 1; c < C + arm; c++) reserve(R, c)
  for (let r = R - 1; r > R - height; r--) reserve(r, C + arm)
  for (let c = C + 1; c < C + arm; c++) reserve(R - height, c)
  reserve(R - height, C)
  for (const m of critical) {
    reserve(m.r, m.c)
    grid[m.r][m.c] = mkMirror(m.solved === "/" ? "\\" : "/")
  }
  return { grid, size, er: R, ec: C }
}

/* --------------------------- simulation --------------------------- */

/**
 * One tick. A mirror redirects the chevron as it *leaves* the cell it is
 * sitting in - so the player can keep rotating a mirror while the chevron is
 * inside it, right up until it steps out. Pipes and walls are barriers: the
 * chevron never enters them, it bounces (or is sliced) at the boundary.
 * `angle` accumulates so the arrow can pivot smoothly through turns.
 */
function step(grid: Cell[][], chevrons: Chevron[], size: number): Chevron[] {
  return chevrons.map((ch) => {
    if (!ch.alive) return ch
    const cell = grid[ch.r][ch.c]
    // mirror bends the chevron on the way out of its current cell
    const outDir = cell.type === "MIRROR" ? reflect(ch.dir, cell.orient) : ch.dir

    const [dr, dc] = DELTA[outDir]
    const nr = ch.r + dr
    const nc = ch.c + dc

    // ran into the wall
    if (nr < 0 || nc < 0 || nr >= size || nc >= size) {
      return { ...ch, dir: outDir, angle: turnAngle(ch.angle, ch.dir, outDir), alive: false }
    }

    const dest = grid[nr][nc]
    if (dest.type === "PIPE") {
      const horizontal = outDir === "LEFT" || outDir === "RIGHT"
      const vertBar = dest.orient === "|"
      const slice = (vertBar && !horizontal) || (!vertBar && horizontal)
      if (slice) {
        return { ...ch, dir: outDir, angle: turnAngle(ch.angle, ch.dir, outDir), alive: false }
      }
      // bounce off the flat face: stay put and reverse, never enter the pipe
      const back = OPPOSITE[outDir]
      return { ...ch, dir: back, angle: turnAngle(ch.angle, ch.dir, back), pr: ch.r, pc: ch.c }
    }

    // step into the empty / emitter / mirror cell
    return {
      ...ch,
      r: nr,
      c: nc,
      dir: outDir,
      angle: turnAngle(ch.angle, ch.dir, outDir),
      pr: ch.r,
      pc: ch.c,
    }
  })
}

// Which face of a diagonal mirror a chevron is on, from its incoming direction.
// Two chevrons on the SAME face meet head-on (a hit); on OPPOSITE faces the
// mirror deflects them apart (a miss).
function mirrorSide(dir: Dir, orient: string): number {
  if (orient === "/") return dir === "RIGHT" || dir === "DOWN" ? 0 : 1
  return dir === "RIGHT" || dir === "UP" ? 0 : 1 // "\\"
}

// Collisions:
//  - same cell: always a win in an open cell; on a mirror only when both hit
//    the same face (opposite faces deflect apart; a pipe is never entered).
//  - crossing head-on through a shared edge (a swap): always a real hit.
function collided(next: Chevron[], grid: Cell[][]): boolean {
  const live = next.filter((c) => c.alive)
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]
      const b = live[j]
      if (a.r === b.r && a.c === b.c) {
        const cell = grid[a.r][a.c]
        if (cell.type === "EMPTY" || cell.type === "EMITTER") return true
        if (
          cell.type === "MIRROR" &&
          mirrorSide(a.dir, cell.orient) === mirrorSide(b.dir, cell.orient)
        )
          return true
      }
      if (a.r === b.pr && a.c === b.pc && b.r === a.pr && b.c === a.pc)
        return true
    }
  }
  return false
}

/* --------------------------- progression -------------------------- */

function todaySeed(): number {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}
const dailyDifficulty = () => 3 + (todaySeed() % 5)
const difficultyForLevel = (lvl: number) => clamp(lvl, 1, 10)
const seedForLevel = (lvl: number) => (lvl * 2654435761) >>> 0

function loadLevel(): number {
  try {
    const v = Number(localStorage.getItem("bloc.level"))
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1
  } catch {
    return 1
  }
}
function loadMode(): Mode {
  try {
    return localStorage.getItem("bloc.mode") === "DAILY" ? "DAILY" : "ENDLESS"
  } catch {
    return "ENDLESS"
  }
}
function loadItems(): Set<ItemType> {
  try {
    const raw = localStorage.getItem("bloc.items") ?? ""
    return new Set(raw.split(",").filter((t): t is ItemType =>
      (ITEM_TYPES as string[]).includes(t),
    ))
  } catch {
    return new Set()
  }
}
// how many items you should own by a given endless level (one per 5, capped)
const itemsDue = (levelNo: number) => Math.min(3, Math.floor(levelNo / 5))
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode, quota) - ignore */
  }
}

/* ------------------------------ animals --------------------------- */

// endless starts with 1 animal from the very first level and adds more the
// deeper you go; the daily always has a steady few
const animalCountForLevel = (lvl: number) =>
  Math.min(4, 1 + Math.floor((lvl - 1) / 7))

// base seed, grid size and animal count for the current board
function animalPlan(
  mode: Mode,
  levelNo: number,
): { base: number; size: number; count: number } {
  if (mode === "DAILY") {
    const day = todaySeed()
    return {
      base: (day ^ 0x9e3779b1) >>> 0,
      size: SIZE_BY_DIFF[dailyDifficulty() - 1],
      count: 2 + (day % 2), // 2-3 animals, same for everyone that day
    }
  }
  return {
    base: (seedForLevel(levelNo) ^ 0x9e3779b1) >>> 0,
    size: SIZE_BY_DIFF[difficultyForLevel(levelNo) - 1],
    count: animalCountForLevel(levelNo),
  }
}

// rng that drives the live attack pattern (targets, timing)
const animalRngSeed = (mode: Mode, levelNo: number) =>
  (animalPlan(mode, levelNo).base ^ 0x2545f491) >>> 0
const animalRng = (mode: Mode, levelNo: number) =>
  mulberry32(animalRngSeed(mode, levelNo))

function makeAnimals(mode: Mode, levelNo: number): Animal[] {
  const { base, size, count } = animalPlan(mode, levelNo)
  if (!count) return []
  const rng = mulberry32(base)
  const sides: AnimalSide[] = ["left", "right", "top", "bottom"]
  const out: Animal[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: i,
      side: sides[Math.floor(rng() * 4)],
      emoji: ANIMAL_EMOJIS[Math.floor(rng() * ANIMAL_EMOJIS.length)],
      phase: "REST",
      ticksLeft: 3 + i * 2 + Math.floor(rng() * 3), // stagger first strikes
      line: Math.floor(rng() * size),
    })
  }
  return out
}

interface Nuke {
  axis: "row" | "col"
  index: number
}

/** Advance every animal one tick; returns the new animals and any lines fired. */
function stepAnimals(
  animals: Animal[],
  rng: () => number,
  size: number,
): { next: Animal[]; fired: Nuke[] } {
  const fired: Nuke[] = []
  const next = animals.map((a) => {
    let ticksLeft = a.ticksLeft - 1
    let phase = a.phase
    let line = a.line
    if (ticksLeft <= 0) {
      if (phase === "REST") {
        phase = "TELEGRAPH"
        ticksLeft = TELEGRAPH_TICKS
        line = Math.floor(rng() * size) // zoom over to a fresh row/col
      } else if (phase === "TELEGRAPH") {
        phase = "FIRE"
        ticksLeft = 1
        fired.push({
          axis: a.side === "left" || a.side === "right" ? "row" : "col",
          index: line,
        })
      } else {
        phase = "REST"
        ticksLeft = REST_MIN + Math.floor(rng() * REST_VAR)
      }
    }
    return { ...a, ticksLeft, phase, line }
  })
  return { next, fired }
}

/**
 * Build a level and its animals together, guaranteeing feasibility. Find a
 * winding path whose solved solution survives the animals; if none can be
 * found, drop the animals one at a time (with none, a valid path always wins),
 * so a level is never impossible.
 */
function buildLevel(
  mode: Mode,
  levelNo: number,
): { puzzle: Puzzle; animals: Animal[] } {
  const fullAnimals = makeAnimals(mode, levelNo)
  const rngSeed = animalRngSeed(mode, levelNo)
  const difficulty =
    mode === "DAILY" ? dailyDifficulty() : difficultyForLevel(levelNo)
  const seed = mode === "DAILY" ? todaySeed() : seedForLevel(levelNo)

  for (let n = fullAnimals.length; n >= 0; n--) {
    const animals = fullAnimals.slice(0, n)
    for (let att = 0; att < 60; att++) {
      const cand = generateWinding(difficulty, (seed + att * 0x9e3779b1) >>> 0)
      if (cand && survivesAnimals(cand, animals, rngSeed)) {
        return { puzzle: finalizePuzzle(cand, difficulty, seed), animals }
      }
    }
  }
  return { puzzle: generateFallback(difficulty, seed), animals: [] }
}

/* ------------------------------ game ------------------------------ */

export default function BlocGame() {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [levelNo, setLevelNo] = useState<number>(loadLevel)
  const [rebuild, setRebuild] = useState(0)
  // puzzle + animals are built together so the level is guaranteed feasible
  const [initial] = useState(() => buildLevel(loadMode(), loadLevel()))
  const [puzzle, setPuzzle] = useState<Puzzle>(initial.puzzle)
  const [grid, setGrid] = useState<Cell[][]>(() => puzzle.grid)
  const [chevrons, setChevrons] = useState<Chevron[]>([])
  const [status, setStatus] = useState<Status>("IDLE")
  // true only during the final slice of each tick - a block locks just as the
  // chevron is about to leave it, so you can rotate it until it's deep inside
  const [committing, setCommitting] = useState(false)
  const [animals, setAnimals] = useState<Animal[]>(initial.animals)

  // items: a collection you build one-of-each of (endless only). `used` tracks
  // which you've spent on the current board; `armed` is a tapped-but-not-yet-
  // placed cube; `drag` is a cube being dragged; `pick` is the reward chooser.
  const [owned, setOwned] = useState<Set<ItemType>>(loadItems)
  const [used, setUsed] = useState<Set<ItemType>>(() => new Set())
  const [armed, setArmed] = useState<ItemType | null>(null)
  const [drag, setDrag] = useState<{ type: ItemType; x: number; y: number } | null>(null)
  const [pick, setPick] = useState<ItemType[] | null>(null)
  const dragRef = useRef<{ type: ItemType; sx: number; sy: number; moved: boolean } | null>(null)

  // fast-forward: doubles the tick rate for longer boards
  const [fast, setFast] = useState(() => {
    try {
      return localStorage.getItem("bloc.fast") === "1"
    } catch {
      return false
    }
  })
  const speed = fast ? 2 : 1
  const tickMs = Math.round(TICK_MS / speed)
  const speedRef = useRef(speed)
  speedRef.current = speed

  // background music: starts (and fades in) on the first interaction, loops
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem("bloc.muted") === "1"
    } catch {
      return false
    }
  })
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const gridRef = useRef(grid)
  const animalsRef = useRef(animals)
  const animalRngRef = useRef<(() => number) | null>(null)
  // the feasible animal set for this level, to restore after a loss
  const levelAnimalsRef = useRef<Animal[]>(initial.animals)
  animalsRef.current = animals
  const chevRef = useRef(chevrons)
  const puzzleRef = useRef(puzzle)
  const statusRef = useRef(status)
  const tickRef = useRef(0)
  gridRef.current = grid
  chevRef.current = chevrons
  puzzleRef.current = puzzle
  statusRef.current = status

  // size the board to the viewport so it never overflows (esp. on mobile)
  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1024,
    h: typeof window !== "undefined" ? window.innerHeight : 768,
  }))
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener("resize", onResize)
    window.addEventListener("orientationchange", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      window.removeEventListener("orientationchange", onResize)
    }
  }, [])

  const size = puzzle.size
  // leave room for the top corner UI (height), side margins (width), and a
  // little extra all round for the animals that prowl outside the grid
  const reserve = animals.length > 0 ? 48 : 0
  const avail = Math.min(vp.w - 32 - reserve, vp.h - 96 - reserve)
  const stride0 = Math.max(26, avail / size)
  const cellPx = clamp(Math.round(stride0 * 0.84), 22, 64)
  const gap = clamp(Math.round(stride0 * 0.16), 3, 10)
  const stride = cellPx + gap
  const chevronPx = Math.round(cellPx * 0.46) // same size resting or flying

  /* persist progress */
  useEffect(() => {
    save("bloc.level", String(levelNo))
  }, [levelNo])
  useEffect(() => {
    save("bloc.mode", mode)
  }, [mode])
  useEffect(() => {
    save("bloc.fast", fast ? "1" : "0")
  }, [fast])
  useEffect(() => {
    save("bloc.items", [...owned].join(","))
  }, [owned])

  /* every 5 endless levels, offer a pick of the items you don't own yet
     (one of each, max three) - shown as the new board loads */
  useEffect(() => {
    if (mode !== "ENDLESS") {
      setPick(null)
      return
    }
    setOwned((cur) => {
      if (cur.size < itemsDue(levelNo) && cur.size < ITEM_TYPES.length) {
        setPick(ITEM_TYPES.filter((t) => !cur.has(t)))
      }
      return cur
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelNo, mode, rebuild])

  /* background music: created up front, started (browsers block autoplay) on
     the first interaction, then faded in and looped */
  useEffect(() => {
    initAudio(mutedRef.current)
    const onGesture = () => startMusic(mutedRef.current)
    window.addEventListener("pointerdown", onGesture)
    window.addEventListener("keydown", onGesture)
    return () => {
      window.removeEventListener("pointerdown", onGesture)
      window.removeEventListener("keydown", onGesture)
    }
  }, [])

  useEffect(() => {
    save("bloc.muted", muted ? "1" : "0")
    setMusicMuted(muted)
  }, [muted])

  /* arrow keys toggle fast-forward (up/right = 2x, down/left = normal) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        setFast(true)
        e.preventDefault()
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        setFast(false)
        e.preventDefault()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /* (re)build board when level / mode / rebuild changes */
  useEffect(() => {
    const { puzzle: p, animals: a } = buildLevel(mode, levelNo)
    setPuzzle(p)
    setGrid(p.grid)
    setChevrons([])
    setStatus("IDLE")
    tickRef.current = 0
    setAnimals(a)
    setUsed(new Set()) // fresh board: your items come back
    setArmed(null)
    levelAnimalsRef.current = a
    animalRngRef.current = a.length ? animalRng(mode, levelNo) : null
    restartMusic() // fresh level, restart the track from the top (no-op if idle)
  }, [mode, levelNo, rebuild])

  /* game loop - emit immediately, then tick (self-scheduling so the speed can
     change mid-run without restarting the loop / re-emitting) */
  useEffect(() => {
    if (status !== "PLAYING") {
      setCommitting(false)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let commitTimer: ReturnType<typeof setTimeout> | undefined

    const advance = () => {
      if (statusRef.current !== "PLAYING") return
      tickRef.current += 1
      const size = puzzleRef.current.size
      const g0 = gridRef.current
      const next = step(g0, chevRef.current, size)
      const won = collided(next, g0)

      // flip items: a block toggles the first time a chevron touches it - as a
      // chevron leaves a mirror, or bounces off / is sliced by a pipe. `next`
      // was computed on the old orientation, so this chevron used it as-is and
      // the change only affects whoever arrives next.
      const toggles: [number, number][] = []
      for (const ch of chevRef.current) {
        if (!ch.alive) continue
        const cur = g0[ch.r][ch.c]
        if (cur.type === "MIRROR" && cur.flip && !cur.flipped) toggles.push([ch.r, ch.c])
        const outDir = cur.type === "MIRROR" ? reflect(ch.dir, cur.orient) : ch.dir
        const [dr, dc] = DELTA[outDir]
        const nr = ch.r + dr
        const nc = ch.c + dc
        if (nr >= 0 && nc >= 0 && nr < size && nc < size) {
          const dest = g0[nr][nc]
          if (dest.type === "PIPE" && dest.flip && !dest.flipped) toggles.push([nr, nc])
        }
      }
      if (toggles.length) setGrid((prev) => applyFlips(prev, toggles))

      // advance animals; a nuke kills any chevron caught on the fired line
      const rng = animalRngRef.current
      if (rng && animalsRef.current.length) {
        const res = stepAnimals(animalsRef.current, rng, size)
        setAnimals(res.next)
        if (res.fired.length) playBell(mutedRef.current) // laser -> bell chime
        if (!won && res.fired.length) {
          for (const f of res.fired) {
            for (const ch of next) {
              if (
                ch.alive &&
                ((f.axis === "row" && ch.r === f.index) ||
                  (f.axis === "col" && ch.c === f.index))
              ) {
                ch.alive = false
              }
            }
          }
        }
      }

      setChevrons(next)
      const tick = TICK_MS / speedRef.current
      // unlock at the start of the tick, re-lock once the chevron is deep in
      setCommitting(false)
      clearTimeout(commitTimer)
      commitTimer = setTimeout(() => setCommitting(true), tick * LOCK_FRAC)
      if (won) setStatus("WON")
      else if (next.some((c) => !c.alive)) setStatus("LOST")
      else if (tickRef.current > MAX_TICKS) setStatus("LOST")
      else timer = setTimeout(advance, tick) // schedule the next tick
    }

    const raf = requestAnimationFrame(() => {
      advance() // chevrons leave the emitter box right away
    })
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      clearTimeout(commitTimer)
    }
  }, [status])

  /* resolve WON / LOST */
  useEffect(() => {
    if (status === "WON") {
      playWin(mutedRef.current)
      duckMusic()
      const t = setTimeout(() => {
        if (mode === "ENDLESS") setLevelNo((n) => n + 1)
        else setRebuild((k) => k + 1)
      }, 1450)
      return () => clearTimeout(t)
    }
    if (status === "LOST") {
      playLose(mutedRef.current)
      duckMusic()
      // keep the player's rotations; just clear the run so they can adjust
      const t = setTimeout(() => {
        setChevrons([])
        setCommitting(false)
        // re-arm any flip items that fired, restoring their pre-fire orientation
        setGrid((prev) =>
          prev.map((row) =>
            row.map((cell) =>
              cell.flip && cell.flipped
                ? { ...toggleOrient(cell), flipped: false }
                : cell,
            ),
          ),
        )
        // restore this level's feasible animal set in its initial state
        const fresh = levelAnimalsRef.current.map((a) => ({ ...a }))
        setAnimals(fresh)
        animalRngRef.current = fresh.length ? animalRng(mode, levelNo) : null
        restoreMusic() // same level, so bring the track back (not restarted)
        setStatus("IDLE")
      }, 750)
      return () => clearTimeout(t)
    }
  }, [status, mode, levelNo])

  // only the cell a chevron is about to leave locks (for rotation), late in tick
  const locked = useMemo(() => {
    const s = new Set<string>()
    if (!committing) return s
    for (const ch of chevrons) if (ch.alive) s.add(`${ch.r},${ch.c}`)
    return s
  }, [committing, chevrons])

  // every cell a chevron currently sits on lights up (strong blue glitter)
  const energized = useMemo(() => {
    const s = new Set<string>()
    if (status !== "PLAYING") return s
    for (const ch of chevrons) if (ch.alive) s.add(`${ch.r},${ch.c}`)
    return s
  }, [status, chevrons])

  const start = () => {
    const p = puzzleRef.current
    tickRef.current = 0
    setCommitting(false)
    setChevrons([
      { id: 0, r: p.er, c: p.ec, dir: "LEFT", pr: p.er, pc: p.ec, alive: true, angle: 180 },
      { id: 1, r: p.er, c: p.ec, dir: "RIGHT", pr: p.er, pc: p.ec, alive: true, angle: 0 },
    ])
    setStatus("PLAYING")
  }

  // where can a given cube land? clear/flip need a block; slash needs a gap.
  const placementValid = (type: ItemType, cell: Cell) => {
    if (cell.type === "EMITTER") return false
    if (type === "SLASH") return cell.type === "EMPTY"
    if (type === "FLIP")
      return (cell.type === "MIRROR" || cell.type === "PIPE") && !cell.flip
    return cell.type === "MIRROR" || cell.type === "PIPE" // CLEAR
  }

  const placeItem = (type: ItemType, r: number, c: number) => {
    if (!owned.has(type) || used.has(type)) return
    if (!placementValid(type, gridRef.current[r][c])) return
    setGrid((prev) => {
      const g = prev.map((row) => row.slice())
      const cell = g[r][c]
      if (type === "CLEAR") g[r][c] = { type: "EMPTY", orient: "" }
      else if (type === "FLIP") g[r][c] = { ...cell, flip: true, flipped: false }
      else if (type === "SLASH") g[r][c] = { ...mkMirror("/"), player: true }
      return g
    })
    setUsed((prev) => new Set(prev).add(type))
    setArmed(null)
  }

  // drag a cube from the tray onto a square (works with mouse + touch); a tap
  // with no movement instead "arms" the cube so the next square-tap places it.
  const onCubeDown = (e: React.PointerEvent, type: ItemType) => {
    if (used.has(type)) return
    dragRef.current = { type, sx: e.clientX, sy: e.clientY, moved: false }
    setDrag({ type, x: e.clientX, y: e.clientY })
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (Math.abs(ev.clientX - d.sx) > 6 || Math.abs(ev.clientY - d.sy) > 6)
        d.moved = true
      setDrag((p) => (p ? { ...p, x: ev.clientX, y: ev.clientY } : p))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d) return
      if (!d.moved) {
        setArmed((cur) => (cur === d.type ? null : d.type)) // tap = arm/disarm
        return
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const cellEl = el?.closest("[data-cell]") as HTMLElement | null
      if (cellEl) {
        const r = Number(cellEl.dataset.r)
        const c = Number(cellEl.dataset.c)
        if (Number.isFinite(r) && Number.isFinite(c)) placeItem(d.type, r, c)
      }
      setArmed(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const handleCell = (r: number, c: number) => {
    const t = grid[r][c]
    if (armed) {
      if (placementValid(armed, t)) placeItem(armed, r, c)
      else setArmed(null)
      return
    }
    if (t.type === "EMITTER") {
      if (status === "IDLE") start()
      return
    }
    if (t.type !== "MIRROR" && t.type !== "PIPE") return
    if (status === "WON" || status === "LOST") return
    if (status === "PLAYING" && locked.has(`${r},${c}`)) return
    setGrid((prev) => {
      const g = prev.map((row) => row.slice())
      const cell = g[r][c]
      const orient =
        cell.type === "MIRROR"
          ? cell.orient === "/"
            ? "\\"
            : "/"
          : cell.orient === "|"
            ? "-"
            : "|"
      // always +90 so the glyph keeps spinning the same way, never snaps back
      g[r][c] = { ...cell, orient, rot: (cell.rot ?? rotOf(cell.orient)) + 90 }
      return g
    })
  }

  const boardPx = size * cellPx + (size - 1) * gap

  // centre point of the collision, for the win pulse
  const burst = useMemo(() => {
    if (status !== "WON" || chevrons.length === 0) return null
    const mr = chevrons.reduce((a, c) => a + c.r, 0) / chevrons.length
    const mc = chevrons.reduce((a, c) => a + c.c, 0) / chevrons.length
    return { x: mc * stride + cellPx / 2, y: mr * stride + cellPx / 2 }
  }, [status, chevrons, stride, cellPx])

  // the cell where a chevron died, for the loss ripple
  const deathPoint = useMemo(() => {
    if (status !== "LOST") return null
    const dead = chevrons.find((c) => !c.alive)
    if (!dead) return null
    return { x: dead.c * stride + cellPx / 2, y: dead.r * stride + cellPx / 2 }
  }, [status, chevrons, stride, cellPx])

  return (
    <div className="relative isolate flex min-h-svh w-full touch-manipulation items-center justify-center overflow-auto bg-background p-4 select-none">
      {/* settings + mute */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-1">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Settings">
              <Settings2 className="size-5 text-muted-foreground" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="gap-6">
            <SheetHeader>
              <SheetTitle className="font-mono tracking-tight">chevro</SheetTitle>
              <SheetDescription className="font-mono text-xs">
                route the chevrons together
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-6 px-4">
              <div className="flex flex-col gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  mode
                </span>
                <div className="flex gap-2">
                  {(["ENDLESS", "DAILY"] as Mode[]).map((m) => (
                    <Button
                      key={m}
                      variant={mode === m ? "default" : "outline"}
                      size="sm"
                      disabled={status === "PLAYING"}
                      className="flex-1 font-mono"
                      onClick={() => setMode(m)}
                    >
                      {m.toLowerCase()}
                    </Button>
                  ))}
                </div>
              </div>

              {mode === "ENDLESS" && (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    progress
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={status === "PLAYING" || levelNo === 1}
                    className="justify-start gap-2 font-mono"
                    onClick={() => setLevelNo(1)}
                  >
                    <Trophy className="size-4" />
                    reset to level 1
                  </Button>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
        <Button
          variant="ghost"
          size="icon"
          aria-label={muted ? "Unmute music" : "Mute music"}
          aria-pressed={muted}
          onClick={() => setMuted((m) => !m)}
        >
          {muted ? (
            <VolumeX className="size-5 text-muted-foreground" />
          ) : (
            <Volume2 className="size-5 text-sky-500" />
          )}
        </Button>
      </div>

      {/* ambient glow behind the board (clipped so it never adds scroll) */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-200/25 blur-[90px]" />
      </div>

      {/* level number + reset */}
      <div className="absolute top-5 right-6 z-20 flex flex-col items-end gap-1 select-none">
        <span
          key={mode === "DAILY" ? "daily" : levelNo}
          className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground/70"
          style={{ animation: "bloc-bump 400ms ease-out" }}
        >
          {mode === "DAILY" ? "daily" : String(levelNo).padStart(2, "0")}
        </span>
        <button
          onClick={() => setRebuild((k) => k + 1)}
          aria-label="Reset level"
          className="flex items-center gap-1 font-mono text-xs text-muted-foreground/60 transition-colors hover:text-sky-500"
        >
          <RotateCcw className="size-3" />
          reset
        </button>
      </div>

      {/* fast-forward (tap on mobile, or arrow keys on desktop) */}
      <button
        onClick={() => setFast((f) => !f)}
        aria-label={fast ? "Normal speed" : "Double speed"}
        aria-pressed={fast}
        className={cn(
          "absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-4 py-2 font-mono text-sm tabular-nums transition-colors",
          fast
            ? "border-sky-400 bg-sky-500 text-white shadow-[0_8px_22px_-8px_rgba(14,165,233,0.8)]"
            : "border-slate-200 bg-white/70 text-slate-500 backdrop-blur hover:border-sky-400 hover:text-sky-500",
        )}
      >
        <FastForward className="size-4" fill={fast ? "currentColor" : "none"} />
        {fast ? "2×" : "1×"}
      </button>

      {/* item tray - drag a cube onto a square, or tap it then tap a square */}
      {mode === "ENDLESS" && owned.size > 0 && (
        <div className="absolute bottom-5 left-4 z-20 flex items-center gap-2 select-none">
          {ITEM_TYPES.filter((t) => owned.has(t)).map((t) => {
            const m = ITEM_META[t]
            const spent = used.has(t)
            const isArmed = armed === t
            return (
              <button
                key={t}
                type="button"
                aria-label={`${m.name}: ${m.blurb}`}
                aria-pressed={isArmed}
                disabled={spent}
                onPointerDown={(e) => onCubeDown(e, t)}
                className={cn(
                  "relative flex size-11 touch-none items-center justify-center rounded-2xl border-2 shadow-sm transition-all",
                  spent
                    ? "border-slate-200 bg-slate-50 text-slate-300 opacity-50"
                    : cn(
                        m.chip,
                        "cursor-grab hover:-translate-y-0.5 active:cursor-grabbing",
                      ),
                  isArmed && cn(m.ring, "-translate-y-0.5 animate-pulse ring-2 ring-offset-2"),
                )}
              >
                <m.Icon className="size-5" />
              </button>
            )
          })}
        </div>
      )}

      {/* the cube following the pointer while dragging */}
      {drag &&
        (() => {
          const m = ITEM_META[drag.type]
          return (
            <div
              className={cn(
                "pointer-events-none fixed z-50 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border-2 shadow-lg",
                m.chip,
              )}
              style={{ left: drag.x, top: drag.y }}
            >
              <m.Icon className="size-5" />
            </div>
          )
        })()}

      {/* reward chooser: pick one of the items you don't own yet */}
      {pick && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-white/70 p-6 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-5 rounded-3xl border border-slate-100 bg-white p-7 shadow-[0_30px_80px_-30px_rgba(2,132,199,0.45)] animate-in zoom-in-95 duration-200">
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-mono text-lg font-semibold tracking-tight text-slate-800">
                new item
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                pick one to keep
              </span>
            </div>
            <div className="flex gap-3">
              {pick.map((t) => {
                const m = ITEM_META[t]
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setOwned((cur) => new Set(cur).add(t))
                      setPick(null)
                    }}
                    className={cn(
                      "flex w-28 flex-col items-center gap-2 rounded-2xl border-2 p-4 text-center transition-all hover:-translate-y-1 hover:shadow-lg",
                      m.chip,
                    )}
                  >
                    <m.Icon className="size-7" />
                    <span className="font-mono text-sm font-semibold">{m.name}</span>
                    <span className="font-mono text-[10px] leading-tight text-slate-500">
                      {m.blurb}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* board - dissolves on a win so the chevrons fly off into open space */}
      <div
        style={{ animation: status === "LOST" ? "bloc-shake 450ms ease-in-out" : "none" }}
        className={cn(
          "relative rounded-[28px] border p-3 transition-[box-shadow,background-color,border-color,transform] duration-500",
          status === "WON"
            ? "scale-[1.03] border-transparent bg-transparent shadow-none"
            : "border-slate-100 bg-white/60 shadow-[0_20px_60px_-30px_rgba(2,132,199,0.35)] backdrop-blur-sm",
          status === "LOST" &&
            "border-rose-300 shadow-[0_0_0_3px_rgba(244,63,94,0.5),0_20px_60px_-30px_rgba(244,63,94,0.4)]",
        )}
      >
        <div
          key={`${mode}-${levelNo}-${rebuild}`}
          className="relative animate-in fade-in zoom-in-95 duration-300"
          style={{ width: boardPx, height: boardPx }}
        >
          {/* tiles fade away on a win */}
          <div
            className="grid transition-opacity duration-500"
            style={{
              gridTemplateColumns: `repeat(${size}, ${cellPx}px)`,
              gridTemplateRows: `repeat(${size}, ${cellPx}px)`,
              gap: `${gap}px`,
              opacity: status === "WON" ? 0 : 1,
            }}
          >
            {grid.map((row, r) =>
              row.map((cell, c) => (
                <CellTile
                  key={`${r}-${c}`}
                  cell={cell}
                  r={r}
                  c={c}
                  size={cellPx}
                  chevronPx={chevronPx}
                  hideEmitter={status !== "IDLE"}
                  emitterCue={status === "IDLE"}
                  active={energized.has(`${r},${c}`)}
                  targetable={armed !== null && placementValid(armed, cell)}
                  onClick={() => handleCell(r, c)}
                />
              )),
            )}
          </div>

          {/* nuke beams - telegraph glow, then a bright flash on fire */}
          {(status === "PLAYING" || status === "LOST") &&
            animals.map((a) => {
              if (a.phase === "REST") return null
              const row = a.side === "left" || a.side === "right"
              const fire = a.phase === "FIRE"
              return (
                <div
                  key={`beam-${a.id}`}
                  className="pointer-events-none absolute rounded-xl"
                  style={{
                    left: row ? 0 : a.line * stride,
                    top: row ? a.line * stride : 0,
                    width: row ? boardPx : cellPx,
                    height: row ? cellPx : boardPx,
                    background: fire
                      ? "rgba(244,63,94,0.5)"
                      : "rgba(251,146,60,0.16)",
                    border: fire
                      ? "2px solid rgba(244,63,94,0.9)"
                      : "1px solid rgba(251,146,60,0.5)",
                    boxShadow: fire ? "0 0 34px rgba(244,63,94,0.85)" : "none",
                    animation: fire
                      ? "bloc-beam 350ms ease-out"
                      : "bloc-telegraph 700ms ease-in-out infinite",
                  }}
                />
              )
            })}

          {/* the animals themselves, prowling just outside the grid */}
          {animals.map((a) => {
            const off = cellPx * 0.95
            const along = a.line * stride + cellPx / 2
            const x =
              a.side === "left" ? -off : a.side === "right" ? boardPx + off : along
            const y =
              a.side === "top" ? -off : a.side === "bottom" ? boardPx + off : along
            const flip = a.side === "right" ? -1 : 1
            return (
              <div
                key={`animal-${a.id}`}
                className="pointer-events-none absolute left-0 top-0 flex items-center justify-center"
                style={{
                  width: cellPx,
                  height: cellPx,
                  transform: `translate(${x - cellPx / 2}px, ${y - cellPx / 2}px)`,
                  transition:
                    "transform 350ms cubic-bezier(0.3,0,0.2,1), opacity 400ms ease-out",
                  opacity: status === "WON" ? 0 : 1,
                }}
              >
                <span
                  style={{
                    fontSize: Math.round(cellPx * 0.72),
                    lineHeight: 1,
                    display: "inline-block",
                    transform: `scaleX(${flip})`,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      filter:
                        a.phase !== "REST"
                          ? "drop-shadow(0 0 8px rgba(244,63,94,0.85))"
                          : "none",
                      animation:
                        a.phase === "TELEGRAPH"
                          ? "bloc-charge 500ms ease-in-out infinite"
                          : "none",
                    }}
                  >
                    {a.emoji}
                  </span>
                </span>
              </div>
            )
          })}

          {/* loss: red ripple out of the point of contact */}
          {status === "LOST" && deathPoint && (
            <Ripple x={deathPoint.x} y={deathPoint.y} rgb="244,63,94" base={cellPx} />
          )}

          {/* win: green pulse from the meeting point */}
          {status === "WON" && burst && (
            <Ripple x={burst.x} y={burst.y} rgb="16,185,129" base={cellPx * 1.3} />
          )}

          {/* trails - blue comet in play, teal streak flying off on a win */}
          {(status === "PLAYING" || status === "WON") &&
            chevrons.map((ch) => {
              if (!ch.alive) return null
              const flying = status === "WON"
              const [fdr, fdc] = DELTA[OPPOSITE[ch.dir]]
              const tx = flying ? ch.c * stride + fdc * FLY_OFF : ch.c * stride
              const ty = flying ? ch.r * stride + fdr * FLY_OFF : ch.r * stride
              return (
                <div
                  key={`trail-${ch.id}`}
                  className="pointer-events-none absolute left-0 top-0 flex items-center justify-center"
                  style={{
                    width: cellPx,
                    height: cellPx,
                    transform: `translate(${tx}px, ${ty}px)`,
                    transition: flying
                      ? "transform 1300ms cubic-bezier(0.3,0,0.2,1), opacity 1300ms ease-out"
                      : `transform ${Math.round(920 / speed)}ms cubic-bezier(0.4,0,0.2,1)`,
                    opacity: flying ? 0 : 1,
                  }}
                >
                  <div
                    style={{
                      width: cellPx * (flying ? 0.8 : 0.55),
                      height: cellPx * (flying ? 0.8 : 0.55),
                      borderRadius: "9999px",
                      background: flying
                        ? "radial-gradient(circle, rgba(45,212,191,0.7), rgba(45,212,191,0) 70%)"
                        : "radial-gradient(circle, rgba(56,189,248,0.45), rgba(56,189,248,0) 70%)",
                      filter: "blur(3px)",
                    }}
                  />
                </div>
              )
            })}

          {/* chevrons - fly off on a win, linger dim-red at the loss spot */}
          {chevrons.map((ch) => {
            const flying = status === "WON" && ch.alive
            const [fdr, fdc] = DELTA[OPPOSITE[ch.dir]]
            const tx = flying ? ch.c * stride + fdc * FLY_OFF : ch.c * stride
            const ty = flying ? ch.r * stride + fdr * FLY_OFF : ch.r * stride
            return (
              <div
                key={ch.id}
                className="pointer-events-none absolute left-0 top-0 flex items-center justify-center"
                style={{
                  width: cellPx,
                  height: cellPx,
                  transform: `translate(${tx}px, ${ty}px)`,
                  transition: flying
                    ? "transform 950ms cubic-bezier(0.4,0,0.85,0.5), opacity 950ms ease-in"
                    : status === "PLAYING"
                      ? `transform ${tickMs}ms linear`
                      : "none",
                  opacity: flying ? 0 : 1,
                }}
              >
                <ChevronMark
                  px={chevronPx}
                  turnMs={Math.round(TURN_MS / speed)}
                  angle={ch.angle + (flying ? 180 : 0)}
                  animate={status === "PLAYING" || flying}
                  dead={!ch.alive}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ ripple ---------------------------- */

// concentric rings that expand and fade from a point (win pulse / loss hit)
function Ripple({
  x,
  y,
  rgb,
  base,
}: {
  x: number
  y: number
  rgb: string
  base: number
}) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="pointer-events-none absolute rounded-full"
          style={{
            left: x,
            top: y,
            width: base,
            height: base,
            border: `2px solid rgba(${rgb},0.85)`,
            opacity: 0,
            animation: `bloc-burst 800ms cubic-bezier(0.2,0.6,0.3,1) ${i * 160}ms forwards`,
          }}
        />
      ))}
    </>
  )
}

/* ---------------------------- cell tile --------------------------- */

// mirror / pipe are one base glyph drawn rotated, so a click spins it 90°
function blockFor(cell: Cell): { base: string; cls: string } | null {
  if (cell.type === "MIRROR") {
    const cls = cell.flip
      ? ITEM_META.FLIP.glyph
      : cell.player
        ? ITEM_META.SLASH.glyph
        : "text-slate-600"
    return { base: "/", cls }
  }
  if (cell.type === "PIPE") {
    return { base: "|", cls: cell.flip ? ITEM_META.FLIP.glyph : "text-slate-400" }
  }
  return null
}

function CellTile({
  cell,
  r,
  c,
  size,
  chevronPx,
  active,
  targetable,
  hideEmitter,
  emitterCue,
  onClick,
}: {
  cell: Cell
  r: number
  c: number
  size: number
  chevronPx: number
  active: boolean
  targetable: boolean
  hideEmitter: boolean
  emitterCue: boolean
  onClick: () => void
}) {
  const block = blockFor(cell)
  const clickable = cell.type === "EMITTER" || block !== null || targetable
  const label =
    cell.type === "EMITTER"
      ? "Emitter, launch the chevrons"
      : cell.type === "MIRROR"
        ? `Mirror ${cell.orient}, tap to rotate`
        : cell.type === "PIPE"
          ? `Pipe ${cell.orient}, tap to rotate`
          : "Empty cell"
  return (
    <button
      onClick={onClick}
      aria-label={label}
      tabIndex={clickable ? 0 : -1}
      data-cell=""
      data-r={r}
      data-c={c}
      style={{ width: size, height: size }}
      className={cn(
        "group relative touch-manipulation overflow-hidden rounded-2xl border border-border bg-white transition-[border-color,box-shadow,transform] duration-200",
        clickable
          ? "cursor-pointer hover:-translate-y-0.5 hover:border-sky-400 hover:shadow-[0_6px_16px_-6px_rgba(2,132,199,0.45)] active:translate-y-0 active:scale-[0.94]"
          : "cursor-default",
        "focus:outline-none focus-visible:border-sky-400",
        // a placed flip / player block gets a faint tinted ring so it reads
        cell.flip && "ring-1 ring-amber-300/70",
        cell.player && "ring-1 ring-teal-300/60",
        // a chevron sitting here energises the tile: strong blue glitter + glow
        active &&
          "border-sky-400 shadow-[0_0_22px_-2px_rgba(56,189,248,0.75)] ring-2 ring-sky-400/70",
        // a valid drop target while a cube is armed: a dashed pulsing outline
        targetable &&
          "border-sky-400 ring-2 ring-sky-400/80 ring-offset-1 animate-pulse",
      )}
    >
      <PixelCanvas
        gap={7}
        speed={40}
        colors={PIXEL_COLORS}
        variant="icon"
        active={active}
        style={
          active
            ? { filter: "brightness(1.3) saturate(1.4)", opacity: 1 }
            : undefined
        }
      />
      {cell.type === "EMITTER" ? (
        // the two chevrons that will launch - same entity as the flying ones
        <span
          className="relative z-10 flex h-full w-full items-center justify-center gap-[0.15em] transition-opacity duration-300 select-none"
          style={{
            opacity: hideEmitter ? 0 : 1,
            animation: emitterCue ? "bloc-breathe 2.4s ease-in-out infinite" : "none",
          }}
        >
          <ChevronMark px={chevronPx} angle={180} animate={false} />
          <ChevronMark px={chevronPx} angle={0} animate={false} />
        </span>
      ) : block ? (
        <span
          className={cn(
            "relative z-10 flex h-full w-full items-center justify-center font-mono font-black select-none",
            block.cls,
          )}
          style={{
            fontSize: Math.round(size * 0.5),
            transform: `rotate(${cell.rot ?? rotOf(cell.orient)}deg)`,
            transition: "transform 220ms cubic-bezier(0.34,1.56,0.64,1)",
          }}
        >
          {block.base}
        </span>
      ) : null}
    </button>
  )
}
