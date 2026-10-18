# Quartz

Quartz measures how a day follows a selected timetable and uses recent recorded
durations to review whether individual steps need more planned time.

It is a measurement tool, not a task manager or a coach. There is no account or
synchronisation: plans and recorded days run in the browser and are stored on
the device. Production builds send anonymous usage, aggregate measurement,
performance, and error telemetry to Azure Application Insights unless telemetry
is turned off from Settings.

Quartz ships with two full-day plans: **Gym weekday** and **No-gym weekday**.
Both are available Monday through Friday in `Asia/Kolkata`; weekends are
deliberately untracked.

## Haptics and sound

Quartz confirms meaningful actions with brief haptic patterns and subtle,
locally generated tones. Both channels are on by default and can be changed
independently from **Settings**. Success, day completion, undo, and errors use
distinct cues; navigation, selections, timer updates, and opening or dismissing
controls stay silent.

These preferences are stored separately in this browser, so backup restore and
**Clear all local data** do not change them. Feedback never leaves the device,
works offline, and is best-effort: browser permissions, silent or do-not-disturb
mode, and device hardware can suppress it. Browsers without vibration or Web
Audio support continue to run Quartz normally and explain the limitation in
Settings.

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
The faceted crystal mark has dedicated favicon (32px), Apple touch (180px),
and PWA (192px and 512px) icons, plus a maskable variant with the whole gem inside
the safe circle. The icons are committed, so a build never depends on an image
toolchain. A new icon design should use new filenames in the generator, manifest,
and HTML so browsers and the offline cache pick it up through the normal,
user-controlled app update.

## Deploying

The build output is entirely static.

```bash
BASE_PATH=/<repo-name>/ npm run build
```

`.github/workflows/deploy.yml` verifies, builds with the repository's base path,
and publishes `dist/` to GitHub Pages. Navigation is hash-based, so a refresh or
a direct link works from a subpath without any server rewrite rules.

### Observability

The production build supplies the Application Insights connection string to the
browser bundle. Local development and tests do not configure it, so telemetry is
a no-op in those environments.

The shared **Quartz telemetry overview** Azure Monitor Workbook is defined in
`infra/application-insights-workbook.bicep` and queries
`appi-quartz-prod`. Deploy or update it with:

```bash
az account set --subscription 598dbc31-fcbe-4cb1-a3d6-16d49d33a5cb
az deployment group create \
  --resource-group Quartz \
  --template-file infra/application-insights-workbook.bicep
```

From Azure Cloud Shell, clone the repository first. For an existing Cloud Shell
checkout, switch back to `main` and pull the latest workbook definition before
deploying:

```bash
git clone https://github.com/AnirudhKishan/Quartz.git
cd Quartz

# On later deployments, start here from the existing Quartz directory.
git switch main
git pull --ff-only origin main

az account set --subscription 598dbc31-fcbe-4cb1-a3d6-16d49d33a5cb
az deployment group create \
  --resource-group Quartz \
  --template-file infra/application-insights-workbook.bicep
```

Close and reopen an already-open workbook after deployment so the Azure portal
loads the updated serialized definition.

The workbook covers anonymous users and sessions, screens, feature events, the
run lifecycle, exceptions, page performance, application versions, browser and
device breakdowns, and aggregate report measurements.

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

A timetable defines the intended day. A run records what actually happened.
Once a timetable `(id, version)` has recorded data, its definition is immutable.
If a release intentionally changes the same published version, Quartz blocks
tracking without changing local data and keeps Restore and Clear data available.
This makes an explicit, validated backup migration the only way historical data
can be reinterpreted.

### One press, one timestamp

Pressing **Next** on an item records the item's completion and the next item's
start at the same instant, in a single storage transaction, with a precondition
on the item and sequence number the user was actually looking at. A repeated tap
therefore fails its precondition and re-reads state instead of recording a second
transition.

### Undo appends; explicit corrections edit time

Every event produced by one press shares a transition ID. **Undo** appends a
single `undo` event that references that transition. Nothing is deleted and no
past transition is removed. If **Next** or **Skip** was pressed late, the shared
changeover time can be corrected from the day timeline; both affected event
timestamps are updated atomically. Undoing the final press reopens a completed
day.

### Nothing derived is stored

Deviations, totals, and rankings are recomputed from the current stored timetable
definition plus the event history whenever a report is opened, so a report always
reflects the latest corrected data.

### Invalid state is reported, never guessed

The reducer that rebuilds a run validates the whole history: contiguous sequence
numbers, strict `started` → `completed`/`skipped` alternation, non-decreasing
timestamps, and agreement with the stored run status. If a history cannot produce
a valid state, or storage cannot be opened, the app refuses to offer any run
action and shows a recovery screen instead.

### Skips are not savings

A skipped item has no start deviation, actual duration, or duration deviation.
It is counted separately and is never treated as a zero-duration measurement or
as evidence that a time budget fits.

Skipping the whole day is a separate, confirmed action available before starting
or while a day is running. It stops tracking for that local date and excludes the
entire run from reports, including events recorded before the skip.

## Measurements

Per item: start deviation, active duration, and duration deviation. Split tasks
sum their active segments; pauses, gaps, and inserted activities stay separate.
Per run: day-start deviation, final completion deviation, skip count and rate,
and total positive duration deviation.

The **Time budget review** uses up to the latest 20 completed local dates from
one timetable version. When several runs were completed on the same date, only
the latest is used and the excluded repeats are disclosed. Different timetable
versions are never pooled.

For each step, the review shows the median active duration as the **typical**
estimate and the nearest-rank 75th percentile as the **roomier** estimate. A
suggestion requires at least five measured completions and a difference of at
least one minute from the plan. Proposed budgets round upward to whole minutes.
Skipped and unfinished steps do not enter the duration estimates, and the
underlying days remain linked for inspection and timestamp correction.

These estimates describe recorded active time; they do not identify the cause of
a late finish or guarantee that increasing a budget will make the day finish
earlier. Increasing one budget reallocates time within the timetable.

## Offline and installation

`public/manifest.webmanifest` and a generated `sw.js` make the app installable
and usable with no network after the first load. The service worker precaches the
shell, the bundled timetable data, and the icons; any in-app route falls back to
the cached shell. A new worker deliberately does not claim open pages, so an
update can never reload the app underneath a day in progress.

Settings and the recovery screen show the running release version plus Git
commit. They also provide **Check for updates** and an explicit **Apply update**
action. Quartz never reloads into a new build until the user chooses to apply
it.

## Your data

Timetable names, task names, recorded days, and backups live only in this browser
on this device. Uninstalling the app, clearing site data, or losing the device
removes anything that has not been exported. The Backup screen exports every
timetable, run, and event as one versioned JSON file, and restores one after
validating it completely and asking for explicit confirmation. A backup that
fails validation changes nothing.

Production builds use Azure Application Insights for anonymous browser/session
identifiers, screen views, feature actions, aggregate measurements, performance
data, app version, device information, and errors. Quartz does not send
timetable names, task names, backup contents, raw recorded days, or record
identifiers. Telemetry is on by default and can be turned off from Settings;
that preference is stored separately from Quartz data and survives backup
restore and Clear all local data.

The secondary menu also provides **Clear all local data**. It requires destructive
confirmation, removes all Quartz data on the device, and reloads the bundled
timetables as a fresh install.
