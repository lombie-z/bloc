import { useEffect, useMemo, useRef, useState } from "react"
import { RotateCcw, Settings2, Trophy } from "lucide-react"
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
}: {
  px: number
  angle: number
  animate: boolean
  dead?: boolean
}) {
  return (
    <span
      className={cn("font-mono font-black", dead ? "text-rose-400" : "text-sky-500")}
      style={{
        fontSize: px,
        lineHeight: 1,
        opacity: dead ? 0.65 : 1,
        transform: `rotate(${angle}deg)`,
        transition: animate ? `transform ${TURN_MS}ms ease-out` : "none",
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

/** Simulate the solved board; returns true if the chevrons collide. */
function isSolvable(p: Puzzle): boolean {
  let chev: Chevron[] = [
    { id: 0, r: p.er, c: p.ec, dir: "LEFT", pr: p.er, pc: p.ec, alive: true, angle: 180 },
    { id: 1, r: p.er, c: p.ec, dir: "RIGHT", pr: p.er, pc: p.ec, alive: true, angle: 0 },
  ]
  for (let t = 0; t < p.size * p.size + 5; t++) {
    chev = step(p.grid, chev, p.size)
    if (collided(chev)) return true
    if (chev.some((c) => !c.alive)) return false
  }
  return false
}

/** Build a playable level: winding path, scrambled mirrors, decoys. */
function generateLevel(difficulty: number, seed: number): Puzzle {
  let p: WindPuzzle | null = null
  for (let att = 0; att < 40 && !p; att++) {
    const cand = generateWinding(
      difficulty,
      (seed + att * 0x9e3779b1) >>> 0,
    )
    if (cand && isSolvable(cand)) p = cand
  }
  if (!p) return generateFallback(difficulty, seed)

  const rng = mulberry32(seed ^ 0x5bd1e995)
  const { grid, size, mirrors, reserved } = p

  // scramble the path mirrors so the player has to fix them
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

  // scatter decoys across the untouched cells
  const decoyProb = Math.min(0.5, 0.16 + difficulty * 0.03)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved.has(r * size + c)) continue
      if (rng() < decoyProb) {
        if (rng() < 0.62) {
          grid[r][c] = mkMirror(rng() < 0.5 ? "/" : "\\")
        } else {
          grid[r][c] = mkPipe(rng() < 0.5 ? "|" : "-")
        }
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

function collided(next: Chevron[]): boolean {
  const live = next.filter((c) => c.alive)
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]
      const b = live[j]
      if (a.r === b.r && a.c === b.c) return true
      if (a.r === b.pr && a.c === b.pc && b.r === a.pr && b.c === a.pc) return true
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

function makePuzzle(mode: Mode, levelNo: number): Puzzle {
  if (mode === "DAILY") return generateLevel(dailyDifficulty(), todaySeed())
  return generateLevel(difficultyForLevel(levelNo), seedForLevel(levelNo))
}

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
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode, quota) - ignore */
  }
}

/* ------------------------------ animals --------------------------- */

// hostile animals arrive once the endless run gets hard (level 10+)
const animalCountForLevel = (lvl: number) =>
  lvl < 10 ? 0 : Math.min(4, 1 + Math.floor((lvl - 10) / 6))
const animalSeed = (levelNo: number) => (seedForLevel(levelNo) ^ 0x9e3779b1) >>> 0

function makeAnimals(mode: Mode, levelNo: number): Animal[] {
  if (mode !== "ENDLESS") return []
  const n = animalCountForLevel(levelNo)
  if (!n) return []
  const rng = mulberry32(animalSeed(levelNo))
  const size = SIZE_BY_DIFF[difficultyForLevel(levelNo) - 1]
  const sides: AnimalSide[] = ["left", "right", "top", "bottom"]
  const out: Animal[] = []
  for (let i = 0; i < n; i++) {
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

/* ------------------------------ game ------------------------------ */

export default function BlocGame() {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [levelNo, setLevelNo] = useState<number>(loadLevel)
  const [rebuild, setRebuild] = useState(0)
  const [puzzle, setPuzzle] = useState<Puzzle>(() => makePuzzle(loadMode(), loadLevel()))
  const [grid, setGrid] = useState<Cell[][]>(() => puzzle.grid)
  const [chevrons, setChevrons] = useState<Chevron[]>([])
  const [status, setStatus] = useState<Status>("IDLE")
  // true only during the final slice of each tick - a block locks just as the
  // chevron is about to leave it, so you can rotate it until it's deep inside
  const [committing, setCommitting] = useState(false)
  const [animals, setAnimals] = useState<Animal[]>(() =>
    makeAnimals(loadMode(), loadLevel()),
  )

  const gridRef = useRef(grid)
  const animalsRef = useRef(animals)
  const animalRngRef = useRef<(() => number) | null>(null)
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

  /* (re)build board when level / mode / rebuild changes */
  useEffect(() => {
    const p = makePuzzle(mode, levelNo)
    setPuzzle(p)
    setGrid(p.grid)
    setChevrons([])
    setStatus("IDLE")
    tickRef.current = 0
    const fresh = makeAnimals(mode, levelNo)
    setAnimals(fresh)
    animalRngRef.current = fresh.length
      ? mulberry32((animalSeed(levelNo) ^ 0x2545f491) >>> 0)
      : null
  }, [mode, levelNo, rebuild])

  /* game loop - emit immediately, then tick */
  useEffect(() => {
    if (status !== "PLAYING") {
      setCommitting(false)
      return
    }
    let iv: ReturnType<typeof setInterval> | undefined
    let commitTimer: ReturnType<typeof setTimeout> | undefined

    const advance = () => {
      if (statusRef.current !== "PLAYING") return
      tickRef.current += 1
      const size = puzzleRef.current.size
      const next = step(gridRef.current, chevRef.current, size)
      const won = collided(next)

      // advance animals; a nuke kills any chevron caught on the fired line
      const rng = animalRngRef.current
      if (rng && animalsRef.current.length) {
        const res = stepAnimals(animalsRef.current, rng, size)
        setAnimals(res.next)
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
      // unlock at the start of the tick, re-lock once the chevron is deep in
      setCommitting(false)
      clearTimeout(commitTimer)
      commitTimer = setTimeout(() => setCommitting(true), TICK_MS * LOCK_FRAC)
      if (won) setStatus("WON")
      else if (next.some((c) => !c.alive)) setStatus("LOST")
      else if (tickRef.current > MAX_TICKS) setStatus("LOST")
    }

    const raf = requestAnimationFrame(() => {
      advance() // chevrons leave the emitter box right away
      iv = setInterval(advance, TICK_MS)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (iv) clearInterval(iv)
      clearTimeout(commitTimer)
    }
  }, [status])

  /* resolve WON / LOST */
  useEffect(() => {
    if (status === "WON") {
      const t = setTimeout(() => {
        if (mode === "ENDLESS") setLevelNo((n) => n + 1)
        else setRebuild((k) => k + 1)
      }, 1450)
      return () => clearTimeout(t)
    }
    if (status === "LOST") {
      // keep the player's rotations; just clear the run so they can adjust
      const t = setTimeout(() => {
        setChevrons([])
        setCommitting(false)
        const fresh = makeAnimals(mode, levelNo)
        setAnimals(fresh)
        animalRngRef.current = fresh.length
          ? mulberry32((animalSeed(levelNo) ^ 0x2545f491) >>> 0)
          : null
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

  const handleCell = (r: number, c: number) => {
    const t = grid[r][c]
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
      {/* settings */}
      <div className="absolute top-4 left-4 z-20">
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
                  size={cellPx}
                  chevronPx={chevronPx}
                  hideEmitter={status !== "IDLE"}
                  emitterCue={status === "IDLE"}
                  active={energized.has(`${r},${c}`)}
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
                      : "transform 920ms cubic-bezier(0.4,0,0.2,1)",
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
                      ? `transform ${TICK_MS}ms linear`
                      : "none",
                  opacity: flying ? 0 : 1,
                }}
              >
                <ChevronMark
                  px={chevronPx}
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
  if (cell.type === "MIRROR") return { base: "/", cls: "text-slate-600" }
  if (cell.type === "PIPE") return { base: "|", cls: "text-rose-400" }
  return null
}

function CellTile({
  cell,
  size,
  chevronPx,
  active,
  hideEmitter,
  emitterCue,
  onClick,
}: {
  cell: Cell
  size: number
  chevronPx: number
  active: boolean
  hideEmitter: boolean
  emitterCue: boolean
  onClick: () => void
}) {
  const block = blockFor(cell)
  const clickable = cell.type === "EMITTER" || block !== null
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
      style={{ width: size, height: size }}
      className={cn(
        "group relative touch-manipulation overflow-hidden rounded-2xl border border-border bg-white transition-[border-color,box-shadow,transform] duration-200",
        clickable
          ? "cursor-pointer hover:-translate-y-0.5 hover:border-sky-400 hover:shadow-[0_6px_16px_-6px_rgba(2,132,199,0.45)] active:translate-y-0 active:scale-[0.94]"
          : "cursor-default",
        "focus:outline-none focus-visible:border-sky-400",
        // a chevron sitting here energises the tile: strong blue glitter + glow
        active &&
          "border-sky-400 shadow-[0_0_22px_-2px_rgba(56,189,248,0.75)] ring-2 ring-sky-400/70",
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
