window.__ModuleLoader__.load({
	id: "dsh-sidebar-drawer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Edge-hover drawer for the left sidebar.
		 *
		 * The sidebar keeps its shipped open/close semantics; this behavior only
		 * drives `toggleSidebar()` from pointer position:
		 *
		 *  - the pointer entering the left edge strip while the sidebar is closed
		 *    opens it (hover-to-reveal);
		 *  - the pointer inside the revealed drawer keeps it open, so the user can
		 *    read and click without hurry (each move is checked against the drawer's
		 *    live box, and every "outside" verdict is confirmed by a second check
		 *    after the grace delay, which also absorbs the open animation);
		 *  - the pointer leaving the drawer retracts it, but only when this
		 *    behavior is the one that opened it — a sidebar the user opened by
		 *    hand (button, shortcut, width drag, or `narrowExpanded`) is left alone.
		 *
		 * The drawer's geometry is read from the live DOM instead of the layout
		 * store, so width drags, the collapsed rail, an open right panel, and the
		 * frame's open/close animation are all honored without mirroring layout
		 * math.
		 */

		/** Width of the left screen-edge strip a pointer must rest in to reveal the drawer. */
		const EDGE_SIZE = 10;
		/**
		 * How long the pointer must stay in that strip. Revealing on contact alone made a
		 * pointer merely crossing the edge — on its way to the content, or flicked there —
		 * throw the drawer open; the dwell makes the reveal deliberate, and leaves the
		 * strip before it elapses.
		 */
		const DWELL_MS = 500;
		/** Grace before a pointer found outside the drawer retracts it. */
		const CLOSE_DELAY_MS = 260;
		/** Slack allowed past the drawer's outer edge, in px. */
		const POINTER_MARGIN = 4;
		/**
		 * Selector of the sidebar's column drag handle, treated as part of the drawer.
		 * The shipped handle publishes its side and is mounted only while the sidebar is
		 * open, so this deliberately matches nothing in the collapsed state — where the
		 * collapsed column is the reveal strip itself and must stay unclaimed.
		 */
		const HANDLE_SELECTOR = '[data-side="sidebar"]';
		/**
		 * How far past the reveal strip a pointer must travel before leaning back to it
		 * counts as leaving. The drawer grows over one animation from 0 to its full
		 * width, so "outside the box" is not yet a verdict while it is still growing:
		 * a pointer that stepped a little way in is waiting for the drawer to reach it,
		 * and retracting there would make the reveal feel like it snaps shut.
		 */
		const RETAIN_MARGIN = 48;
		/** Width at which a column counts as a settled open drawer rather than a moving edge. */
		const OPEN_SETTLED_WIDTH = 56;
		/**
		 * How often a deferred retraction re-checks whether the shell is still animating.
		 * The frame publishes its own `data-animating` marker around a discrete column
		 * change (and clears it on `transitionend`, self-capped at 600ms), so the
		 * retraction polls that marker instead of assuming any duration — a slower
		 * animation simply defers longer. Note a viewport-driven collapse publishes no
		 * marker at all, so its absence must never be read as "a transition just ended".
		 */
		const ANIMATION_POLL_MS = 120;
		/**
		 * Ceiling on that polling, in case the marker is never cleared. The shell caps its
		 * own marker at 600ms, so this sits deliberately far above any real transition:
		 * the poll, not this bound, is what ends the wait.
		 */
		const ANIMATION_CEILING_MS = 2500;
		/** Absolute cap on a deferred retraction, whatever the markers claim. */
		const ANIMATION_HARD_STOP_MS = 3500;
		/** Marker set on the document element while this behavior is mounted. */
		const MARK = "dsh-sidebar-drawer";
		/** The frame publishes this marker while a column transition is running. */
		const ANIMATING_ATTR = "data-animating";
		/** The frame publishes this marker while the sidebar is closed. */
		const COLLAPSED_ATTR = "data-sidebar-collapsed";
		/** The frame publishes this marker while the user drags a column handle. */
		const DRAGGING_ATTR = "data-dragging";
		/**
		 * The frame's window-chrome seat. Mounted only while the sidebar is collapsed
		 * (the shipped shell gates it on `darwin && sidebarCollapsed`), so it is a
		 * fallback anchor and never the one that always exists.
		 */
		const LEADING_ATTR = "data-shell-leading";
		/**
		 * The frame's overlay layer: an unconditional child of the frame, and one of only
		 * two frame markers the shipped shell renders in every state (the rightbar column
		 * carries the other). It is the one that identifies the frame itself, so the frame
		 * lookup tries it first. See `docs/adr/0001-frame-anchor-contract.md`.
		 */
		const OVERLAY_ATTR = "data-shell-overlay";

		/**
		 * Resolve the frame element that carries the layout markers.
		 *
		 * The overlay layer is asked first because it is the only anchor the shipped
		 * shell renders unconditionally. Every other anchor here is conditional:
		 * `data-sidebar-collapsed` and `data-shell-leading` both leave the document the
		 * moment the sidebar opens, so anchoring on them alone loses the frame in
		 * exactly the state the drawer is used in — which reads as "the pointer is not
		 * over the drawer" and retracts it on every check. See
		 * `docs/adr/0001-frame-anchor-contract.md`.
		 * @param doc - document to query.
		 * @returns the frame element, or null while the shell is not mounted.
		 */
		function frameOf(doc) {
			const overlay = doc.querySelector("[" + OVERLAY_ATTR + "]");
			const overlayAnchored = overlay !== null ? overlay.parentElement : null;
			if (overlayAnchored !== null) return overlayAnchored;
			const collapsed = doc.querySelector("[" + COLLAPSED_ATTR + "]");
			if (collapsed !== null) return collapsed;
			const leading = doc.querySelector("[" + LEADING_ATTR + "]");
			const seatAnchored = leading !== null ? leading.parentElement : null;
			if (seatAnchored !== null) return seatAnchored;
			const column = doc.querySelector("[data-sidebar-col]");
			return column !== null ? column.parentElement : null;
		}

		/**
		 * The frame's first grid child: the shipped sidebar column.
		 *
		 * This holds only because the shipped frame's first entry in its children array,
		 * `DocumentTitle`, renders `null` and therefore creates no element. A real element
		 * placed ahead of the sidebar column would silently make this measure the wrong
		 * node, so re-check it against the shell before trusting the box.
		 */
		function columnOf(frame) {
			return frame === null ? null : frame.firstElementChild;
		}

		/**
		 * Whether the frame reports a closed sidebar.
		 * @param frame - frame element, or null.
		 * @returns true while the sidebar is collapsed.
		 */
		function isCollapsed(frame) {
			return frame !== null && frame.getAttribute(COLLAPSED_ATTR) === "true";
		}

		/**
		 * Whether a column drag is in flight (a drag must never be interrupted).
		 * @param frame - frame element, or null.
		 * @returns true while the frame reports dragging.
		 */
		function isDragging(frame) {
			return frame !== null && frame.hasAttribute(DRAGGING_ATTR);
		}

		/**
		 * Mount the edge-hover drawer behavior.
		 * @param deps - injectable document, window, and layout service (tests pass doubles).
		 * @returns a disposer removing every listener, timer, and DOM mark.
		 */
		function install(deps) {
			const doc = deps.document;
			const win = deps.window;
			const layout = deps.layout;

			/** True while this behavior opened the drawer and no other actor has touched it. */
			let weOpened = false;
			/** True while the pointer is known to be over the revealed drawer. */
			let pointerInside = false;
			/** Live handle of the pending close, or null. */
			let closeTimer = null;
			/** Last pointer position seen by a move event; -1 while no sample is live. */
			let lastX = -1;
			let lastY = -1;
			/** False once a leave event reports the pointer gone; re-judged from the sample. */
			let pointerLeftWindow = false;
			/** Set while a move is queued, so moves coalesce into one check per frame. */
			let frameQueued = false;
			/**
			 * True from the moment this behavior asks to close until that transition has
			 * settled. It is what tells a half-grown column apart from a half-shrunk one:
			 * both read as "narrow", and only this flag says which way it is going.
			 */
			let retracting = false;
			/** True while the shell's transition is still running for our last toggle. */
			let togglePending = false;
			let pendingTimer = null;
			/** Start of the current toggle's transition, for the ceiling on deferral. */
			let pendingSince = 0;
			/** Set when the pointer waits on the strip through a retraction. */
			let revealNextCheck = false;
			/** Live handle of the pending dwell in the reveal strip, or null. */
			let dwellTimer = null;
			let disposed = false;

			function cancelClose() {
				if (closeTimer === null) return;
				win.clearTimeout(closeTimer);
				closeTimer = null;
			}

			/** Cancel a dwell that has not fired yet. */
			function cancelDwell() {
				if (dwellTimer === null) return;
				win.clearTimeout(dwellTimer);
				dwellTimer = null;
			}

			/** Cancel the settled-check armed by the last toggle. */
			function cancelPending() {
				if (pendingTimer === null) return;
				win.clearTimeout(pendingTimer);
				pendingTimer = null;
			}

			/**
			 * Mark our toggle as transitioning and settle the state once the shell stops
			 * animating. The marker is polled rather than awaited: it is the frame's own
			 * `data-animating` attribute, which covers the whole transition and is cleared
			 * on `transitionend`, so no duration has to be guessed here.
			 */
			function markToggle() {
				togglePending = true;
				pendingSince = win.performance.now();
				cancelPending();
				const settle = () => {
					const frame = frameOf(doc);
					const animating = frame !== null && frame.hasAttribute(ANIMATING_ATTR);
					if (animating && win.performance.now() - pendingSince < ANIMATION_CEILING_MS) {
						pendingTimer = win.setTimeout(settle, ANIMATION_POLL_MS);
						return;
					}
					pendingTimer = null;
					togglePending = false;
					retracting = false;
					/* One more look once the geometry stops moving: a pointer that waited
					   on the strip is revealed there, and one that walked off is not. */
					checkPointer();
					/* A close that was deferred for this transition is not forgotten: the
					   same verdict is applied again against the settled geometry. */
					if (weOpened && (pointerLeftWindow || !pointerOverDrawer())) armClose();
				};
				pendingTimer = win.setTimeout(settle, ANIMATION_POLL_MS);
			}

			/**
			 * Ask the layout service for the shipped sidebar toggle.
			 * @returns true when a toggle was issued; false when a previous one is still
			 * animating, because a second flip mid-transition cancels the shell's own
			 * animation and the drawer snaps instead of sliding.
			 */
			function toggleSidebar() {
				if (togglePending) return false;
				markToggle();
				try {
					layout.toggleSidebar();
				} catch (error) {
					console.error("sidebar drawer: toggleSidebar failed", error);
				}
				return true;
			}

			/** Open the drawer and take ownership of it. */
			function reveal() {
				if (togglePending) return;
				cancelClose();
				cancelDwell();
				revealNextCheck = false;
				weOpened = true;
				pointerInside = true;
				toggleSidebar();
			}

			/** Whether the shell's transition is still running for our last toggle. */
			function toggleInFlight() {
				return togglePending;
			}

			/**
			 * Whether the pointer is inside the viewport, judged by the sample itself.
			 *
			 * A `mouseleave` (or a window blur) marks the pointer as gone, but the only
			 * thing that marks it back is another move — and a pointer resting perfectly
			 * still after the drawer reveals sends no such event. So the sample is asked
			 * directly: a point inside the viewport that still hits an element is a
			 * pointer this page can see, whatever the last leave event claimed.
			 */
			function pointerInViewport() {
				if (lastX < 0) return false;
				if (lastX < win.innerWidth && lastY < win.innerHeight) return true;
				const hit = doc.elementFromPoint(lastX, lastY);
				return hit !== null && hit !== undefined;
			}

			/** Whether a live pointer sample exists. */
			function positionIsCurrent() {
				return lastX >= 0;
			}

			/**
			 * Live box of the sidebar column, which is the drawer itself.
			 * @returns the column's rect, or null while the shell is not mounted.
			 */
			function drawerRect() {
				const column = columnOf(frameOf(doc));
				return column === null ? null : column.getBoundingClientRect();
			}

			/**
			 * Whether the shell reports a column transition in progress, for this behavior
			 * or for anyone else. `data-animating` is the frame's own marker around every
			 * discrete column change, so it covers slow transitions without any guess.
			 * @returns true while the frame is animating a column.
			 */
			function drawerIsAnimating() {
				const frame = frameOf(doc);
				return frame !== null && frame.hasAttribute(ANIMATING_ATTR);
			}

			/**
			 * Whether the sidebar is collapsed, per the frame's own marker.
			 *
			 * Deliberately not width-based: a narrow column also means "still opening",
			 * and reading that as closed would cancel retractions the pointer asked for.
			 * {@link drawerBarelyOpen} carries the width signal for the reveal gate, while
			 * retractions already wait out the frame's transitions.
			 */
			function drawerIsClosed() {
				return isCollapsed(frameOf(doc));
			}

			/**
			 * Whether the pointer should count as off the drawer while it is still
			 * growing: a column narrower than the closed rail is not a drawer anyone can
			 * be "inside" yet, so it is only usable as a hint, never as a close verdict.
			 */
			function drawerBarelyOpen() {
				const rect = drawerRect();
				return rect !== null && rect.width <= OPEN_SETTLED_WIDTH;
			}

			/**
			 * Whether the pointer is over the drawer, using the drawer's live box.
			 *
			 * The box is taken as it is, even mid-transition: while the drawer grows, the
			 * strip it grows from is already part of it, so a pointer resting there is
			 * inside and must never be read as having left. (Refusing "inside" for a narrow
			 * column is exactly what made a resting pointer loop the drawer open/closed.)
			 *
			 * The left edge takes no slack: the column's own left edge is screen x = 0, so
			 * slack there would swallow part of the reveal strip. Only the right edge takes
			 * {@link POINTER_MARGIN}, because the width handle sits on it and a pointer
			 * resting on the handle is still a pointer on the drawer.
			 */
			function pointerOverDrawer() {
				if (!positionIsCurrent()) return false;
				const column = columnOf(frameOf(doc));
				if (column === null) return false;
				const rect = column.getBoundingClientRect();
				if (rect.width <= 0.5 || rect.height <= 0.5) return false;
				/* The box alone never claims the reveal strip: a closed column is a 0px
				   strip at x = 0, so even {@link POINTER_MARGIN} past its right edge would
				   swallow the strip and the dwell could never arm. The hit test is what
				   covers the width handle sitting just outside that edge. */
				if (
					lastX >= rect.left &&
					lastX <= rect.right + POINTER_MARGIN &&
					lastY >= rect.top - POINTER_MARGIN &&
					lastY <= rect.bottom + POINTER_MARGIN
				) {
					return true;
				}
				/* Consult the element under the pointer, but only where the drawer can
				   actually be reached: a closed sidebar keeps a full-width content box
				   inside its clipping column, so an unguarded hit test would report that
				   hidden content as "inside" and make the strip unusable. The handle is
				   part of the drawer, so it counts even while the column is collapsed. */
				const handle = column.parentElement !== null ? column.parentElement.querySelector(HANDLE_SELECTOR) : null;
				if (rect.width <= OPEN_SETTLED_WIDTH && handle === null) return false;
				const hit = doc.elementFromPoint(lastX, lastY);
				if (hit === null || hit === undefined) return false;
				if (hit === handle || (handle !== null && handle.contains(hit))) return true;
				return hit === column || column.contains(hit);
			}

			/**
			 * Retract the drawer this behavior opened.
			 * @returns true when the retraction was issued or was already unnecessary.
			 */
			function retract() {
				if (!weOpened || disposed) return true;
				weOpened = false;
				pointerInside = false;
				if (drawerIsClosed()) return true;
				retracting = true;
				toggleSidebar();
				return true;
			}

			/**
			 * Arm the grace timer; the pointer must still be outside when it expires.
			 *
			 * While the frame is animating a column it has no settled box to be judged
			 * against, so the timer arms but expires into another arming instead of a
			 * retraction. That is what keeps the reveal from closing behind a pointer that
			 * simply moved a little way in: the drawer is still coming to it. The wait is
			 * bounded so a frame that never clears its marker cannot pin the drawer open.
			 */
			function armClose() {
				if (closeTimer !== null || !weOpened) return;
				const armedAt = win.performance.now();
				closeTimer = win.setTimeout(() => {
					closeTimer = null;
					if (!weOpened) return;
					/* A window-level leave is final. Otherwise the drawer's own box decides,
					   so a sample that still measures inside — a pointer that merely stopped
					   moving — keeps the drawer open instead of flapping it. */
					if (!pointerLeftWindow && pointerOverDrawer()) return;
					const waiting = win.performance.now() - armedAt < ANIMATION_HARD_STOP_MS;
					if (waiting && (drawerIsAnimating() || toggleInFlight())) {
						armClose();
						return;
					}
					retract();
				}, CLOSE_DELAY_MS);
			}

			/** One coalesced pointer check. */
			function checkPointer() {
				frameQueued = false;
				if (disposed || !positionIsCurrent()) return;
				const frame = frameOf(doc);
				const over = pointerOverDrawer();
				/* While the window reports the pointer gone, every recorded position is
				   stale: no reveal, no dwell, no verdict may be based on it. */
				const onStrip = !pointerLeftWindow && lastX <= EDGE_SIZE && !isDragging(frame);
				/* The pointer must rest in the strip: leaving it — usually by walking on
				   into the window — cancels a reveal that has not fired yet. */
				if (!onStrip) cancelDwell();
				/* A pointer that waited on the strip through a retraction gets its reveal
				   now — but only while it is still there: the wait must not turn into an
				   open the pointer has already walked away from. */
				if (revealNextCheck && onStrip && !pointerLeftWindow) {
					revealNextCheck = false;
					reveal();
					return;
				}
				if (onStrip && retracting) {
					/* On its way out with the pointer back on the strip: keep the wish and
					   decide again once that transition has settled. */
					if (!weOpened) revealNextCheck = true;
					return;
				}
				/* While nothing of the drawer is shown, the strip *is* the trigger: no
				   "is the pointer over the drawer" question applies, because there is no
				   drawer yet. (Asking it let the collapsed column's clipped content box —
				   full-width inside a zero-width column — answer "yes" and block the
				   reveal. The drag handle is *not* the culprit: the shipped shell does not
				   mount it at all while the sidebar is collapsed.) See
				   `docs/adr/0002-collapsed-strip-is-the-trigger.md`. */
				if (onStrip && !weOpened && (drawerIsClosed() || drawerBarelyOpen())) {
					/* Arm the dwell once; the timer fires only if the pointer stays. */
					if (dwellTimer === null) {
						dwellTimer = win.setTimeout(() => {
							dwellTimer = null;
							if (!pointerInViewport() || lastX > EDGE_SIZE) return;
							if (weOpened || togglePending) return;
							reveal();
						}, DWELL_MS);
					}
					return;
				}
				if (!weOpened) return;
				if (over) {
					pointerInside = true;
					cancelClose();
					return;
				}
				if (lastX <= RETAIN_MARGIN) {
					/* Still leaning on the reveal strip while the drawer grows: hold it. */
					pointerInside = false;
					cancelClose();
					return;
				}
				pointerInside = false;
				armClose();
			}

			function onPointerMove(event) {
				lastX = event.clientX;
				lastY = event.clientY;
				/* A move that lands in the viewport is itself evidence the pointer is
				   present, whatever the last leave/enter pair claimed. */
				if (pointerInViewport()) pointerLeftWindow = false;
				if (frameQueued) return;
				frameQueued = true;
				win.requestAnimationFrame(checkPointer);
			}

			/** A pointer that left the window is outside the drawer by definition. */
			/**
			 * The window reports the pointer leaving or entering. Only these events — not a
			 * guessed position — decide whether the sample is still meaningful, which is
			 * what separates a pointer that really left from one that merely stopped
			 * moving (and whose last sample still looks like it is inside the drawer).
			 */
			function onPointerLeave() {
				pointerLeftWindow = true;
				cancelDwell();
				if (!weOpened) return;
				pointerInside = false;
				armClose();
			}

			/** The pointer is back on the page: its next move supplies a fresh sample. */
			function onPointerEnter() {
				pointerLeftWindow = false;
			}

			/**
			 * A reflow moves the drawer under a pointer that never moved, so the live
			 * sample is dropped; the next move re-establishes it, and until then the
			 * pointer counts as outside.
			 */
			function onViewportChange() {
				lastX = -1;
				lastY = -1;
				cancelDwell();
				if (!weOpened) return;
				pointerInside = false;
				armClose();
			}

			const listeners = [];
			function listen(target, type, handler) {
				target.addEventListener(type, handler);
				listeners.push([target, type, handler]);
			}

			listen(doc, "pointermove", onPointerMove);
			listen(doc, "pointerleave", onPointerLeave);
			listen(doc, "pointerenter", onPointerEnter);
			listen(win, "blur", onPointerLeave);
			listen(win, "focus", onPointerEnter);
			listen(win, "resize", onViewportChange);
			listen(win, "scroll", onViewportChange);
			doc.documentElement.setAttribute(MARK, "");

			return () => {
				disposed = true;
				cancelClose();
				cancelPending();
				cancelDwell();
				for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
				listeners.length = 0;
				doc.documentElement.removeAttribute(MARK);
			};
		}

		/** Required services: the layout service that owns the sidebar toggle. */
		const inject = ["layout"];

		/**
		 * Client plugin body: mount the edge-hover drawer over the shipped sidebar.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const layout = ctx.get("layout");
			if (layout === undefined || layout === null) {
				console.error("sidebar drawer: layout service unavailable");
				return;
			}
			ctx.effect(
				() =>
					install({
						document: document,
						window: window,
						layout: layout
					}),
				"sidebar drawer: edge-hover reveal"
			);
		}

		exports.install = install;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
