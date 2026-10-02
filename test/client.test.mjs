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

/** One element double with the attributes, events, and geometry the behavior reads. */
function element(name, { frame = null } = {}) {
	const node = {
		name,
		attributes: new Map(),
		children: [],
		listeners: new Map(),
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
		addEventListener(type, handler) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
		},
		removeEventListener(type, handler) {
			this.listeners.set(
				type,
				(this.listeners.get(type) ?? []).filter((row) => row !== handler)
			);
		},
		/** Deliver a bubbling event to this element's own listeners. */
		dispatch(type, event) {
			for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
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

	const SIDEBAR_WIDTH = 280;
	const SIDEBAR_AUTO_COLLAPSE = 1024;
	/** The shipped mode rule: below the threshold the override decides, not the preference. */
	const narrowMode = (width) => width < SIDEBAR_AUTO_COLLAPSE;
	/* The shipped store keeps two preferences (stores.ts): `sidebar`, the wide-mode
	   width, and `narrowExpanded`, the narrow-mode override. Exactly one decides the
	   collapsed state — {@link narrowMode} picks which — and toggling touches only the
	   preference its mode owns. */
	const layout = {
		toggles: 0,
		sidebar: 0,
		narrowExpanded: false,
		/**
		 * Set by a case to model a flip the shell does not animate: the store changes
		 * but the frame publishes no marker of its own (the race a viewport change
		 * creates inside the shell's own effect).
		 */
		silent: false,
		/**
		 * What the frame carried when the store was asked to flip. The shell writes the
		 * columns first and publishes its marker in a second pass, so a mark here is
		 * the behavior's own pre-arm and nothing else.
		 */
		markerAtToggle: null,
		toggleSidebar() {
			layout.toggles += 1;
			layout.markerAtToggle = frame.getAttribute("data-animating");
			if (narrowMode(win.innerWidth)) layout.narrowExpanded = !layout.narrowExpanded;
			else layout.sidebar = layout.sidebar === 0 ? SIDEBAR_WIDTH : 0;
			/* A discrete column change flips the frame marker and the frame publishes its
			   own `data-animating` marker around the resulting transition — after the
			   columns, in a second pass, exactly as the shipped frame does it. */
			applyState(!layout.silent);
		},
		/* The shipped frame measures itself and reports the viewport; crossing the
		   auto-collapse threshold resets the narrow override — a viewport-driven change
		   the plugin never asked for and must never be charged to it. */
		setViewportWidth(width) {
			const crossing = narrowMode(win.innerWidth) !== narrowMode(width);
			win.innerWidth = width;
			if (crossing) layout.narrowExpanded = false;
			/* A viewport-driven collapse deliberately publishes NO `data-animating`. */
			applyState(false);
		}
	};

	/** The shipped collapsed rule: narrow mode reads the override, wide the preference. */
	function sidebarCollapsed() {
		return narrowMode(win.innerWidth) ? !layout.narrowExpanded : layout.sidebar === 0;
	}

	/** Settle the frame markers from the store preferences. */
	function applyState(animate) {
		if (sidebarCollapsed()) {
			frame.setAttribute("data-sidebar-collapsed", "true");
			doc.width = 0;
		} else {
			frame.removeAttribute("data-sidebar-collapsed");
			doc.width = SIDEBAR_WIDTH;
		}
		if (animate) startTransition();
	}

	/** The frame marks a transition, then clears the mark on its transitionend. */
	let transitionTimer = null;
	function startTransition(durationMs = 600) {
		/* The shipped frame renders `data-animating: animating > 0 || void 0`, so the
		   value it writes is the literal "true" — which is what the behavior compares
		   against to tell its own pre-arm apart from a marker the shell owns. */
		frame.setAttribute("data-animating", "true");
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
		/**
		 * Deliver one transitioning event the way the browser does: it bubbles, so a
		 * listener on the frame hears its descendants too, and `target` is wherever the
		 * transition actually ran.
		 */
		transitionEnd({ target = frame, propertyName = "grid-template-columns" } = {}) {
			frame.dispatch("transitionend", { target, currentTarget: frame, propertyName });
		},
		/** A hand-close: the store's wide-mode preference goes to 0. */
		collapse() {
			layout.sidebar = 0;
			frame.setAttribute("data-sidebar-collapsed", "true");
			doc.width = 0;
		},
		/**
		 * A hand-open at `width` — a narrow width models the first animation frames
		 * of the growth toward the store's `SIDEBAR_WIDTH` preference.
		 */
		expand(width = 280) {
			layout.sidebar = SIDEBAR_WIDTH;
			frame.removeAttribute("data-sidebar-collapsed");
			doc.width = width;
		},
		/** Drive a real viewport change: the layout reacts first, then the plugin hears it. */
		resize(width) {
			layout.setViewportWidth(width);
			this.dispatchWindow("resize");
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

/* 0b. The double models the shipped narrow-window semantics (issue #3): two store
   preferences (`narrowExpanded` vs `sidebar`), the threshold reset, and the
   deliberately missing `data-animating` on viewport-driven changes. */
{
	const browser = createBrowser();
	browser.collapse();
	assert.equal(browser.win.innerWidth, 1280, "the default viewport is wide");
	browser.resize(900);
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), "true", "narrow with no override stays collapsed");
	assert.equal(browser.frame.hasAttribute("data-animating"), false, "a viewport-driven change publishes no animating marker");
	browser.layout.toggleSidebar();
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), null, "in narrow mode the toggle flips narrowExpanded");
	assert.equal(browser.frame.hasAttribute("data-animating"), true, "a discrete toggle does publish the animating marker");
	assert.equal(
		browser.frame.getAttribute("data-animating"),
		"true",
		"the shell's own marker carries the literal true — the value the behavior's pre-arm must not be mistaken for"
	);
	browser.endTransition();
	browser.resize(1280);
	assert.equal(browser.frame.hasAttribute("data-animating"), false, "crossing the threshold is viewport-driven — no marker");
	assert.equal(
		browser.frame.getAttribute("data-sidebar-collapsed"),
		"true",
		"the narrow reveal does not carry into wide mode (the sidebar preference is still 0)"
	);
	browser.layout.toggleSidebar();
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), null, "in wide mode the toggle flips the sidebar preference");
	browser.endTransition();
	browser.resize(900);
	assert.equal(
		browser.frame.getAttribute("data-sidebar-collapsed"),
		"true",
		"narrowing the window auto-collapses an open sidebar — the framework's decision, with no marker"
	);
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

/* 3b. The wait for a marker the frame never clears is bounded. Every re-arm shares one
   start, so `ANIMATION_HARD_STOP_MS` measures the whole wait rather than each slice of
   it: a transition that never ends delays the retraction, but cannot pin the drawer
   open for good. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.move(600, 300);
	/* The frame announces a column transition and then never ends it. */
	browser.endTransition();
	browser.frame.setAttribute("data-animating", "true");
	browser.advance(100);
	assert.equal(browser.timersOf(260), 1, "a close is pending");
	browser.advance(2600);
	assert.equal(
		browser.layout.toggles,
		1,
		"a marker still being claimed keeps holding the retraction back"
	);
	browser.advance(1500);
	assert.equal(
		browser.layout.toggles,
		2,
		"and once the wait as a whole passes the hard stop, the same verdict retracts anyway"
	);
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

/* 9. Disposal removes every listener and timer — document, window, and the frame
   transition listener the pre-arm attaches. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.move(600, 300);
	/* The reveal pre-armed the frame, so its transitionend listener is attached. */
	assert.equal((browser.frame.listeners.get("transitionend") ?? []).length, 1, "the pre-arm listens on the frame");
	dispose();
	/* The frame's own transition marker is the harness's, not the behavior's. */
	browser.endTransition();
	assert.equal(browser.pendingTimers(), 0, "disposal clears every timer");
	const before = browser.layout.toggles;
	browser.advance(2000);
	assert.equal(browser.layout.toggles, before, "no work after disposal");
	for (const type of ["pointermove", "pointerleave", "pointerenter"]) {
		assert.equal((browser.doc.listeners.get(type) ?? []).length, 0, `the document ${type} listener is gone`);
	}
	for (const type of ["resize", "scroll", "blur", "focus"]) {
		assert.equal((browser.win.listeners.get(type) ?? []).length, 0, `the window ${type} listener is gone`);
	}
	assert.equal((browser.frame.listeners.get("transitionend") ?? []).length, 0, "the frame transition listener is gone");
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
	const realToggle = browser.layout.toggleSidebar.bind(browser.layout);
	let failing = true;
	browser.layout.toggleSidebar = () => {
		if (failing) throw new Error("store closed");
		realToggle();
	};
	try {
		browser.moveAndRest(3, 200);
	} finally {
		console.error = originalError;
	}
	assert.equal(errors.length, 1, "the failure surfaces as one diagnostic");
	/* Contained, not fatal: the store recovers, and the next gesture goes through. */
	failing = false;
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "the behavior still reveals once the store recovers");
	browser.move(600, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "and still retracts");
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
	/* A resize reflows the frame while no pointer event arrives. Stays above the
	   auto-collapse threshold: a crossing would be the framework's own collapse
	   (narrow path, client 21c), not a retraction to judge here. */
	browser.resize(1100);
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

/* 14b. A scroll mid-dwell invalidates the dwell itself (issue #1 story 5, as
    corrected: the dwell is voided, and the re-timing lands on the evidence — the next
    fresh strip sample — not on the scroll). The reveal must never fire from the stale
    coordinate; the scroll may well have carried the strip away from under the
    pointer — and the timing restarts from zero when the pointer next lands there. */
{
	const { browser, dispose } = mount();
	browser.move(3, 300); /* the dwell starts */
	browser.advance(200);
	browser.dispatchWindow("scroll");
	browser.advance(800);
	assert.equal(browser.layout.toggles, 0, "the scroll must not fire the reveal from the stale coordinate");
	browser.move(3, 300); /* a fresh sample back in the strip */
	browser.advance(300);
	assert.equal(browser.layout.toggles, 0, "the dwell restarts from scratch");
	browser.advance(300);
	assert.equal(browser.layout.toggles, 1, "and then reveals");
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

/* 20. A reveal yields to a transition someone else started: the dwell must not
   fire a toggle into a hand-open's animation (that mid-flip is what makes a
   just-opened sidebar "suddenly disappear"). */
{
	const browser = createBrowser();
	/* A hand-open (Cmd+B / the button) is mid-animation: the marker already flipped
	   to expanded, the column is still narrow, and the frame reports the transition.
	   The sidebar is NOT this behavior's. */
	browser.expand(40);
	browser.startTransition();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300);
	browser.advance(550); /* the dwell elapses while the hand-open animates */
	assert.equal(browser.layout.toggles, 0, "no toggle is issued into someone else's animation");
	/* The transition completes: marker off, column at its settled open width. */
	browser.endTransition();
	browser.setWidth(280);
	browser.advance(1500);
	assert.equal(browser.layout.toggles, 0, "a hand-opened sidebar swallows the deferred reveal");
	dispose();
}

/* 20b. Deferred ≠ discarded: when the animation settles into the collapsed state
   (a hand-close), a pointer still resting on the strip is revealed there —
   without any further pointer movement. */
{
	const browser = createBrowser();
	/* A hand-close is mid-animation: the marker already flipped to collapsed, the
	   column is still shrinking, and the frame reports the transition. */
	browser.frame.setAttribute("data-sidebar-collapsed", "true");
	browser.doc.width = 40;
	browser.startTransition();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300);
	browser.advance(550); /* the dwell elapses mid-animation */
	assert.equal(browser.layout.toggles, 0, "the hand-close's animation is not interrupted");
	/* The transition completes collapsed. The deferred reveal must land now. */
	browser.endTransition();
	browser.collapse();
	browser.advance(1500);
	assert.equal(browser.layout.toggles, 1, "the deferred reveal lands once the animation settles");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false, "and the drawer is open");
	dispose();
}

/* 20c. A deferred reveal is dropped when the pointer walks off the strip before
   the animation settles — the wait must not turn into an open nobody asked for. */
{
	const browser = createBrowser();
	browser.frame.setAttribute("data-sidebar-collapsed", "true");
	browser.doc.width = 40;
	browser.startTransition();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300);
	browser.advance(550);
	assert.equal(browser.layout.toggles, 0, "no toggle into the animation");
	browser.move(300, 300); /* the pointer walks on into the window */
	browser.endTransition();
	browser.collapse();
	browser.advance(1500);
	assert.equal(browser.layout.toggles, 0, "an intent whose pointer left the strip is not revealed");
	dispose();
}

/* 20d. The other timeline of the same story: the hand-open settles *before* the
   dwell fires. The dwell must re-judge at fire time and leave the hand-opened
   sidebar alone — the "collapsed or barely open" premise is gone. */
{
	const browser = createBrowser();
	browser.collapse();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300); /* the dwell arms while the sidebar is collapsed */
	browser.advance(100);
	browser.expand(280); /* the hand-open settles before the dwell elapses */
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 0, "a settled hand-open is left alone even by a dwelling pointer");
	dispose();
}

/* 21. Narrow mode: the dwell reveals via narrowExpanded and leaving retracts. */
{
	const { browser, dispose } = mount();
	browser.resize(900);
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "the dwell reveals in narrow mode");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false);
	browser.move(700, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 2, "and leaving retracts it in narrow mode");
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), "true");
	dispose();
}

/* 21b. A viewport-driven auto-collapse is the framework's action, not this
   behavior's drawer: it must not be counted as one — and the strip must still be
   able to reveal afterwards (no stuck ownership). */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "drawer revealed");
	browser.move(180, 300);
	browser.advance(0);
	/* Narrowing past the threshold auto-collapses the sidebar — no toggle, no marker. */
	browser.resize(900);
	assert.equal(browser.layout.toggles, 1, "the auto-collapse is not a toggle anyone asked for");
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), "true", "the framework collapsed it");
	/* The pointer rests in the strip: the drawer must be revealable again. The wait
	   is bounded by the in-flight transition settling plus one dwell. */
	browser.move(3, 300);
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 2, "the strip still reveals after an auto-collapse");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false, "and the drawer is open");
	dispose();
}

/* 21c. Widening the window auto-expands by the framework's own rule — and with the
   behavior mounted and the pointer dwelling in the strip, that restore is still the
   framework's decision alone (issue #3 story 5). */
{
	const { browser, dispose } = mount();
	assert.equal(
		browser.doc.documentElement.hasAttribute("dsh-sidebar-drawer"),
		true,
		"the behavior really is mounted — without it, every assertion below would hold vacuously"
	);
	browser.expand(280); /* the wide-mode preference the framework restores below */
	browser.resize(900); /* crossing into narrow auto-collapses */
	assert.equal(browser.frame.getAttribute("data-sidebar-collapsed"), "true");
	browser.layout.toggleSidebar(); /* a hand-open in narrow mode */
	browser.endTransition();
	assert.equal(browser.layout.toggles, 1, "hand-opened in narrow mode");
	assert.equal(browser.frame.hasAttribute("data-sidebar-collapsed"), false);
	/* The pointer comes to rest in the strip: over an open sidebar there is nothing to
	   reveal, so the dwell must pass without a toggle. */
	browser.move(3, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 1, "a dwelling pointer never toggles an open sidebar");
	/* Crossing back: narrowExpanded resets and the wide preference (280) wins. */
	browser.resize(1280);
	assert.equal(
		browser.frame.hasAttribute("data-sidebar-collapsed"),
		false,
		"widening auto-expands — the framework's decision"
	);
	browser.advance(2000);
	assert.equal(browser.layout.toggles, 1, "and no plugin toggle rode along");
	assert.equal(
		browser.frame.hasAttribute("data-sidebar-collapsed"),
		false,
		"the expanded state the framework restored is left exactly as it found it"
	);
	dispose();
}

/* 21d. A hand-open in narrow mode (Cmd+B flips narrowExpanded) is left alone. */
{
	const { browser, dispose } = mount();
	browser.resize(900);
	browser.layout.toggleSidebar();
	browser.endTransition();
	assert.equal(browser.layout.toggles, 1, "hand-opened in narrow mode");
	browser.move(700, 300);
	browser.advance(1200);
	assert.equal(browser.layout.toggles, 1, "an outside pointer never retracts it");
	browser.moveAndRest(3, 300);
	assert.equal(browser.layout.toggles, 1, "and the strip never toggles an open sidebar");
	dispose();
}

/* 20e. A viewport change mid-deferral invalidates the *sample*, not the *intent*:
   the deferred reveal lands on the next fresh strip sample. Absence of evidence is
   not evidence of leaving — the exact fallacy issue #1 forbids. */
{
	const browser = createBrowser();
	browser.frame.setAttribute("data-sidebar-collapsed", "true");
	browser.doc.width = 40;
	browser.startTransition();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300);
	browser.advance(550); /* the dwell elapses mid-animation; the intent defers */
	assert.equal(browser.layout.toggles, 0, "no toggle into the animation");
	browser.dispatchWindow("scroll"); /* the sample is dropped mid-deferral */
	assert.equal(browser.layout.toggles, 0, "the scroll draws no conclusion");
	browser.endTransition();
	browser.collapse();
	browser.advance(800);
	assert.equal(browser.layout.toggles, 0, "nothing fires from the dropped sample");
	/* A fresh sample lands back in the strip: the parked intent lands at once. */
	browser.move(3, 300);
	browser.advance(200);
	assert.equal(browser.layout.toggles, 1, "the deferred reveal is not discarded — it lands on fresh evidence");
	dispose();
}

/* 20f. And the drop condition is real evidence: a fresh sample *outside* the strip
   drops the parked intent (story 6) — a later return goes through the dwell again. */
{
	const browser = createBrowser();
	browser.frame.setAttribute("data-sidebar-collapsed", "true");
	browser.doc.width = 40;
	browser.startTransition();
	const dispose = plugin.install({ document: browser.doc, window: browser.win, layout: browser.layout });
	browser.move(3, 300);
	browser.advance(550);
	browser.dispatchWindow("scroll");
	browser.endTransition();
	browser.collapse();
	browser.advance(800);
	browser.move(300, 300); /* fresh evidence: the pointer is not in the strip */
	browser.advance(200);
	assert.equal(browser.layout.toggles, 0, "a pointer that left the strip must not be revealed");
	browser.move(3, 300);
	browser.advance(200);
	assert.equal(browser.layout.toggles, 0, "a return to the strip re-times the dwell, not an instant reveal");
	browser.advance(400);
	assert.equal(browser.layout.toggles, 1, "and then reveals normally");
	dispose();
}

/* 22. The frame's own transition marker is armed *before* the toggle is asked for
   (issue #4): the shell writes the columns first and publishes that marker in a
   second pass, with a layout read in between, so a write that lands while the
   marker is absent makes the browser adopt the new track sizes with no transition
   in effect — the column snaps instead of travelling. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "the dwell revealed the drawer");
	assert.equal(
		browser.layout.markerAtToggle,
		"drawer",
		"the frame was already armed by this behavior when the store was asked to flip"
	);
	assert.equal(browser.frame.getAttribute("data-animating"), "true", "and the shell's own write claims the marker");
	dispose();
}

/* 22b. A pre-arm the shell never claims is withdrawn at the transition's end: the
   marker is the only thing holding the transition open there, and leaving it behind
   would have every later check read "a column is moving" against nothing. */
{
	const { browser, dispose } = mount();
	/* The store flips but the frame publishes no marker of its own — the race a
	   viewport change creates inside the shell's own effect. */
	browser.layout.silent = true;
	browser.moveAndRest(3, 200);
	assert.equal(browser.layout.toggles, 1, "the dwell still reveals");
	assert.equal(
		browser.frame.getAttribute("data-animating"),
		"drawer",
		"the pre-armed marker stands while the column travels, with nothing else holding it"
	);
	browser.advance(150);
	assert.equal(browser.frame.getAttribute("data-animating"), "drawer", "and it is not withdrawn mid-transition");
	browser.transitionEnd();
	assert.equal(
		browser.frame.hasAttribute("data-animating"),
		false,
		"the marker the shell never claimed is withdrawn once the transition ends"
	);
	dispose();
}

/* 22c. A marker the shell owns is never the behavior's to remove — and a descendant's
   transitionend bubbling past the frame is not the frame's own transition. */
{
	const { browser, dispose } = mount();
	browser.moveAndRest(3, 200);
	browser.transitionEnd({ target: browser.column });
	assert.equal(
		browser.frame.getAttribute("data-animating"),
		"true",
		"a descendant's transition says nothing about the frame's column"
	);
	browser.transitionEnd();
	assert.equal(browser.frame.getAttribute("data-animating"), "true", "a marker the shell claimed is left to the shell");
	browser.endTransition();
	assert.equal(browser.frame.hasAttribute("data-animating"), false, "and the shell clears it when it settles");
	dispose();
}

/* 22d. The withdrawal is bounded: a change that never transitions (nothing claims the
   marker, nothing ends it) must not leave a transition that is not running standing,
   or every later reveal defers against it. */
{
	const { browser, dispose } = mount();
	browser.layout.silent = true;
	browser.moveAndRest(3, 200);
	browser.move(150, 300); /* step inside: no reveal intent is left waiting */
	assert.equal(browser.frame.getAttribute("data-animating"), "drawer", "pre-armed, and nothing will claim it");
	browser.advance(2600);
	assert.equal(
		browser.frame.hasAttribute("data-animating"),
		false,
		"a marker nothing ever claims is withdrawn at the ceiling"
	);
	assert.equal(browser.layout.toggles, 1, "the withdrawal itself toggles nothing");
	dispose();
}

/* Derived from this file's own case headers, so the tally cannot drift away from the
   cases again: adding a case updates the count, and renumbering cannot silently make
   the reported total a lie. */
const caseCount = (readFileSync(new URL(import.meta.url), "utf8").match(/^\/\* \d+[a-z]?\. /gm) ?? []).length;
console.log(`client bundle contract: ${caseCount} cases passed`);
