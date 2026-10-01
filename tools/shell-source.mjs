/**
 * Shipped-shell source inspector.
 *
 * The plugin's whole behavior rests on a DOM contract the app publishes
 * (docs/adr/0001-frame-anchor-contract.md), and the only ground truth for that
 * contract is the app's own bundle. The installed app ships its sources
 * unminified inside an asar archive — a JSON header followed by concatenated
 * file bytes — so any file in it can be read directly, without unpacking.
 *
 * This tool always reads the archive live: the app is updated in place, so a
 * cached copy of an extracted file is stale the moment the app updates. Never
 * trust yesterday's extraction; re-run this instead.
 *
 * Usage:
 *   node tools/shell-source.mjs list [prefix]           list files in the archive
 *   node tools/shell-source.mjs get <path> [out-file]   write one file (UTF-8 sanitised)
 *   node tools/shell-source.mjs grep <pattern> [prefix] byte-offset search, with context
 *
 * `<path>` is the archive-internal path as `list` prints it. The layout package
 * — the one that renders the frame markers — lives at:
 *   /dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js
 *
 * `get` decodes leniently (invalid UTF-8 becomes U+FFFD) so the result can be
 * handed to any text tool. `grep` searches the raw bytes and reports byte
 * offsets, the way `grep -a -o -b` would — see the substring warning below.
 *
 * Landmark strings worth looking for: `data-shell-overlay`, `data-sidebar-collapsed`,
 * `data-shell-leading`, `data-animating`, `AppFrame`, `DragHandle`, `SIDEBAR_AUTO_COLLAPSE`.
 *
 * WARNING — substring trap: `data-sidebar-col` is a substring of
 * `data-sidebar-collapsed`, and a byte-offset grep hits both. A hit is only
 * evidence of an attribute if the character right after the match closes it
 * (space, `=`, `"` or `>`); that is why `grep` prints trailing context.
 *
 * The archive location follows the installed app; override it with
 * `--asar <path>` or `DSH_APP_ASAR` when the app lives elsewhere.
 */
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";

const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
/** Context shown on each side of a grep hit, so a closing delimiter is visible. */
const CONTEXT_BYTES = 48;

/** Split CLI argv into flags and positionals. */
function parseArgs(argv) {
	const flags = new Map();
	const rest = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i].startsWith("--")) {
			flags.set(argv[i].slice(2), argv[i + 1] ?? "");
			i += 1;
		} else {
			rest.push(argv[i]);
		}
	}
	return { flags, rest };
}

/**
 * Open an asar archive and index every file in it.
 * @param asarPath - path to the .asar on disk.
 * @returns a reader with `paths()` and `read(path)`, offsets resolved lazily.
 */
function openArchive(asarPath) {
	const fd = openSync(asarPath, "r");
	const head = Buffer.alloc(16);
	readSync(fd, head, 0, 16, 0);
	const headerSize = head.readUInt32LE(12);
	const headerBytes = Buffer.alloc(headerSize);
	readSync(fd, headerBytes, 0, headerSize, 16);
	const header = JSON.parse(headerBytes.toString("utf8"));
	const base = 16 + headerSize;

	/* One flat index: archive-internal path -> {offset, size}. Entries stored
	   outside the archive (`unpacked`, alongside app.asar.unpacked) or links to
	   other entries carry no data offset here, so they are skipped. Offsets are
	   strings in the asar header, hence the numeric coercion. */
	const index = new Map();
	(function walk(node, path) {
		for (const [name, entry] of Object.entries(node.files ?? {})) {
			const child = path + "/" + name;
			if (entry.files !== undefined) walk(entry, child);
			else if (entry.link === undefined && Number.isFinite(Number(entry.offset)) && Number.isFinite(Number(entry.size))) {
				index.set(child, { offset: Number(entry.offset), size: Number(entry.size) });
			}
		}
	})(header, "");

	return {
		paths() {
			return [...index.keys()].sort();
		},
		read(path) {
			const entry = index.get(path);
			if (entry === undefined) throw new Error(`no such file in archive: ${path}`);
			const buf = Buffer.alloc(entry.size);
			readSync(fd, buf, 0, entry.size, base + entry.offset);
			return buf;
		},
		close() {
			closeSync(fd);
		}
	};
}

/** Decode bytes as UTF-8, replacing whatever is invalid (like `iconv -c`). */
function sanitise(buf) {
	return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Run one subcommand; returns the process exit code. */
function main(argv) {
	const { flags, rest } = parseArgs(argv);
	const asarPath = flags.get("asar") ?? process.env.DSH_APP_ASAR ?? DEFAULT_ASAR;
	const [command, ...args] = rest;

	if (command === undefined) {
		console.error("usage: node tools/shell-source.mjs <list|get|grep> ...   (see the header comment)");
		return 2;
	}

	let archive;
	try {
		archive = openArchive(asarPath);
	} catch (error) {
		console.error(`cannot read ${asarPath}: ${error.message}`);
		console.error("the app may live elsewhere — pass --asar <path> or set DSH_APP_ASAR");
		return 1;
	}

	try {
		if (command === "list") {
			const prefix = args[0] ?? "";
			const paths = archive.paths().filter((path) => path.startsWith(prefix));
			for (const path of paths) console.log(path);
			console.error(`${paths.length} file(s) under "${prefix}"`);
			return 0;
		}

		if (command === "get") {
			const [path, outFile] = args;
			if (path === undefined) {
				console.error("usage: node tools/shell-source.mjs get <path> [out-file]");
				return 2;
			}
			const text = sanitise(archive.read(path));
			if (outFile === undefined) process.stdout.write(text);
			else {
				writeFileSync(outFile, text);
				console.error(`wrote ${outFile} (${text.length} chars, UTF-8 sanitised)`);
			}
			return 0;
		}

		if (command === "grep") {
			const [pattern, prefix] = args;
			if (pattern === undefined) {
				console.error("usage: node tools/shell-source.mjs grep <pattern> [prefix]");
				return 2;
			}
			/* Searched as latin1 so one character is one byte and reported offsets
			   are true byte offsets into the file — the numbers `grep -b` prints. */
			const needle = new RegExp(pattern, "g");
			let hits = 0;
			for (const path of archive.paths()) {
				if (prefix !== undefined && !path.startsWith(prefix)) continue;
				const bytes = archive.read(path);
				const latin = bytes.toString("latin1");
				for (const match of latin.matchAll(needle)) {
					const from = Math.max(0, match.index - CONTEXT_BYTES);
					const to = Math.min(latin.length, match.index + match[0].length + CONTEXT_BYTES);
					const context = latin
						.slice(from, to)
						.replace(/\n/g, "\\n")
						.replace(/\r/g, "\\r")
						.replace(/\t/g, "\\t");
					const anchor = `${path}:${match.index}`;
					console.log(`${anchor}\n  …${context}…`);
					hits += 1;
				}
			}
			console.error(`${hits} hit(s) for /${pattern}/`);
			return 0;
		}

		console.error(`unknown command: ${command}`);
		return 2;
	} finally {
		archive.close();
	}
}

process.exitCode = main(process.argv.slice(2));
