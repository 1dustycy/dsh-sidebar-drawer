/**
 * Real-browser test for the sidebar edge-hover drawer.
 *
 * Loads test/harness.html (a faithful replica of the shipped frame: the grid
 * collapses the sidebar column to 0px, animates the track, and publishes
 * `data-sidebar-collapsed`), imports lib/client.js as the page's module, and
 * drives it with real CDP mouse events. Assertions read the harness state, so
 * they cover the parts a unit double cannot: layout clipping, the open
 * animation, and hit testing.
 *
 * Run: node test/browser.test.mjs   (needs a chromium build; see CHROME below)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME_CANDIDATES = [
	join(
		process.env.HOME,
		"Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"
	),
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium"
];

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (chromePath === undefined) {
	console.log("browser harness skipped: no chromium build found");
	process.exit(0);
}

/* The suite serves the harness and the real bundle itself: no background server. */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const files = {
	"/harness.html": join(ROOT, "test", "harness.html"),
	"/client.js": process.env.DEBUG_BUNDLE ?? join(ROOT, "lib", "client.js")
};
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://127.0.0.1").pathname;
	const file = files[path];
	if (file === undefined) {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const HARNESS_URL = process.env.HARNESS_URL ?? `${base}/harness.html`;
const PLUGIN_URL = process.env.PLUGIN_URL ?? `${base}/client.js`;
const PORT = Number(process.env.CDP_PORT ?? 9411);

const profileDir = mkdtempSync(join(tmpdir(), "dsh-drawer-chrome-"));
const chrome = spawn(
	chromePath,
	[
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank"
	],
	{ stdio: ["ignore", "ignore", "pipe"] }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the DevTools endpoint to answer. */
async function waitForDevTools() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (response.ok) return await response.json();
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("chrome devtools endpoint never became ready");
}

/** Minimal CDP client over the built-in WebSocket. */
async function connect(webSocketDebuggerUrl) {
	const socket = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
	});
	let nextId = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = pending.get(message.id);
		if (waiter === undefined) return;
		pending.delete(message.id);
		if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
		else waiter.resolve(message.result);
	});
	return {
		send(method, params = {}, sessionId) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
			});
		},
		close() {
			socket.close();
		}
	};
}

const cleanup = () => {
	chrome.kill("SIGKILL");
	server.close();
	try {
		rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		/* chrome may still hold files; the temp dir is disposable */
	}
};

let failures = 0;
try {
	const version = await waitForDevTools();
	const browser = await connect(version.webSocketDebuggerUrl);
	const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
	const send = (method, params) => browser.send(method, params, sessionId);

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false
	});
	await send("Page.navigate", { url: `${HARNESS_URL}?plugin=${encodeURIComponent(PLUGIN_URL)}` });
	await sleep(900);

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails !== undefined) {
			throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails)}`);
		}
		return result.result.value;
	};

	const state = () => evaluate("window.__harness.state()");
	const move = async (x, y) => {
		/* Real input events: the page sees them exactly like a user's mouse. */
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
		await sleep(40);
	};
	/** Move into the 10px strip and hold there, as a user does when they mean it. */
	const dwellAtEdge = async (x = 3, y = 400) => {
		await move(x, y);
		await sleep(700);
	};

	const check = async (label, fn) => {
		try {
			await fn();
			console.log(`  ✓ ${label}`);
		} catch (error) {
			failures += 1;
			console.log(`  ✗ ${label}\n      ${error.message}`);
			console.log(`      state: ${JSON.stringify(await state())}`);
			console.log(`      events: ${JSON.stringify(await evaluate("window.__harness.events"))}`);
			console.log(`      plugin: ${JSON.stringify(await evaluate("({ mounted: window.__harness.marker(), bundle: (new URLSearchParams(location.search)).get('plugin') })"))}`);
		}
	};

	console.log("browser harness (real mouse events):");
	assert.equal(await evaluate("typeof window.__exports"), "object", "the bundle must mount in the page");
	assert.equal(await evaluate("window.__harness.marker()"), true, "the mounted marker must be set");

	/* The fixtures are the only thing between this suite and a green run on a broken
	   bundle: they once kept a conditional anchor permanently mounted and let a fatal
	   bug ship. So the fixture's own frame contract is asserted, in both states. */
	await check("the harness models the shipped frame contract in both states", async () => {
		const probe = () =>
			evaluate(`(() => {
				const frame = document.getElementById("frame");
				return {
					collapsedRaw: frame.getAttribute("data-sidebar-collapsed"),
					overlay: document.querySelector("[data-shell-overlay]") !== null,
					leading: document.querySelector("[data-shell-leading]") !== null,
					handle: document.querySelector('[data-side="sidebar"]') !== null,
					width: Math.round(document.getElementById("sidebarCol").getBoundingClientRect().width)
				};
			})()`);

		const closed = await probe();
		assert.equal(closed.collapsedRaw, "true", "the collapsed marker carries the literal true, not an empty value");
		assert.equal(closed.overlay, true, "the overlay anchor is unconditional");
		assert.equal(closed.leading, true, "the leading seat is mounted while collapsed");
		assert.equal(closed.handle, false, "the sidebar handle is unmounted while collapsed");
		assert.equal(closed.width, 0, "the collapsed darwin column measures exactly 0px");

		await dwellAtEdge(3, 400);
		const open = await probe();
		assert.equal(open.collapsedRaw, null, "the collapsed marker leaves the document when the drawer opens");
		assert.equal(open.overlay, true, "the overlay anchor survives the drawer opening");
		assert.equal(open.leading, false, "the leading seat unmounts when the drawer opens");
		assert.equal(open.handle, true, "the sidebar handle mounts when the drawer opens");

		/* Back to closed for the cases that follow. */
		await move(900, 400);
		await sleep(900);
		assert.equal((await state()).sidebar, 0, "the harness is restored to closed");
	});

	await check("contact alone does not open the drawer", async () => {
		assert.equal((await state()).sidebar, 0, "precondition: closed");
		/* Touch the strip and move on before the dwell elapses. */
		await move(2, 400);
		await sleep(200);
		await move(120, 400);
		await sleep(900);
		assert.equal((await state()).sidebar, 0, "a pointer passing through the strip opens nothing");
	});

	await check("a pointer resting in the 10px strip opens the drawer", async () => {
		await dwellAtEdge(3, 400);
		const after = await state();
		assert.equal(after.sidebar, 280, "the dwell opened it");
		assert.equal(after.collapsed, false, "the frame reports an open sidebar");
	});

	await check("the pointer resting at the edge is not ejected while the drawer animates open", async () => {
		await sleep(1500);
		const after = await state();
		assert.equal(after.sidebar, 280, "still open after the animation settled");
		assert.equal(after.collapsed, false, "the frame reports an open sidebar");
		assert.ok(after.columnWidth > 250, `column is visibly wide (${after.columnWidth}px)`);
	});

	await check("a motionless pointer in the strip never starts an open/close loop", async () => {
		/* The gesture, then absolutely no further pointer input: the drawer must simply
		   stay open. The handler only runs on pointer movement, so this also covers the
		   timers that wake up on their own after the reveal. */
		const countToggles = () => evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		/* Counted relative to now, not to page load: an absolute count silently depends on
		   every case that ran before this one. */
		const before = await countToggles();
		const samples = [];
		for (let i = 0; i < 20; i += 1) {
			await sleep(200);
			samples.push((await state()).sidebar);
		}
		const closed = samples.filter((width) => width === 0).length;
		assert.equal(closed, 0, `the drawer closed on its own ${closed}/20 samples: ${samples.join(",")}`);
		const extra = (await countToggles()) - before;
		assert.equal(extra, 0, `a motionless pointer produced ${extra} redundant toggle(s)`);
	});

	await check("leaning a little way in during the reveal does not snap it shut", async () => {
		/* The reported gesture: reveal from the edge, then step in a few dozen px and
		   stop. The drawer must finish growing under the pointer and stay there. */
		await move(900, 400);
		await sleep(1200);
		assert.equal((await state()).sidebar, 0, "precondition: closed again");
		await dwellAtEdge(2, 300);
		assert.equal((await state()).sidebar, 280, "revealed from the edge");
		/* Step in while the column is still nowhere near 60px wide. */
		await move(60, 300);
		for (const wait of [100, 200, 400, 800]) {
			await sleep(wait);
			assert.equal((await state()).sidebar, 280, `still open ${wait}ms after leaning in`);
		}
		assert.ok((await state()).columnWidth > 250, "the drawer finished growing under the pointer");
	});

	await check("a small retreat toward the strip keeps it revealed", async () => {
		/* The other half of the report: after the reveal, drifting back toward the edge
		   must not be read as leaving. */
		for (const [x, y] of [
			[20, 300],
			[6, 300],
			[1, 300],
			[30, 120]
		]) {
			await move(x, y);
			await sleep(600);
			assert.equal((await state()).sidebar, 280, `pointer at x=${x} holds the drawer`);
		}
	});

	await check("a real exit past the strip does retract it", async () => {
		await move(600, 300);
		await sleep(800);
		assert.equal((await state()).sidebar, 0, "walking away still retracts the drawer");
		await dwellAtEdge(2, 300);
		assert.equal((await state()).sidebar, 280, "re-revealed for the remaining cases");
	});

	await check("an inside pointer holds the drawer open indefinitely", async () => {
		for (const [x, y] of [
			[40, 100],
			[200, 300],
			[279, 700],
			[150, 20]
		]) {
			await move(x, y);
			await sleep(400);
		}
		assert.equal((await state()).sidebar, 280, "no retraction while inside");
	});

	await check("clicking a row inside the drawer keeps it open", async () => {
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 40, button: "left", clickCount: 1 });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 40, button: "left", clickCount: 1 });
		await sleep(400);
		assert.equal((await state()).sidebar, 280, "interaction inside must not retract it");
	});

	await check("leaving the drawer retracts it after the grace delay", async () => {
		await move(700, 400);
		await sleep(120);
		assert.equal((await state()).sidebar, 280, "still open during the grace delay");
		await sleep(400);
		assert.equal((await state()).sidebar, 0, "retracted after the delay");
		assert.equal((await state()).collapsed, true, "the frame reports a closed sidebar");
	});

	await check("returning inside before the delay cancels the retraction", async () => {
		await dwellAtEdge(3, 400);
		await move(700, 400);
		await sleep(80);
		await move(120, 300);
		await sleep(600);
		assert.equal((await state()).sidebar, 280, "re-entry kept it open");
	});

	await check("crossing the drawer to the center retracts it", async () => {
		await move(900, 300);
		await sleep(500);
		assert.equal((await state()).sidebar, 0, "the drawer retracted");
	});

	await check("a closed drawer reopens on the next edge hover", async () => {
		await move(600, 400);
		await sleep(200);
		await move(2, 250);
		await sleep(700);
		assert.equal((await state()).sidebar, 280, "second reveal works");
		await move(800, 400);
		await sleep(600);
		assert.equal((await state()).sidebar, 0, "and it retracts again");
	});

	await check("a hand-opened sidebar is left alone", async () => {
		await evaluate("window.__harness.layout.toggleSidebar()");
		await sleep(700);
		assert.equal((await state()).sidebar, 280, "opened by hand");
		const before = await evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		await move(900, 400);
		await sleep(600);
		assert.equal((await state()).sidebar, 280, "the behavior must not retract a hand-opened sidebar");
		await dwellAtEdge(3, 400);
		assert.equal((await state()).sidebar, 280, "and it must not toggle it from the edge either");
		const after = await evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		assert.equal(after, before, "a hand-opened sidebar produced no extra toggles");
		await evaluate("window.__harness.layout.toggleSidebar()");
		await sleep(500);
		assert.equal((await state()).sidebar, 0, "the harness is reset for the final count");
	});

	await check("no toggle happens without a pointer or a hand action", async () => {
		const before = await evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		await sleep(1200);
		const after = await evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		assert.equal(after, before, `an idle pointer produced a toggle (${before} -> ${after})`);
		assert.equal((await state()).sidebar, 0, "the harness ends closed");
	});

	await check("a page scroll never retracts a drawer the pointer is still in", async () => {
		/* The reported feel: reading inside the drawer, scrolling the page — and the
		   drawer vanished. A viewport change only invalidates the pointer sample (the
		   drawer moved under a pointer that never moved); it must never conclude
		   "the pointer left" by itself. Real scroll, real reflow, real hit testing. */
		assert.equal((await state()).sidebar, 0, "precondition: closed");
		await dwellAtEdge(3, 400);
		assert.equal((await state()).sidebar, 280, "revealed from the edge");
		await move(140, 200);
		const countToggles = () => evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		const before = await countToggles();
		/* A real wheel scroll of the document. */
		await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 140, y: 200, deltaX: 0, deltaY: 120, button: "none", buttons: 0 });
		await sleep(150);
		assert.ok((await evaluate("window.scrollY")) > 0, "the page actually scrolled");
		await sleep(800);
		assert.equal((await state()).sidebar, 280, "the drawer stays revealed through the scroll");
		assert.equal((await state()).collapsed, false, "the frame still reports an open sidebar");
		/* A scroll mid-grace cancels the queued retraction too, or the fix only covers
		   half of the cases. */
		await move(700, 400);
		await sleep(80);
		await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 400, deltaX: 0, deltaY: -120, button: "none", buttons: 0 });
		await sleep(800);
		assert.equal((await state()).sidebar, 280, "a scroll during the grace cancels the queued retraction");
		/* A real exit afterwards still retracts: this must not become "never closes". */
		await move(140, 200);
		await move(700, 400);
		await sleep(700);
		assert.equal((await state()).sidebar, 0, "a fresh outside sample still retracts the drawer");
		assert.equal((await countToggles()) - before, 1, "exactly one toggle through the whole case — the real exit");
		/* Restore the scroll so the cases after this one see the layout they expect. */
		await evaluate("window.scrollTo(0, 0)");
	});

	await check("a reveal yields to a hand-open's animation", async () => {
		/* Cmd+B / the button starts the sidebar's own transition while the pointer is
		   waiting out its dwell in the strip. A toggle fired into that transition
		   cancels it and the sidebar snaps — the "sudden disappearance" this behavior
		   exists to prevent. The reveal must let the hand-open finish and then leave it
		   alone (a hand-opened sidebar is never touched), whatever the exact timing of
		   the dwell against the transition. */
		assert.equal((await state()).sidebar, 0, "precondition: closed");
		const countToggles = () => evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		const before = await countToggles();
		await move(2, 300); /* the dwell starts ticking */
		await sleep(300);
		await evaluate("window.__harness.layout.toggleSidebar()"); /* the hand-open begins */
		await sleep(600); /* the dwell fires somewhere inside this window */
		assert.equal((await state()).sidebar, 280, "the hand-open's transition completed unbroken");
		assert.equal((await state()).animating, false, "and the frame is settled");
		await sleep(600);
		assert.equal((await state()).sidebar, 280, "the hand-opened sidebar stays untouched");
		assert.equal((await countToggles()) - before, 1, "exactly one toggle through the whole case — the hand action");
		/* Reset for whatever follows. */
		await evaluate("window.__harness.layout.toggleSidebar()");
		await sleep(600);
		assert.equal((await state()).sidebar, 0, "the harness is reset to closed");
	});

	await check("a narrow viewport auto-collapses without a toggle and the strip still reveals", async () => {
		/* The narrow path (issue #3): below SIDEBAR_AUTO_COLLAPSE the store flips
		   narrowExpanded instead of the sidebar preference, crossing the threshold
		   resets it, and the viewport-driven collapse publishes NO data-animating.
		   The auto-collapse is the framework's action — the plugin must neither be
		   charged for it nor lose the strip to it. */
		const countToggles = () => evaluate("window.__harness.events.filter((line) => line.startsWith('toggleSidebar')).length");
		assert.equal((await state()).sidebar, 0, "precondition: closed");
		await dwellAtEdge(3, 400);
		assert.equal((await state()).sidebar, 280, "revealed in wide mode");
		await move(140, 200);
		const before = await countToggles();
		/* Narrow the real viewport across the threshold. */
		await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
		await sleep(400);
		assert.equal((await state()).sidebar, 0, "the framework auto-collapsed the sidebar");
		assert.equal((await state()).collapsed, true, "the frame reports collapsed");
		assert.equal((await countToggles()) - before, 0, "the auto-collapse asked for no toggle");
		/* The strip must still reveal afterwards — no stuck ownership. */
		await move(3, 400);
		await sleep(2200);
		assert.equal((await state()).sidebar, 280, "the strip still reveals in narrow mode");
		/* And leaving retracts it there too. */
		await move(700, 400);
		await sleep(900);
		assert.equal((await state()).sidebar, 0, "leaving retracts in narrow mode");
		const afterNarrow = await countToggles();
		/* Back to wide: the wide preference is still 280, so the framework auto-expands
		   — its own rule (client 21c), with no toggle charged to the plugin. */
		await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await sleep(300);
		assert.equal((await state()).sidebar, 280, "widening auto-expands by the framework's rule");
		assert.equal((await countToggles()) - afterNarrow, 0, "and the plugin asked for no toggle");
		/* Hand-close to reset the harness for whatever follows. */
		await evaluate("window.__harness.layout.toggleSidebar()");
		await sleep(600);
		assert.equal((await state()).sidebar, 0, "the harness ends closed");
	});

	/* Evidence shot: hold the pointer inside the revealed drawer, then capture it. */
	await dwellAtEdge(3, 400);
	await move(140, 200);
	await sleep(300);
	const screenshot = await send("Page.captureScreenshot", { format: "png" });
	const { writeFileSync } = await import("node:fs");
	const shotPath = process.env.SHOT ?? join(tmpdir(), "dsh-drawer-harness.png");
	writeFileSync(shotPath, Buffer.from(screenshot.data, "base64"));
	console.log(`  · screenshot: ${shotPath}`);

	browser.close();
} finally {
	cleanup();
}

if (failures > 0) {
	console.log(`browser harness: ${failures} case(s) failed`);
	process.exit(1);
}
console.log("browser harness: all cases passed");
process.exit(0);
