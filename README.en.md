# dsh-sidebar-drawer

English | [简体中文](README.md)

An edge-hover drawer for the left sidebar: while the sidebar is collapsed, moving the pointer into **the leftmost 10 px of the screen and holding it there for 500 ms** pulls the sidebar out; it stays out the whole time the pointer remains inside the drawer, and retracts by itself once the pointer leaves.

A pure browser-behavior plugin (the host half is empty). It only borrows DSH's own sidebar toggling and changes no built-in file.

![Revealing and retracting the drawer](docs/drawer-demo.gif)

## What it does

- **Dwelling is what counts** — the pointer must stay inside the leftmost 10 px for 500 ms before anything happens; sweeping past the edge never triggers it by accident.
- **Inside the drawer means staying** — while the pointer rests inside the drawer (reading, clicking, idling) the drawer stays out and nothing rushes you.
- **No interrupting an animation** — a second toggle is never issued while an open/close transition is in flight, so the drawer neither jumps nor vanishes mid-flight.
- **Slides, not jumps** — the shipped frame writes the column width first and publishes its transition marker afterwards, so a plain toggle is instantaneous (a retraction looks like the drawer simply disappearing); before requesting a toggle the plugin pre-arms the frame's own marker, so both the reveal and the retraction really slide.
- **A hand-opened sidebar is left alone** — a sidebar you opened yourself with the button, Cmd+B, or a width drag is never touched and never retracted.
- **Yields** — width drags, window blur, and page scroll each have their own yield rule.

Row-by-row scenarios, state-machine invariants, and known gaps: **[docs/behavior.md](docs/behavior.md)** (Chinese).

## Install

This is a DSH **plugin bundle**: it ships its own `cordis.patch.yml` and declares `dsh.bundle.patch` in `package.json`, so Plugin Manager installs it and owns the mount row — **you never hand-edit the profile's patch file**.

```bash
# From npm (recommended: pins the version)
dsh plugin --profile desktop add dsh-sidebar-drawer@0.1.0

# From GitHub (also version-pinned, through the repo's v0.1.0 tag)
dsh plugin --profile desktop add "github:1dustycy/dsh-sidebar-drawer#v0.1.0"

# Track the latest commit on main (to pick up behavior changes early)
dsh plugin --profile desktop add github:1dustycy/dsh-sidebar-drawer

# From a local directory (for development: writes a link: dependency, edits take effect immediately)
dsh plugin --profile desktop add /path/to/dsh-sidebar-drawer
```

Replace `desktop` with the profile you want (e.g. `web`, `tui`). The command does two things: it adds the package to `dependencies` in `~/.dsh/profiles/<name>/package.json`, and adds `dsh-sidebar-drawer` to that profile's `dsh.profile.bundles`. Once installed, **refresh the page** and it is live — no app restart needed (the client half is hot-loaded through the bundle's mtime polling plus `/plugins/events`).

Uninstall:

```bash
dsh plugin --profile desktop remove dsh-sidebar-drawer
```

> Why not just add a row to the profile's `cordis.patch.yml`? That file is shared with other sessions, and when it gets overwritten the symptom is a plugin that looks installed but does nothing — with nothing in the plugin itself to show for it. Rationale in [ADR-0003](docs/adr/0003-bundle-patch-ownership.md).

**Requirements**: DSH Desktop (or any profile with a Web GUI). The client half injects `@deepseek-ai/dsh-client-ui-layout`, so the target profile must already mount the Web layout bundle. `peerDependencies` is `@deepseek-ai/cordis >=4.0.4 <5` — when installing from a registry, Plugin Manager checks that range first and refuses before anything is downloaded if it does not match.

## Development and verification

```bash
node test/client.test.mjs    # unit suite: vm + DOM doubles + an advancing virtual clock, no browser needed
node test/browser.test.mjs   # browser suite: real Chromium + CDP real mouse events and real CSS animations
npm test                     # runs both suites, in that order
node tools/probe.mjs         # diagnostic tool: prints the decision trail of one edge dwell
npm pack --dry-run           # confirm what gets published
```

After editing `lib/client.js`, **refresh the page** and the change is live (provided the profile's `hmr` row is enabled, which the desktop profile does by default).

`test/browser.test.mjs` brings its own HTTP server and browser process and exits when it is done; it needs Chromium on the machine (it skips itself when none is found). `SHOT=<path> node test/browser.test.mjs` saves the final "drawer open" frame as a PNG (that is where `docs/harness-open.png` comes from). The animation at the top is the other way round — a **screen recording of the real GUI**, not the fixture — and `node tools/demo-gif.mjs <recording>` regenerates it, which needs ffmpeg on the machine. `test/harness.html` is a faithful replica of the shipped three-column frame: open it in a browser with `?plugin=<URL of client.js>` to try the behavior by hand.

> **Read [docs/implementation.md](docs/implementation.md#测试夹具必须与出厂契约同步) before touching the test fixtures.**
> Both fixtures must model the shipped shell's anchor contract exactly: once a fixture renders a conditional anchor unconditionally, it goes all-green on a broken bundle — which is precisely how this plugin once shipped a defect where a pointer resting motionless on the edge toggled the drawer forever.

## Docs

| Document | Contents |
|---|---|
| [docs/behavior.md](docs/behavior.md) | Behavior spec: row-by-row scenarios, state-machine invariants, known gaps |
| [docs/implementation.md](docs/implementation.md) | Implementation notes: shipped anchor contract, decision logic, tunable constants |
| [docs/adr/](docs/adr/) | Decision records (why it is built this way) |
| [CONTEXT.md](CONTEXT.md) | Glossary: Chinese wording mapped to code identifiers |

> The detailed docs are Chinese-only for now; this file is the English entry point.

## License

MIT
