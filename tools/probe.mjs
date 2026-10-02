/**
 * Diagnostic tool: serve the harness plus an instrumented copy of the client
 * bundle, then report what the page saw for one edge dwell.
 *
 * The instrumentation never ships: this tool rewrites `lib/client.js` in memory
 * (adding `window.__trace` records at the behavior's check points), serves that
 * copy and `test/harness.html` from its own loopback server, walks the pointer
 * from the edge into the drawer and back out, and prints the state and the
 * decision trace for each step — including whether the frame was resolvable,
 * which is the anchor contract most of this behavior's verdicts depend on.
 *
 * Usage: node tools/probe.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const chromePath = process.env.CHROME ?? CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (chromePath === undefined) {
	console.log("no chromium build found; set CHROME=/path/to/chrome");
	process.exit(0);
}

/** Insert `window.__trace.push(...)` records at the behavior's decision points. */
function instrument(source) {
	const injections = [
		[
			"\t\t\tfunction onPointerMove(event) {\n\t\t\t\tlastX = event.clientX;",
			'\t\t\tfunction onPointerMove(event) {\n\t\t\t\twindow.__trace.push({ at: "move", x: event.clientX, y: event.clientY });\n\t\t\t\tlastX = event.clientX;'
		],
		[
			"\t\t\tfunction checkPointer() {\n\t\t\t\tframeQueued = false;",
			'\t\t\tfunction checkPointer() {\n\t\t\t\twindow.__trace.push({ at: "check", lastX: lastX, lastY: lastY });\n\t\t\t\tframeQueued = false;'
		],
		[
			"\t\t\t\tconst onStrip = !pointerLeftWindow && lastX <= EDGE_SIZE && !isDragging(frame);",
			'\t\t\t\tconst onStrip = !pointerLeftWindow && lastX <= EDGE_SIZE && !isDragging(frame);\n\t\t\t\t/* `frameFound` is the anchor contract under test: the frame must stay\n\t\t\t\t   resolvable while the drawer is open, not only while it is collapsed. */\n\t\t\t\twindow.__trace.push({ at: "decide", lastX: lastX, lastY: lastY, over: over, onStrip: onStrip, weOpened: weOpened, retain: lastX <= RETAIN_MARGIN, frameFound: frame !== null });'
		]
	];
	let output = source;
	for (const [needle, replacement] of injections) {
		if (!output.includes(needle)) throw new Error(`probe: anchor not found (${needle.slice(0, 48)}…)`);
		output = output.replace(needle, replacement);
	}
	return output;
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-drawer-probe-"));
const bundlePath = join(scratch, "client.trace.js");
writeFileSync(bundlePath, instrument(readFileSync(join(ROOT, "lib/client.js"), "utf8")));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const files = {
	"/harness.html": join(ROOT, "test/harness.html"),
	"/client.trace.js": bundlePath
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

const PORT = Number(process.env.CDP_PORT ?? 9413);
const profileDir = mkdtempSync(join(tmpdir(), "dsh-drawer-chrome-"));
const chrome = spawn(
	chromePath,
	[
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank"
	],
	{ stdio: ["ignore", "ignore", "ignore"] }
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = () => {
	chrome.kill("SIGKILL");
	server.close();
	try {
		rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		rmSync(scratch, { recursive: true, force: true });
	} catch {
		/* disposable temp dirs */
	}
};

try {
	let version;
	for (let attempt = 0; attempt < 60 && version === undefined; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (response.ok) version = await response.json();
		} catch {
			await sleep(250);
		}
	}
	if (version === undefined) throw new Error("chrome devtools endpoint never became ready");

	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
	let nextId = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = pending.get(message.id);
		if (waiter === undefined) return;
		pending.delete(message.id);
		message.error === undefined
			? waiter.resolve(message.result)
			: waiter.reject(new Error(JSON.stringify(message.error)));
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
		});

	const { targetId } = await send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
	const call = (method, params) => send(method, params, sessionId);
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__trace = [];" });
	await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await call("Page.navigate", {
		url: `${base}/harness.html?plugin=${encodeURIComponent(`${base}/client.trace.js`)}`
	});
	await sleep(1000);

	const evaluate = async (expression) => {
		const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails !== undefined) return { exception: JSON.stringify(result.exceptionDetails) };
		return result.result.value;
	};

	const report = async (label) => {
		console.log(`${label}:`);
		console.log("  state:", JSON.stringify(await evaluate("window.__harness.state()")));
		console.log("  trace:", JSON.stringify(await evaluate("window.__trace ?? []")));
	};

	await report("before any pointer input");
	await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 3, y: 400, button: "none", buttons: 0 });
	await sleep(700);
	await report("after resting on the left edge (x=3) — the dwell should have revealed the drawer");
	/* RETAIN_MARGIN is where a lost frame anchor shows up first: at or below 48px the
	   "still leaning on the edge" branch holds the drawer without ever asking whether
	   the pointer is inside it, so only a step past 48 exercises that verdict at all. */
	for (const x of [20, 60, 200]) {
		await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400, button: "none", buttons: 0 });
		await sleep(700);
		await report(`after stepping in to x=${x} — the drawer should still be open`);
	}
	await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 400, button: "none", buttons: 0 });
	await sleep(700);
	await report("after walking out to the center (x=700) — the drawer should have retracted");
} finally {
	cleanup();
}
process.exit(0);
