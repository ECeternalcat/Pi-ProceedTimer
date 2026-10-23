/**
 * /timer — countdown timer extension for pi.
 *
 * Use case: when you hit a provider rate-limit window (e.g. a 5-hour limit),
 * start a timer and walk away. When it ends, pi sends "proceed" as a user
 * message so the agent picks the work back up.
 *
 * Usage:
 *   /timer              interactive setup:
 *                        1) pick minutes — ↓ increase / ↑ decrease, hold longer
 *                           to step faster; or type digits directly. A live
 *                           line under the value converts it to the target
 *                           local/UTC time.
 *                        2) choose the message pi sends when the timer ends:
 *                           "proceed" (default) or Custom… free text
 *                        3) confirm screen showing the duration, target time
 *                           in your timezone and UTC, and the message —
 *                           Readjust / Confirm (default)
 *   /timer <minutes>    start at the message step with the given duration
 *   /timer cancel       cancel the running timer (works in any mode)
 *
 * While a timer runs, /timer shows remaining time plus the target local/UTC
 * time with Cancel / Close, and the footer status line shows the countdown.
 *
 * After the timer fires, the footer keeps a compact result status until the
 * next timer starts, so you can still see the next morning whether it went
 * off: "✅ Timer done 07:30 · proceed dispatched". The setup screen shows
 * the full record:
 *
 *   Last timer
 *     Triggered  2026-10-23 07:30 (GMT-8)
 *     Action     proceed
 *     Status     dispatched
 *
 * Status distinguishes "dispatched" (sendUserMessage() returned without
 * throwing) from "agent resumed" (an agent run was observed afterwards) —
 * a queued message does not guarantee the model actually resumed work.
 * Kept in memory only; it disappears when the session/runtime is replaced.
 *
 * The timer lives in the current session's extension runtime: switching or
 * reloading the session clears it (see session_shutdown below).
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Cross-install sentinel (process-global via Symbol.for): keeps /timer
 * single-registered when two copies of this extension are loaded at once. */
const TIMER_SENTINEL = Symbol.for("pi-proceed-timer/registered");

const PROCEED_PROMPT = "proceed";
const MIN_MINUTES = 1;
const MAX_MINUTES = 1440; // 24 h
const DEFAULT_MINUTES = 30;
const MAX_TYPED_DIGITS = 4;
const MAX_PROMPT_LEN = 200; // hard cap for a custom message
const STATUS_KEY = "timer";
const REPEAT_MS = 120; // inter-press gap counted as terminal key auto-repeat
// (typically 30–60 ms). Slower presses — even fast deliberate tapping —
// never accelerate, so tapping always moves one minute at a time.

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** "2026-02-05 13:30" in the given (or local) timezone. */
function fmtClock(d: Date, timeZone?: string): string {
	const s = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(d);
	return s.replace(/,\s*/, " ").replace(/\u202f/g, " ").replace("24:", "00:");
}

/** Short timezone name for the user's locale, e.g. "GMT+8". */
function zoneName(d: Date): string {
	try {
		const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
			.formatToParts(d)
			.find((p) => p.type === "timeZoneName");
		return part?.value ?? "";
	} catch {
		return "";
	}
}

function formatLocal(d: Date): string {
	const tz = zoneName(d);
	return tz ? `${fmtClock(d)} (${tz})` : fmtClock(d);
}

function formatUTC(d: Date): string {
	return `${fmtClock(d, "UTC")} UTC`;
}

/** "HH:MM" (in the given or local timezone) for compact status text. */
function fmtHM(d: Date, timeZone?: string): string {
	return new Intl.DateTimeFormat(undefined, { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
		.format(d)
		.replace(/\u202f/g, " ")
		.replace("24:", "00:");
}

/** "HH:MM", with a weekday prefix when the target is not today in that zone. */
function fmtTarget(d: Date, timeZone?: string): string {
	const hm = fmtHM(d, timeZone);
	const dayFmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	if (dayFmt.format(d) === dayFmt.format(new Date())) return hm;
	const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(d);
	return `${weekday} ${hm}`;
}

/** ms → "m:ss" or "h:mm:ss" */
function formatDuration(ms: number): string {
	const t = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** minutes → "45 min" / "1 h 05 min" */
function humanMinutes(min: number): string {
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m === 0 ? `${h} h` : `${h} h ${pad2(m)} min`;
}

function clampMinutes(v: number): number {
	if (!Number.isFinite(v)) return DEFAULT_MINUTES;
	return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(v)));
}

/** Clip long text for compact one-line display. */
function shorten(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Word-wrap `text` into at most `maxLines` lines of `width` columns. */
function wrapCompact(text: string, width: number, maxLines: number): string[] {
	if (width < 4) return [shorten(text, 3)];
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		if (cur && `${cur} ${word}`.length <= width) {
			cur += ` ${word}`;
			continue;
		}
		if (cur) lines.push(cur);
		// hard-split a single word longer than the line
		let rest = word;
		while (rest.length > width) {
			lines.push(rest.slice(0, width));
			rest = rest.slice(width);
		}
		cur = rest;
	}
	if (cur) lines.push(cur);
	if (lines.length > maxLines) {
		const head = lines.slice(0, maxLines - 1);
		const tail = shorten(lines.slice(maxLines - 1).join(" "), width);
		return [...head, tail];
	}
	return lines;
}

/**
 * Acceleration: the longer the key is held (auto-repeat), the bigger the step.
 * With a typical ~30 repeats/s terminal, the 5-min tier starts after ~0.3 s
 * of holding, 10-min after ~0.7 s, and 30-min after ~1.4 s.
 */
function stepFor(run: number): number {
	if (run <= 8) return 1;
	if (run <= 20) return 5;
	if (run <= 40) return 10;
	return 30;
}

// ---------------------------------------------------------------------------
// Custom screen (adjust → confirm, or running-timer view)
// ---------------------------------------------------------------------------

type TimerUIResult =
	| { type: "started"; minutes: number; prompt: string }
	| { type: "cancelled" }
	| { type: "closed" }
	| { type: "expired" };

class TimerScreen {
	private phase: "adjust" | "prompt" | "input" | "confirm" | "view";
	private minutes: number;
	private typed = "";
	private promptChoice: 0 | 1 = 0; // message step: 0 = proceed, 1 = Custom…
	private prompt = PROCEED_PROMPT;
	private choice: 0 | 1 = 1; // index of the highlighted button
	private run = 0; // consecutive same-direction key presses
	private lastDir = 0;
	private lastTime = 0;
	private finished = false;
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private readonly tickId: ReturnType<typeof setInterval>;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly done: (result: TimerUIResult | undefined) => void;
	private readonly onStart: (minutes: number, prompt: string) => void;
	private readonly onCancel: () => void;
	private readonly editor: Editor;

	constructor(
		tui: TUI,
		theme: Theme,
		kb: KeybindingsManager,
		done: (result: TimerUIResult | undefined) => void,
		onStart: (minutes: number, prompt: string) => void,
		onCancel: () => void,
		initial: { minutes?: number; phase?: "adjust" | "prompt" | "view" },
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = kb;
		this.done = done;
		this.onStart = onStart;
		this.onCancel = onCancel;
		this.minutes = clampMinutes(initial.minutes ?? DEFAULT_MINUTES);
		this.phase = initial.phase ?? "adjust";
		this.tickId = setInterval(() => this.tick(), 1000);

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (s) => theme.fg("accent", s),
				selectedText: (s) => theme.fg("accent", s),
				description: (s) => theme.fg("muted", s),
				scrollInfo: (s) => theme.fg("dim", s),
				noMatch: (s) => theme.fg("warning", s),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (value: string) => {
			if (this.finished) return;
			const v = value.trim().slice(0, MAX_PROMPT_LEN);
			if (!v) return; // empty message: stay in input
			this.prompt = v;
			this.phase = "confirm";
			this.choice = 1; // Confirm is the default
			this.refresh();
		};
	}

	// -- lifecycle helpers ---------------------------------------------------

	private tick(): void {
		if (this.finished || (this.phase !== "view" && this.phase !== "adjust")) return;
		if (this.phase === "view") {
			const left = timer ? timer.endsAt - Date.now() : 0;
			if (left <= 0) {
				this.finish({ type: "expired" });
				return;
			}
		}
		// Keep the adjust screen's live "→ target time" line fresh even when
		// no key is pressed; the view screen counts down every second.
		this.invalidate();
		this.tui.requestRender();
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private finish(result: TimerUIResult | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.done(result);
	}

	private toggle(): void {
		this.choice = this.choice === 0 ? 1 : 0;
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.tickId);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	// -- input ---------------------------------------------------------------

	handleInput(data: string): void {
		if (this.finished) return;
		if (this.phase === "adjust") this.handleAdjust(data);
		else if (this.phase === "prompt") this.handlePromptChoice(data);
		else if (this.phase === "input") this.handlePromptInput(data);
		else this.handleTwoChoice(data, this.phase === "confirm" ? "confirm" : "view");
	}

	private handleAdjust(data: string): void {
		// Direct digit entry.
		if (data.length === 1 && data >= "0" && data <= "9") {
			if (this.typed.length < MAX_TYPED_DIGITS) {
				this.typed += data;
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.typed) {
				this.typed = this.typed.slice(0, -1);
				this.refresh();
			}
			return;
		}

		// Arrow keys: ↓ increases, ↑ decreases; holding accelerates.
		const up = this.kb.matches(data, "tui.select.up");
		const down = this.kb.matches(data, "tui.select.down");
		if (up || down) {
			if (this.typed) {
				this.minutes = clampMinutes(parseInt(this.typed, 10));
				this.typed = "";
			}
			const dir = down ? 1 : -1;
			const now = Date.now();
			// Accelerate only on true terminal auto-repeat (bursts ≤ REPEAT_MS
			// apart). Deliberate presses — however fast — reset the ramp.
			if (dir !== this.lastDir || now - this.lastTime > REPEAT_MS) this.run = 0;
			else this.run += 1;
			this.lastDir = dir;
			this.lastTime = now;
			this.minutes = clampMinutes(this.minutes + dir * stepFor(this.run));
			this.refresh();
			return;
		}

		if (this.kb.matches(data, "tui.select.confirm")) {
			if (this.typed) {
				this.minutes = clampMinutes(parseInt(this.typed, 10));
				this.typed = "";
			}
			this.run = 0;
			this.phase = "prompt";
			this.refresh();
			return;
		}

		if (this.kb.matches(data, "tui.select.cancel")) {
			this.finish(undefined);
		}
	}

	private handlePromptChoice(data: string): void {
		const nav =
			this.kb.matches(data, "tui.select.up") ||
			this.kb.matches(data, "tui.select.down") ||
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.tab) ||
			matchesKey(data, Key.shift("tab"));
		if (nav) {
			this.promptChoice = this.promptChoice === 0 ? 1 : 0;
			this.refresh();
			return;
		}
		if (this.kb.matches(data, "tui.select.confirm")) {
			if (this.promptChoice === 0) {
				this.prompt = PROCEED_PROMPT;
				this.phase = "confirm";
				this.choice = 1; // Confirm is the default
				this.refresh();
			} else {
				// Keep the previous custom message around for quick edits.
				this.editor.setText(this.prompt === PROCEED_PROMPT ? "" : this.prompt);
				this.phase = "input";
				this.refresh();
			}
			return;
		}
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.phase = "adjust"; // back to the minutes step
			this.refresh();
		}
	}

	private handlePromptInput(data: string): void {
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.phase = "prompt"; // back to the message choice
			this.refresh();
			return;
		}
		// The Editor handles text, backspace, paste, and Enter (→ onSubmit).
		this.editor.handleInput(data);
		this.refresh();
	}

	private handleTwoChoice(data: string, phase: "confirm" | "view"): void {
		if (
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.tab) ||
			matchesKey(data, Key.shift("tab"))
		) {
			this.toggle();
			return;
		}
		if (this.kb.matches(data, "tui.select.confirm")) {
			if (phase === "confirm") {
				if (this.choice === 1) {
					this.onStart(this.minutes, this.prompt);
					this.finish({ type: "started", minutes: this.minutes, prompt: this.prompt });
				} else {
					this.phase = "adjust"; // Readjust
					this.choice = 1;
					this.refresh();
				}
			} else {
				if (this.choice === 0) {
					this.onCancel();
					this.finish({ type: "cancelled" });
				} else {
					this.finish({ type: "closed" });
				}
			}
			return;
		}
		if (this.kb.matches(data, "tui.select.cancel")) {
			this.finish(phase === "confirm" ? undefined : { type: "closed" });
		}
	}

	// -- rendering -----------------------------------------------------------

	private renderButtons(a: string, b: string): string {
		const t = this.theme;
		const mk = (label: string, idx: 0 | 1) =>
			idx === this.choice
				? t.bg("selectedBg", t.fg("text", ` ❯ ${label} `))
				: t.fg("muted", `   ${label} `);
		return ` ${mk(a, 0)}  ${mk(b, 1)}`;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const w = Math.max(1, width);
		const t = this.theme;
		const rule = t.fg("accent", "─".repeat(w));
		const kv = (label: string, value: string) =>
			` ${t.fg("muted", label.padEnd(11))}${t.fg("text", value)}`;
		const lines: string[] = [rule, ""];

		if (this.phase === "adjust") {
			if (lastFire) {
				const sub = (label: string, value: string) =>
					`   ${t.fg("muted", label.padEnd(10))}${t.fg("text", value)}`;
				lines.push(` ${t.fg("muted", "Last timer")}`);
				lines.push(sub("Triggered", formatLocal(new Date(lastFire.triggeredAt))));
				lines.push(sub("Action", lastFire.action));
				lines.push(sub("Status", lastFireStatusLine()));
				lines.push("");
			}
			const value = this.typed || String(this.minutes);
			const cursor = this.typed ? "▏" : "";
			const big = t.bold(t.fg("accent", `${value}${cursor} min`));
			const pad = " ".repeat(Math.max(0, Math.floor((w - visibleWidth(big)) / 2)));

			lines.push(` ${t.fg("text", "How many minutes should pi wait?")}`);
			lines.push("");

			// Live conversion: what the current value means in wall-clock time.
			const pending = this.typed ? clampMinutes(parseInt(this.typed, 10)) : this.minutes;
			const target = new Date(Date.now() + pending * 60_000);
			const zone = zoneName(target);
			const sub = t.fg(
				"muted",
				`in ${humanMinutes(pending)} → ${fmtTarget(target)}${zone ? ` (${zone})` : ""} · ${fmtTarget(target, "UTC")} UTC`,
			);
			const subPad = " ".repeat(Math.max(0, Math.floor((w - visibleWidth(sub)) / 2)));

			lines.push(pad + big);
			lines.push(subPad + sub);
			lines.push("");
			lines.push(` ${t.fg("dim", `↓ +1 · ↑ −1 · hold to accelerate (now ${stepFor(this.run)} min/press)`)}`);
			lines.push(` ${t.fg("dim", "type digits to enter directly · backspace edits")}`);
			lines.push("");
			lines.push(` ${t.fg("dim", "Enter continue · Esc cancel")}`);
		} else if (this.phase === "prompt") {
			lines.push(` ${t.fg("text", "Message to send when the timer ends")}`);
			lines.push("");
			const mk = (label: string, idx: 0 | 1) =>
				idx === this.promptChoice
					? t.bg("selectedBg", t.fg("text", ` ❯ ${label} `))
					: t.fg("muted", `   ${label} `);
			lines.push(` ${mk("proceed", 0)}`);
			const customLabel =
				this.prompt === PROCEED_PROMPT
					? "Custom…"
					: `Custom…  ${t.fg("dim", shorten(this.prompt, 40))}`;
			lines.push(` ${mk(customLabel, 1)}`);
			lines.push("");
			lines.push(` ${t.fg("dim", "↑/↓ or ←/→ choose · Enter select · Esc back")}`);
		} else if (this.phase === "input") {
			lines.push(` ${t.fg("text", "Custom message")}`);
			lines.push("");
			lines.push(` ${t.fg("muted", "The exact user message pi will send when the timer ends:")}`);
			lines.push("");
			for (const line of this.editor.render(Math.max(1, w - 2))) {
				lines.push(` ${line}`);
			}
			lines.push("");
			lines.push(` ${t.fg("dim", "Enter confirm · Esc back")}`);
		} else if (this.phase === "confirm") {
			const endsAt = new Date(Date.now() + this.minutes * 60_000);
			lines.push(` ${t.fg("text", "Start the timer?")}`);
			lines.push("");
			lines.push(` ${t.fg("text", "Wait for ")}${t.bold(t.fg("accent", humanMinutes(this.minutes)))}`);
			lines.push("");
			lines.push(kv("Your time", formatLocal(endsAt)));
			lines.push(kv("UTC", formatUTC(endsAt)));
			const msgLines = wrapCompact(this.prompt, Math.max(4, w - 13), 3);
			msgLines.forEach((mLine, i) => {
				const label = i === 0 ? "Message".padEnd(11) : "".padEnd(11);
				lines.push(` ${t.fg("muted", label)}${t.fg("text", mLine)}`);
			});
			lines.push("");
			lines.push(this.renderButtons("Readjust", "Confirm"));
			lines.push("");
			lines.push(` ${t.fg("dim", "←/→ choose · Enter start · Esc cancel")}`);
		} else {
			const st = timer;
			if (st) {
				const left = formatDuration(st.endsAt - Date.now());
				const endsAt = new Date(st.endsAt);
				lines.push(` ${t.fg("text", "Timer running")}`);
				lines.push("");
				lines.push(kv("Remaining", t.bold(t.fg("accent", left))));
				lines.push(kv("Your time", formatLocal(endsAt)));
				lines.push(kv("UTC", formatUTC(endsAt)));
				lines.push("");
				lines.push(` ${t.fg("muted", `pi sends "${shorten(st.prompt, 40)}" when it ends.`)}`);
				lines.push("");
				lines.push(this.renderButtons("Cancel", "Close"));
				lines.push("");
				lines.push(` ${t.fg("dim", "←/→ choose · Enter select · Esc close")}`);
			}
		}

		lines.push(rule);

		this.cachedWidth = w;
		this.cachedLines = lines.map((l) => truncateToWidth(l, w));
		return this.cachedLines;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface TimerState {
	endsAt: number;
	totalMs: number;
	prompt: string;
	timeoutId: ReturnType<typeof setTimeout>;
	tickId: ReturnType<typeof setInterval>;
}

/** In-memory record of the most recent timer fire (not persisted). */
interface LastFireRecord {
	triggeredAt: number;
	action: string;
	status: "dispatched" | "agent resumed" | "failed";
	/** Set when an agent run is observed after dispatch. */
	resumedAt?: number;
	/** Send failure description, when status is "failed". */
	error?: string;
}

let timer: TimerState | undefined;
let uiRef: ExtensionCommandContext["ui"] | undefined;
let ctxRef: ExtensionCommandContext | undefined; // valid while the timer lives (cleared on shutdown)
let lastFire: LastFireRecord | undefined;

/** Detailed status value for the /timer screen, e.g. "agent resumed 07:31". */
function lastFireStatusLine(): string {
	if (!lastFire) return "";
	if (lastFire.status === "failed") return `failed — ${lastFire.error ?? "unknown error"}`;
	if (lastFire.status === "agent resumed") {
		return `agent resumed ${fmtHM(new Date(lastFire.resumedAt ?? lastFire.triggeredAt))}`;
	}
	return "dispatched (agent not yet observed)";
}

/** Compact status-bar text for the last fire. */
function lastFireStatusText(): string {
	if (!lastFire) return "";
	const time = fmtHM(new Date(lastFire.triggeredAt));
	if (lastFire.status === "failed") return `✖ Timer done ${time} · ${shorten(lastFire.action, 24)} failed`;
	if (lastFire.status === "agent resumed") return `✅ Timer done ${time} · agent resumed`;
	return `✅ Timer done ${time} · ${shorten(lastFire.action, 24)} dispatched`;
}

function statusText(text: string | undefined): void {
	if (!uiRef) return;
	try {
		uiRef.setStatus(STATUS_KEY, text);
	} catch {
		// UI may be unavailable in some modes.
	}
}

function startTimer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	minutes: number,
	prompt: string = PROCEED_PROMPT,
): void {
	cancelTimer();
	uiRef = ctx.ui;
	ctxRef = ctx;
	const totalMs = minutes * 60_000;
	const endsAt = Date.now() + totalMs;
	const timeoutId = setTimeout(() => fireTimer(pi), Math.max(0, totalMs));
	const tickId = setInterval(() => {
		if (!timer) return;
		statusText(`⏳ ${formatDuration(timer.endsAt - Date.now())}`);
	}, 1000);
	timer = { endsAt, totalMs, prompt, timeoutId, tickId };
	statusText(`⏳ ${formatDuration(totalMs)}`);
}

function cancelTimer(): boolean {
	const st = timer;
	if (!st) return false;
	timer = undefined;
	clearTimeout(st.timeoutId);
	clearInterval(st.tickId);
	ctxRef = undefined;
	// No fire happened. Keep the last-fire record; restore its status text so
	// the footer still reports the previous fire (clear fully if there never
	// was one).
	statusText(lastFire ? lastFireStatusText() : undefined);
	return true;
}

function fireTimer(pi: ExtensionAPI): void {
	const st = timer;
	if (!st) return;
	timer = undefined;
	clearTimeout(st.timeoutId);
	clearInterval(st.tickId);
	const ctx = ctxRef;
	ctxRef = undefined;

	// Record the fire before dispatching: the agent_start event triggered by
	// the send upgrades the record from "dispatched" to "agent resumed".
	lastFire = { triggeredAt: Date.now(), action: st.prompt, status: "dispatched" };

	if (uiRef) {
		try {
			uiRef.notify(`⏰ Timer finished — sending "${shorten(st.prompt, 60)}"`, "info");
		} catch {
			// ignore
		}
	}
	try {
		const idle = ctx ? ctx.isIdle() : true;
		if (idle) {
			pi.sendUserMessage(st.prompt);
		} else {
			pi.sendUserMessage(st.prompt, { deliverAs: "followUp" });
		}
		// Keep the result in the footer until the next timer starts.
		statusText(lastFireStatusText());
	} catch (err) {
		lastFire.status = "failed";
		lastFire.error = err instanceof Error ? err.message : String(err);
		statusText(lastFireStatusText());
		if (uiRef) {
			try {
				uiRef.notify(`Timer finished, but sending the message failed: ${lastFire.error}`, "error");
			} catch {
				// ignore
			}
		}
	}
}

async function runTimerUI(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initial: { minutes?: number; phase?: "adjust" | "prompt" | "view" },
): Promise<void> {
	const result = await ctx.ui.custom<TimerUIResult | undefined>((tui, theme, kb, done) => {
		return new TimerScreen(
			tui,
			theme,
			kb,
			done,
			(minutes, prompt) => startTimer(pi, ctx, minutes, prompt),
			() => cancelTimer(),
			initial,
		);
	});

	if (!result) return;
	if (result.type === "started") {
		ctx.ui.notify(
			`Timer started — pi sends "${shorten(result.prompt, 60)}" in ${humanMinutes(result.minutes)}`,
			"info",
		);
	} else if (result.type === "cancelled") {
		ctx.ui.notify("Timer cancelled", "info");
	}
}

export default function (pi: ExtensionAPI) {
	// The same extension can be installed through two channels at once — a
	// local checkout and the npm package are distinct packages to pi, and each
	// copy would register its own /timer. Keep it single-registered: the first
	// copy to load wins, later copies stay dormant. The winning runtime's
	// session_shutdown releases the slot so a reload re-registers cleanly.
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (g[TIMER_SENTINEL]) return;
	g[TIMER_SENTINEL] = true;

	// A run observed after dispatch means the agent actually resumed (a
	// queued message alone does not guarantee that).
	pi.on("agent_start", () => {
		if (!lastFire || lastFire.status !== "dispatched") return;
		lastFire.status = "agent resumed";
		lastFire.resumedAt = Date.now();
		// Do not fight an active countdown for footer space.
		if (!timer) statusText(lastFireStatusText());
	});

	pi.on("session_shutdown", () => {
		cancelTimer();
		lastFire = undefined;
		statusText(undefined);
		uiRef = undefined;
		delete g[TIMER_SENTINEL];
	});

	pi.registerCommand("timer", {
		description: `Countdown timer — sends "${PROCEED_PROMPT}" (or a custom message) when it ends`,
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "cancel", label: "cancel", description: "cancel the running timer" },
				{ value: "5", label: "5", description: "wait 5 minutes" },
				{ value: "15", label: "15", description: "wait 15 minutes" },
				{ value: "30", label: "30", description: "wait 30 minutes" },
				{ value: "60", label: "60", description: "wait 1 hour" },
				{ value: "300", label: "300", description: "wait 5 hours" },
			];
			const p = prefix.trim();
			const hits = p ? items.filter((i) => i.value.startsWith(p)) : items;
			return hits.length > 0 ? hits : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			// /timer cancel — works in every mode.
			if (trimmed === "cancel") {
				if (cancelTimer()) ctx.ui.notify("Timer cancelled", "info");
				else ctx.ui.notify("No timer running", "warning");
				return;
			}

			// /timer <minutes> — start at the message step with the given duration
			// (or start directly with the default message when there is no UI).
			if (/^\d{1,4}$/.test(trimmed)) {
				const minutes = parseInt(trimmed, 10);
				if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
					ctx.ui.notify(`Minutes must be between ${MIN_MINUTES} and ${MAX_MINUTES}`, "warning");
					return;
				}
				if (ctx.mode !== "tui") {
					startTimer(pi, ctx, minutes);
					ctx.ui.notify(`Timer started — pi sends "${PROCEED_PROMPT}" in ${humanMinutes(minutes)}`, "info");
					return;
				}
				await runTimerUI(pi, ctx, { minutes, phase: "prompt" });
				return;
			}

			if (trimmed) {
				ctx.ui.notify("Usage: /timer [minutes | cancel]", "warning");
				return;
			}

			// Bare /timer.
			if (ctx.mode !== "tui") {
				if (timer) {
					const endsAt = new Date(timer.endsAt);
					ctx.ui.notify(
						`Timer running — ${formatDuration(timer.endsAt - Date.now())} remaining · ends ${formatLocal(endsAt)} · ${formatUTC(endsAt)}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						"Interactive timer setup needs the TUI. Use /timer <minutes> or /timer cancel.",
						"warning",
					);
				}
				return;
			}

			await runTimerUI(pi, ctx, timer ? { phase: "view" } : {});
		},
	});
}
