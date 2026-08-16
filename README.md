# Quartz

Quartz measures whether a day follows a selected timetable, and which timetable
items most consistently cause deviation from the plan.

It is a measurement tool, not a task manager or a coach. There is no server, no
account, and no synchronisation: everything runs in the browser and is stored on
the device.

## Running it

```bash
npm install
npm run dev        # development server
npm test           # unit, contract, and component tests
npm run typecheck  # strict TypeScript, no emit
npm run lint       # ESLint, including the layer boundaries
npm run build      # static bundle in dist/
```

`npm run icons` regenerates `public/icons/*.png` from `scripts/generate-icons.mjs`.
The icons are committed, so a build never depends on an image toolchain.

## Deploying

The build output is entirely static.

```bash
BASE_PATH=/<repo-name>/ npm run build
```

`.github/workflows/deploy.yml` verifies, builds with the repository's base path,
and publishes `dist/` to GitHub Pages. Navigation is hash-based, so a refresh or
a direct link works from a subpath without any server rewrite rules.

## How it is put together

```text
src/domain          timetables, runs, events, transitions, time, measurements
src/application     use cases and the repository contract
src/infrastructure  IndexedDB adapter, bundled timetables, service worker
src/ui              screens, formatting, navigation
```

Dependencies point inwards only, and ESLint enforces it. The domain has no React
and no storage API, which is what lets the whole rule set be tested against an
in-memory repository.

### The plan and reality stay separate

A timetable is a versioned, immutable definition. A run records what actually
happened as an append-only event history, and it keeps the timetable version it
was measured against forever. Publishing a new version never changes what an old
day is compared to.

### One press, one timestamp

Pressing **Next** on an item records the item's completion and the next item's
start at the same instant, in a single storage transaction, with a precondition
on the item and sequence number the user was actually looking at. A repeated tap
therefore fails its precondition and re-reads state instead of recording a second
transition.

### Undo appends, it never rewrites

Every event produced by one press shares a transition ID. **Undo** appends a
single `undo` event that references that transition. Nothing is deleted and no
past timestamp is edited, so a restored item keeps the start time it originally
had. Undoing the final press reopens a completed day.

### Nothing derived is stored

Deviations, totals, and rankings are recomputed from the timetable version plus
the event history whenever a report is opened, so a report can never drift out of
agreement with the recorded history.

### Invalid state is reported, never guessed

The reducer that rebuilds a run validates the whole history: contiguous sequence
numbers, strict `started` → `completed`/`skipped` alternation, non-decreasing
timestamps, and agreement with the stored run status. If a history cannot produce
a valid state, or storage cannot be opened, the app refuses to offer any run
action and shows a recovery screen instead.

### Skips are not savings

A skipped item has no start deviation, no actual duration, and no duration
deviation. It contributes zero to the overrun totals, so skipping an item can
never improve its score. It is counted and reported separately as a skip.

## Measurements

Per item: start deviation, actual duration, and duration deviation. Per run:
day-start deviation, final completion deviation, skip count and rate, and total
positive duration deviation. Across runs of the same timetable ID, results are
grouped by stable item ID and reported as observation count, median start
deviation, median duration deviation, total positive duration deviation, and skip
rate.

The **Steps causing deviation** ranking is ordered by total positive duration
deviation, so the items that repeatedly overrun — the ones that actually
accumulate lateness — come first.

## Offline and installation

`public/manifest.webmanifest` and a generated `sw.js` make the app installable
and usable with no network after the first load. The service worker precaches the
shell, the bundled timetable data, and the icons; any in-app route falls back to
the cached shell. A new worker deliberately does not claim open pages, so an
update can never reload the app underneath a day in progress.

## Your data

Data lives only in this browser on this device. Uninstalling the app, clearing
site data, or losing the device removes anything that has not been exported.
The Backup screen exports every timetable, run, and event as one versioned JSON
file, and restores one after validating it completely and asking for explicit
confirmation. A backup that fails validation changes nothing.
