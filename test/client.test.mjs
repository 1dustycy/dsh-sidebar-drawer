/**
 * Behavior tests for the sidebar edge-hover drawer client bundle.
 *
 * The bundle is the built artifact, so the test loads it the way the browser
 * module loader does: a stub `window.__ModuleLoader__` captures the factory,
 * and materializing it yields the plugin's exports. The behavior itself is then
 * driven through an injectable browser double whose geometry stands in for the
 * shipped frame.
 *
 * Run: node test/client.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
/* Same override the browser harness honours, so either suite can be pointed at a
   candidate bundle for a differential run. */
const bundlePath = process.env.DEBUG_BUNDLE ?? join(here, "..", "lib", "client.js");

/** Materialize the client bundle and return its exports. */
function loadPlugin() {
	const source = readFileSync(bundlePath, "utf8");
	const registrations = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(record) {
					registrations.push(record);
				}
			}
		},
		console
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "client.js" });
	assert.equal(registrations.length, 1, "bundle registers exactly one module");
	assert.equal(registrations[0].id, "dsh-sidebar-drawer");
	const exported = registrations[0].factory(() => {
		throw new Error("this bundle must not require anything");
	});
	/** `apply()` reads the browser globals of its own realm, so hand it that realm's. */
	exported.publishGlobals = (browser) => {
		sandbox.document = browser.doc;
		sandbox.window = browser.win;
	};
	return exported;
}

/** One element double with the attributes and geometry the behavior reads. */
function element(name, { frame = null } = {}) {
	const node = {
		name,
		attributes: new Map(),
		children: [],
		parentElement: frame,
		setAttribute(key, value) {
			this.attributes.set(key, String(value));
		},
		getAttribute(key) {
			return this.attributes.has(key) ? this.attributes.get(key) : null;
		},
		hasAttribute(key) {
			return this.attributes.has(key);
		},
		removeAttribute(key) {
			this.attributes.delete(key);
		},
		contains(other) {
			for (let node = other; node !== null && node !== undefined; node = node.parentElement) {
				if (node === this) return true;
			}
			return false;
		},
		querySelector() {
			/* Only the frame looks anything up from a node (its sidebar drag handle);
			   every other node has no descendants to offer. */
			return null;
		}
	};
	Object.defineProperty(node, "firstElementChild", {
		get() {
			return node.children[0] ?? null;
		}
	});
	return node;
}

/** A browser double whose sidebar column geometry is driven by `sidebarWidth`. */
function createBrowser() {
	const doc = {
		documentElement: element("html"),
		listeners: new Map(),
		width: 0,
		addEventListener(type, handler) {
			const list = doc.listeners.get(type) ?? [];
			list.push(handler);
			doc.listeners.set(type, list);
		},
		removeEventListener(type, handler) {
			const list = doc.listeners.get(type) ?? [];
			doc.listeners.set(
				type,
				list.filter((row) => row !== handler)
			);
		},
		dispatch(type, event) {
			for (const handler of [...(doc.listeners.get(type) ?? [])]) handler(event);
		},
		querySelector(selector) {
			/* The shipped shell's anchor contract (docs/adr/0001-frame-anchor-contract.md):
			   only the overlay layer is unconditional. Treating any other anchor as always
			   available makes the frame resolvable while the sidebar is open, which
			   silently rescues the lookup and hides exactly the bug these doubles exist to
			   catch. `data-sidebar-col` is not published by the shipped shell at all. */
			if (selector === "[data-shell-overlay]") return overlay;
			if (selector === "[data-shell-leading]") return isCollapsed() ? seat : null;
			if (selector === "[data-sidebar-collapsed]") return isCollapsed() ? frame : null;
			if (selector === "[data-sidebar-col]") return null;
			throw new Error(`unexpected selector ${selector}`);
		},
		elementFromPoint(x, y) {
			/* The browser hit test follows the live column box. */
			return x >= 0 && x < doc.width ? inside : outside;
		}
	};

	const frame = element("frame");
	const column = element("column", { frame });
	const overlay = element("overlay", { frame });
	const seat = element("leading", { frame });
	const handle = element("handle", { frame });
	const inside = element("sidebar-content", { frame: column });
	const outside = element("conversation");
	column.children.push(inside);
	/* Frame child order mirrors the shipped AppFrame: the sidebar column first, then
	   the overlay layer, then the chrome seats that are mounted only while the sidebar
	   is collapsed. `columnOf` reads `firstElementChild`, so this order is load-bearing. */
	frame.children.push(column, overlay, seat);
	doc.documentElement.children.push(frame);
	/** The shipped frame collapses the sidebar to a zero-width column. */
	/* Read the VALUE, not the presence: the shipped shell renders
	   `sidebarCollapsed || void 0` — the literal "true" — and the plugin compares
	   against "true". A presence-only model would answer "collapsed" even for a
	   fixture that wrote "" (e.g. via `toggleAttribute(name, true)`), which is
	   exactly the silent drift this double must go red on. */
	const isCollapsed = () => frame.getAttribute("data-sidebar-collapsed") === "true";
	/* The sidebar drag handle is mounted only while the sidebar is open. */
	frame.querySelector = (selector) => (selector === '[data-side="sidebar"]' && !isCollapsed() ? handle : null);

	column.getBoundingClientRect = () => ({ left: 0, top: 0, right: doc.width, bottom: 800, width: doc.width, height: 800 });

	const timers = new Map();
	let timerId = 0;
	const frames = [];
	/** Virtual clock: `advance(ms)` moves it, so animation windows are deterministic. */
	let now = 1000;
	const win = {
		innerWidth: 1280,
		innerHeight: 800,
		scrollX: 0,
		scrollY: 0,
		performance: {
			now() {
				return now;
			}
		},
		setTimeout(handler, delay) {
			const id = ++timerId;
			timers.set(id, { handler, delay, armedAt: now });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		requestAnimationFrame(handler) {
			frames.push(handler);
			return frames.length;
		},
		addEventListener(type, handler) {
			win.listeners.set(type, [...(win.listeners.get(type) ?? []), handler]);
		},
		removeEventListener(type, handler) {
			win.listeners.set(
				type,
				(win.listeners.get(type) ?? []).filter((row) => row !== handler)
			);
		},
		listeners: new Map()
	};

	const layout = {
		toggles: 0,
		toggleSidebar() {
			layout.toggles += 1;
			/* The shipped store flips the frame marker and the frame publishes its own
			   `data-animating` marker around the resulting transition. */
			if (isCollapsed()) {
				frame.removeAttribute("data-sidebar-collapsed");
				doc.width = 280;
			} else {
				frame.setAttribute("data-sidebar-collapsed", "true");
				doc.width = 0;
			}
			startTransition();
		}
	};

	/** The frame marks a transition, then clears the mark on its transitionend. */
	let transitionTimer = null;
	function startTransition(durationMs = 600) {
		frame.setAttribute("data-animating", "");
		if (transitionTimer !== null) win.clearTimeout(transitionTimer);
		transitionTimer = win.setTimeout(() => {
			transitionTimer = null;
			frame.removeAttribute("data-animating");
		}, durationMs);
	}

	return {
		doc,
		win,
		frame,
		column,
		layout,
		startTransition,
		/** Stop the frame's transition marker, as a real transitionend would. */
		endTransition() {
			if (transitionTimer !== null) {
				win.clearTimeout(transitionTimer);
				transitionTimer = null;
			}
			frame.removeAttribute("data-animating");
		},
		collapse() {
			frame.setAttribute("data-sidebar-collapsed", "true");
			doc.width = 0;
		},
		expand(width = 280) {
			frame.removeAttribute("data-sidebar-collapsed");
			doc.width = width;
		},
		/** Model one animation frame of the shipped open/close transition. */
		setWidth(width) {
			doc.width = width;
			if (width > 0) frame.removeAttribute("data-sidebar-collapsed");
		},
		/** Deliver one pointer move and the animation frame it schedules. */
		move(x, y) {
			doc.dispatch("pointermove", { clientX: x, clientY: y });
			this.flushFrame();
		},
		/**
		 * Move somewhere and let the pointer rest there: a landing that the behavior will
		 * treat as "in the reveal strip" is held for the full dwell, which is what a user
		 * does when they mean to open the drawer.
		 */
		moveAndRest(x, y) {
			this.move(x, y);
			if (x <= 10) this.advance(600);
		},
		flushFrame() {
			while (frames.length > 0) frames.shift()();
		},
		/**
		 * Advance the clock by `ms`, firing each timer at the moment it comes due.
		 *
		 * Stepping matters: the behavior defers and re-polls while the frame animates,
		 * so one request of virtual time has to run a chain of timers — each at its own
		 * due time — the way a real clock would. Jumping straight to the end would let a
		 * re-armed timer look permanently in the future.
		 */
		advance(ms) {
			const target = now + ms;
			this.flushFrame();
			for (;;) {
				const due = [...timers]
					.filter(([, timer]) => timer.armedAt + timer.delay <= target)
					.sort((a, b) => a[1].armedAt + a[1].delay - (b[1].armedAt + b[1].delay));
				if (due.length === 0) break;
				const [id, timer] = due[0];
				now = Math.max(now, timer.armedAt + timer.delay);
				timers.delete(id);
				timer.handler();
				this.flushFrame();
			}
			now = target;
			this.flushFrame();
		},
		pendingTimers() {
			return timers.size;
		},
		/** Count of armed timers with one exact delay. */
		timersOf(delay) {
			return [...timers.values()].filter((timer) => timer.delay === delay).length;
		},
		leaveWindow() {
			doc.dispatch("pointerleave", {});
		},
		enterWindow() {
			doc.dispatch("pointerenter", {});
		},
		dispatchWindow(type) {
			for (const handler of [...(win.listeners.get(type) ?? [])]) handler({});
		}
	};
}

const plugin = loadPlugin();
/* The bundle runs in another realm, so compare structurally, not by prototype. */
assert.equal(JSON.stringify([...plugin.inject]), JSON.stringify(["layout"]), "declares the layout service");

/** Every case starts from a mounted behavior over a collapsed sidebar. */
function mount() {
	const browser = createBrowser();
	browser.collapse();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	return { browser, dispose };
}

/* 0. The DOM double models the shipped frame contract (docs/adr/0001). A double
   that drifts from it can go green on a broken bundle — that is how the
   "motionless pointer loops the drawer" bug shipped past a full suite. */
{
	const browser = createBrowser();
	browser.collapse();
	assert.equal(
		browser.frame.getAttribute("data-sidebar-collapsed"),
		"true",
		"the collapsed marker carries the literal true, not an empty value"
	);
	assert.ok(browser.doc.querySelector("[data-shell-overlay]") !== null, "the overlay anchor is unconditional");
	assert.ok(browser.doc.querySelector("[data-shell-leading]") !== null, "the leading seat is mounted while collapsed");
	assert.equal(browser.frame.querySelector('[data-side="sidebar"]'), null, "the sidebar handle is unmounted while collapsed");
	assert.equal(browser.doc.querySelector("[data-sidebar-col]"), null, "data-sidebar-col is not published at all");
	assert.equal(browser.column.getBoundingClientRect().width, 0, "the collapsed column measures exactly 0px");
	browser.expand(280);
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), null, "the collapsed marker leaves the document when the drawer opens");
	assert.ok(browser.doc.querySelector("[data-shell-overlay]") !== null, "the overlay anchor survives the drawer opening");
	assert.equal(browser.doc.querySelector("[data-shell-leading]"), null, "the leading seat unmounts when the drawer opens");
	assert.ok(browser.frame.querySelector('[data-side="sidebar"]') !== null, "the sidebar handle mounts when the drawer opens");
}

/* 1. A pointer resting in the reveal strip opens the drawer, once. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(4, 400);
	assert.equal(browser.layout.toggles, 1, "the dwell opens the drawer");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false);
	browser.move(5, 401);
	browser.moveAndRest(6, 402);
	assert.equal(browser.layout.toggles, 1, "further edge moves do not re-toggle");
	dispose();
}

/* 1b. Contact alone is not enough: the pointer must stay in the strip. */
{
	const { browser, dispose } = mount();
	browser.move(3, 400);
	browser.advance(200);
	assert.equal(browser.layout.toggles, 0, "no reveal before the dwell elapses");
	browser.move(4, 400);
	browser.advance(200);
	assert.equal(browser.layout.toggles, 0, "moving inside the strip keeps waiting");
	browser.advance(200);
	assert.equal(browser.layout.toggles, 1, "the reveal lands once the dwell completes");
	dispose();
}

/* 1c. Leaving the strip before the dwell elapses cancels the reveal. */
{
	const { browser, dispose } = mount();
	browser.move(3, 400);
	browser.advance(300);
	browser.move(120, 400); /* walked on into the window */
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 0, "a pointer passing through must not open the drawer");
	dispose();
}

/* 1d. Coming back to the strip after cancelling starts a fresh dwell. */
{
	const { browser, dispose } = mount();
	browser.move(3, 400);
	browser.advance(300);
	browser.move(60, 400);
	browser.advance(300);
	assert.equal(browser.layout.toggles, 0, "still closed after the cancelled dwell");
	browser.move(4, 400);
	browser.advance(200);
	assert.equal(browser.layout.toggles, 0, "the timer restarts from scratch");
	browser.advance(300);
	assert.equal(browser.layout.toggles, 1, "and then reveals");
	dispose();
}

/* 1e. A pointer that leaves the window during the dwell does not reveal. */
{
	const { browser, dispose } = mount();
	browser.move(3, 400);
	browser.advance(200);
	browser.leaveWindow();
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 0, "an exited pointer cannot complete a dwell");
	dispose();
}

/* 1f. A drag in flight suppresses the strip even while dwelling. */
{
	const { browser, dispose } = mount();
	browser.frame.setAttribute("data-dragging", "");
	browser.moveAndRest(3, 400);
	assert.equal(browser.layout.toggles, 0, "no reveal while the user drags a column");
	dispose();
}

/* 2. Staying inside the drawer keeps it open indefinitely. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	for (const x of [150, 260, 279, 90]) {
		browser.move(x, 300);
		browser.advance(1000);
	}
	assert.equal(browser.layout.toggles, 1, "inside pointer never retracts the drawer");
	dispose();
}

/* 3. Leaving the drawer retracts it, once the reveal animation has settled. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.move(600, 300);
	browser.advance(100);
	assert.equal(browser.layout.toggles, 1, "still open during the grace delay");
	assert.equal(browser.timersOf(260), 1, "a close is pending");
	/* The grace expires while the reveal is still animating: the close waits it out. */
	browser.advance(400);
	assert.equal(browser.layout.toggles, 1, "no retraction against a half-grown column");
	/* Once the animation settles the same verdict retracts the drawer. */
	browser.advance(250);
	browser.advance(300);
	assert.equal(browser.layout.toggles, 2, "outside pointer retracts the drawer");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), true);
	dispose();
}

/* 4. Coming back inside before the grace expires cancels the retraction. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.move(600, 300);
	browser.advance(50);
	browser.move(200, 300);
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 1, "re-entry keeps the drawer open");
	assert.equal(browser.timersOf(260), 0, "the pending close was cancelled");
	dispose();
}

/* 5. A pointer resting inside while the drawer animates open is not ejected. */
{
	const browser = createBrowser();
	browser.collapse();
	/* The open animation widens the column after the trigger move. */
	const layout = browser.layout;
	const toggleSidebar = layout.toggleSidebar.bind(layout);
	layout.toggleSidebar = () => {
		toggleSidebar();
		browser.doc.width = 6; /* first animation frame */
	};
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout });
	browser.move(3, 200);
	browser.advance(600); /* the pointer dwells in the strip */
	assert.equal(layout.toggles, 1, "the dwell revealed the drawer");
	browser.doc.width = 160; /* animation continues */
	browser.advance(120);
	assert.equal(layout.toggles, 1, "no retraction while the pointer rests inside the opening drawer");
	dispose();
}

/* 5b. A leave report retracts exactly once — it must never flap the drawer. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "the dwell revealed the drawer");
	/* The window reports the pointer gone even though the sample never moved. */
	browser.leaveWindow();
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "the leave retracted it, exactly once");
	/* And it stays quiet: nothing wakes up and toggles it again. */
	for (let round = 0; round < 12; round += 1) {
		browser.advance(300);
		assert.equal(browser.layout.toggles, 2, `toggle count drifted on round ${round}`);
	}
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), true, "the drawer ended closed");
	dispose();
}

/* 5c. A pointer that comes back into the window re-arms the reveal normally. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.leaveWindow();
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "the leave retracted it");
	browser.enterWindow();
	browser.move(3, 200);
	browser.advance(600);
	assert.equal(browser.layout.toggles, 3, "back in the window, the dwell reveals it again");
	dispose();
}

/* 6. A manually opened sidebar is never retracted by this behavior. */
{
	const browser = createBrowser();
	browser.expand(280);
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(600, 300);
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 0, "outside pointer ignores a hand-opened sidebar");
	browser.moveAndRest(3, 300);
	assert.equal(browser.layout.toggles, 0, "edge pointer ignores an already-open sidebar");
	dispose();
}

/* 7. A column drag is never interrupted. */
{
	const { browser, dispose } = mount();
	browser.frame.setAttribute("data-dragging", "");
	browser.moveAndRest(3, 300);
	assert.equal(browser.layout.toggles, 0, "edge pointer during a drag opens nothing");
	dispose();
}

/* 8. Leaving the window retracts a revealed drawer. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.leaveWindow();
	browser.advance(1400);
	assert.equal(browser.layout.toggles, 2, "pointer leaving the window retracts the drawer");
	dispose();
}

/* 9. Disposal removes every listener and timer. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.move(600, 300);
	dispose();
	/* The frame's own transition marker is the harness's, not the behavior's. */
	browser.endTransition();
	assert.equal(browser.pendingTimers(), 0, "disposal clears every timer");
	const before = browser.layout.toggles;
	browser.advance(2000);
	assert.equal(browser.layout.toggles, before, "no work after disposal");
	assert.equal(browser.doc.listeners.get("pointermove").length, 0);
	assert.equal(browser.doc.documentElement.hasAttribute("dsh-sidebar-drawer"), false);
}

/* 10. The injected apply() mounts through ctx.effect and resolves the service. */
{
	const browser = createBrowser();
	browser.collapse();
	const effects = [];
	const ctx = {
		get(name) {
			return name === "layout" ? browser.layout : undefined;
		},
		effect(callback, label) {
			effects.push(label);
			return callback();
		}
	};
	plugin.publishGlobals(browser);
	plugin.apply(ctx);
	assert.equal(JSON.stringify(effects), JSON.stringify(["sidebar drawer: edge-hover reveal"]));
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "apply() mounts a working behavior");
}

/* Progress marker only: the suite has no runner, so a numeric tally here could only
   be kept by hand — and a hand-kept tally is what made this line claim a count that
   did not match the cases above it. The real total is derived at the end of the file. */
console.log("client bundle behavior: core behavior cases passed");

/* 11. The bundle's module face matches the loader contract. */
{
	assert.equal(typeof plugin.apply, "function", "exports apply");
	assert.equal(typeof plugin.install, "function", "exports install");
	assert.equal(plugin.inject.length, 1, "declares exactly the layout service");
}

/* 12. A missing layout service is reported, never mounted. */
{
	const browser = createBrowser();
	const effects = [];
	const errors = [];
	const originalError = console.error;
	console.error = (...args) => errors.push(args);
	try {
		plugin.publishGlobals(browser);
		plugin.apply({
			get: () => undefined,
			effect: (callback, label) => {
				effects.push(label);
				return callback();
			}
		});
	} finally {
		console.error = originalError;
	}
	assert.equal(effects.length, 0, "nothing mounts without the service");
	assert.equal(errors.length, 1, "the missing service is reported");
}

/* 13. A throwing toggle is contained, and the behavior stays usable. */
{
	const { browser, dispose } = mount();
	const originalError = console.error;
	const errors = [];
	console.error = (...args) => errors.push(args);
	try {
		browser.layout.toggleSidebar = () => {
			throw new Error("store closed");
		};
		browser.moveAndRest(3, 200);
	} finally {
		console.error = originalError;
	}
	assert.equal(errors.length, 1, "the failure surfaces as one diagnostic");
	dispose();
}

/* 14. A viewport change (page scroll / window resize) only invalidates evidence —
   it must never draw the "pointer left" conclusion by itself. The stale sample is
   dropped and any pending dwell or grace close is cancelled; the drawer keeps its
   state until a fresh sample arrives. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	browser.move(180, 300);
	browser.advance(0);
	assert.equal(browser.layout.toggles, 1, "pointer holds the drawer open");
	/* A resize reflows the frame while no pointer event arrives. */
	browser.win.innerWidth = 900;
	browser.dispatchWindow("resize");
	browser.advance(800);
	assert.equal(browser.layout.toggles, 1, "a resize cannot retract a drawer the pointer is still in");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false, "the drawer stays revealed");
	/* A page scroll mid-grace: the queued retraction must be cancelled too. */
	browser.move(600, 300);
	browser.advance(80);
	assert.equal(browser.timersOf(260), 1, "a close is queued");
	browser.dispatchWindow("scroll");
	browser.advance(800);
	assert.equal(browser.layout.toggles, 1, "a scroll during the grace cancels the queued retraction");
	/* And a real exit afterwards still retracts: this must not become "never closes". */
	browser.move(600, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "a fresh outside sample still retracts the drawer");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), true);
	dispose();
}

/* 15. A pointer that comes back onto the strip during a retraction waits it out,
   then gets its reveal — without any further pointer movement. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	browser.move(700, 300);
	browser.advance(900);
	assert.equal(browser.layout.toggles, 2, "the outside pointer retracted it");
	/* Mid-retraction, and the pointer is back on the strip. The column is still only
	   the 0px closed width here, so nothing of the drawer is under the pointer yet. */
	browser.startTransition();
	browser.move(3, 300);
	browser.advance(120);
	assert.equal(browser.layout.toggles, 2, "no reopen while the close is still animating");
	browser.advance(1400);
	assert.equal(browser.layout.toggles, 3, "the pointer that stayed on the strip is revealed once it settles");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false, "and the drawer is open");
	dispose();
}

/* 15b. After the retraction lands, a pointer still resting on the strip is
   revealed again — with no further pointer movement. The window's own blur/focus
   are the only events in between; the verdict is judged "on the strip", never on
   a guessed position. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	/* The window loses focus: the drawer retracts while the pointer rests at x=3. */
	browser.leaveWindow();
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "the leave retracted it");
	/* The window comes back — and the pointer never moves again. */
	browser.enterWindow();
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 3, "the resting pointer on the strip is re-revealed without moving");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false, "and the drawer ends open");
	dispose();
}

/* 16. A drawer already closed on its own is never reopened by the close timer. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	browser.move(700, 300);
	browser.advance(60);
	/* The user collapsed it by hand while the pointer was outside. */
	browser.frame.setAttribute("data-sidebar-collapsed", "true");
	browser.doc.width = 0;
	browser.advance(400);
	assert.equal(browser.layout.toggles, 1, "the timer must not toggle a closed sidebar open");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), true);
	dispose();
}

/* 17. A pointer that steps in a little while the drawer grows keeps it open.
   This is the reported feel: reveal from the edge, then lean in a few dozen px —
   the drawer must wait for the pointer, not snap shut behind it. */
{
	const { browser, dispose } = mount();
	/* Open, then model the first animation frames at 40px and 120px wide. */
	browser.moveAndRest(3, 300);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	browser.setWidth(40);
	browser.move(60, 300);
	browser.advance(300);
	assert.equal(browser.layout.toggles, 1, "a pointer at x=60 waits out the animation");
	browser.setWidth(120);
	browser.advance(300);
	assert.equal(browser.layout.toggles, 1, "still waiting while the drawer passes it");
	browser.setWidth(280);
	browser.advance(600);
	assert.equal(browser.layout.toggles, 1, "once inside, the drawer stays open");
	/* Anywhere inside the settled drawer also holds it. */
	for (const [x, y] of [
		[20, 40],
		[120, 200],
		[279, 760]
	]) {
		browser.move(x, y);
		browser.advance(600);
	}
	assert.equal(browser.layout.toggles, 1, "reading and clicking inside never retracts it");
	/* Only a real exit does. */
	browser.move(700, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "leaving the drawer still retracts it");
	dispose();
}

/* 18. Leaning back onto the strip right after the reveal keeps it open. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(2, 300);
	assert.equal(browser.layout.toggles, 1, "drawer revealed from the edge");
	/* The pointer drifts a few px back toward the screen edge and rests there. */
	for (const x of [12, 20, 30, 6, 1]) {
		browser.move(x, 300);
		browser.advance(600);
	}
	assert.equal(browser.layout.toggles, 1, "resting on the reveal strip holds the drawer open");
	browser.move(400, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "and stepping away still retracts it");
	dispose();
}

/* 19. Inward travel that never settles inside still retracts (no stuck drawer). */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 300);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	/* The pointer moves in past the retain margin while the drawer is still narrow,
	   then leaves sideways out of the drawer's band. */
	browser.setWidth(40);
	browser.move(60, 300);
	browser.advance(60);
	browser.move(500, 900);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "a pointer that walks away retracts the drawer");
	dispose();
}

/* Derived from this file's own case headers, so the tally cannot drift away from the
   cases again: adding a case updates the count, and renumbering cannot silently make
   the reported total a lie. */
const caseCount = (readFileSync(new URL(import.meta.url), "utf8").match(/^\/\* \d+[a-z]?\. /gm) ?? []).length;
console.log(`client bundle contract: ${caseCount} cases passed`);
