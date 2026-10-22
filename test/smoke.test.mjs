/**
 * Headless smoke test for the /timer extension.
 *
 * Runs the extension outside pi with fake tui/theme/keybindings objects and
 * drives the full UI flow; the fire-timer path uses node:test mock timers.
 * Requires Node >= 22.18 (native TypeScript type stripping).
 */
import assert from "node:assert";
import { mock } from "node:test";

// --- fakes -----------------------------------------------------------------

const notifications = [];
const sentMessages = [];
const statuses = [];

function makeCtx(mode = "tui") {
	return {
		mode,
		hasUI: true,
		ui: {
			notify: (m, t) => notifications.push({ m, t }),
			setStatus: (k, v) => statuses.push([k, v]),
			custom: undefined, // filled below
		},
		isIdle: () => true,
	};
}

const fakeTheme = {
	fg: (_tok, s) => s,
	bg: (_tok, s) => s,
	bold: (s) => s,
	colors: {},
};

const ACTION_KEYS = {
	"tui.select.up": ["\x1b[A"],
	"tui.select.down": ["\x1b[B"],
	"tui.select.confirm": ["\r", "\n"],
	"tui.select.cancel": ["\x1b"],
};
const fakeKb = { matches: (data, action) => (ACTION_KEYS[action] ?? []).includes(data) };
const fakeTui = { requestRender: () => {} };

// --- load extension ----------------------------------------------------------

const mod = await import("../extensions/timer.ts");
assert.strictEqual(typeof mod.default, "function");

const registrations = { commands: {}, events: {} };
let sendImpl = (content, opts) => sentMessages.push({ content, opts });
const fakePi = {
	registerCommand: (name, opts) => (registrations.commands[name] = opts),
	on: (event, handler) => (registrations.events[event] = handler),
	sendUserMessage: (content, opts) => sendImpl(content, opts),
};
mod.default(fakePi);

assert.ok(registrations.commands.timer, "timer command registered");
assert.ok(registrations.events.session_shutdown, "session_shutdown handler registered");
assert.ok(registrations.events.agent_start, "agent_start handler registered");
console.log("✓ extension loads, /timer + agent_start registered");

const lastStatus = () => [...statuses].reverse().find(([k]) => k === "timer")?.[1];

// --- TUI flow ----------------------------------------------------------------
// NOTE: never await the handler for UI paths — the fake custom() promise only
// resolves via done(), which we drive manually.

const ctx = makeCtx("tui");
let screen; // component under test
let uiResult;

ctx.ui.custom = (factory) => {
	screen = factory(fakeTui, fakeTheme, fakeKb, (r) => (uiResult = r));
	return new Promise(() => {}); // resolves only via done() in real pi
};

const openUI = (args) => {
	registrations.commands.timer.handler(args, ctx); // intentionally not awaited
	assert.ok(screen, "screen created");
};
const press = (key) => screen.handleInput(key);
const render = () => screen.render(72).join("\n");
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// 1. bare /timer opens adjust screen at default 30 min (no last-fire block yet)
openUI("");
assert.match(stripAnsi(render()), /How many minutes should pi wait\?/);
assert.match(stripAnsi(render()), /30 min/);
assert.match(
	stripAnsi(render()),
	/in 30 min → (Mon |Tue |Wed |Thu |Fri |Sat |Sun )?\d\d:\d\d \(GMT[^)]*\) · (Mon |Tue |Wed |Thu |Fri |Sat |Sun )?\d\d:\d\d UTC/,
	"live conversion line",
);
assert.ok(!stripAnsi(render()).includes("Last timer"), "no last-fire block before any fire");
console.log("✓ adjust screen renders, default 30 min + live target-time conversion");

// 2. hold ↓ x12 with acceleration: run 0..11 → 9×1 + 3×5 = 24 → 54
for (let i = 0; i < 12; i++) press("\x1b[B");
assert.match(stripAnsi(render()), /54 min/);
assert.match(stripAnsi(render()), /in 54 min →/, "conversion follows adjustments");
console.log("✓ hold ↓ accelerates gently (30 → 54 after 12 auto-repeat presses), conversion follows");

// 2b. deeper hold reaches the higher tiers: runs 12..44 → 9×5 + 20×10 + 4×30 = 365 → 419
for (let i = 0; i < 33; i++) press("\x1b[B");
assert.match(stripAnsi(render()), /419 min/);
assert.match(stripAnsi(render()), /now 30 min\/press/, "top tier reached on deep hold");
console.log("✓ deep hold reaches 10- and 30-min tiers (54 → 419 after 33 more repeats)");

// 3. deliberate tapping (≥150 ms apart) NEVER accelerates — 1 min per press
for (let i = 0; i < 10; i++) {
	await new Promise((r) => setTimeout(r, 150));
	press("\x1b[B");
}
assert.match(stripAnsi(render()), /429 min/);
assert.match(stripAnsi(render()), /hold to accelerate \(now 1 min\/press\)/, "ramp resets to 1 after release");
console.log("✓ fast deliberate tapping stays at 1 min/press (419 → 429 after 10 taps)");

// 3b. pause also resets
await new Promise((r) => setTimeout(r, 500));
press("\x1b[B"); // fresh press → step 1
assert.match(stripAnsi(render()), /430 min/);
press("\x1b[A"); // up decreases, fresh press → step 1
assert.match(stripAnsi(render()), /429 min/);
console.log("✓ acceleration resets on pause; ↑ decreases");

// 4. direct digit entry
for (const d of "120") press(d);
assert.match(stripAnsi(render()), /120▏ min/);
assert.match(stripAnsi(render()), /in 2 h →/, "conversion follows typed digits");
press("\x7f"); // backspace
assert.match(stripAnsi(render()), /12▏ min/);
assert.match(stripAnsi(render()), /in 12 min →/);
press("0");
console.log("✓ digit entry + backspace work, conversion tracks the typed value");

// 5. Enter → confirm screen with local + UTC times, Confirm preselected
press("\r");
const confirmText = stripAnsi(render());
assert.match(confirmText, /Start the timer\?/);
assert.match(confirmText, /Wait for 2 h\b/);
assert.match(confirmText, /Your time\s+20\d\d-\d\d-\d\d \d\d:\d\d \(GMT[^)]*\)/);
assert.match(confirmText, /UTC\s+20\d\d-\d\d-\d\d \d\d:\d\d UTC/);
assert.match(confirmText, /❯ Confirm/); // Confirm highlighted by default
assert.ok(confirmText.indexOf("Confirm") > confirmText.indexOf("Readjust")); // order
console.log("✓ confirm screen shows local + UTC target time, Confirm preselected");

// 6. Readjust goes back to adjust with the value kept
press("\x1b[D"); // left → Readjust
press("\r");
assert.match(stripAnsi(render()), /120 min/);
console.log("✓ Readjust returns to adjust screen keeping 120");

// 7. Enter → confirm → Enter starts the timer
press("\r"); // adjust → confirm
press("\r"); // confirm → start
assert.deepStrictEqual(uiResult, { type: "started", minutes: 120 });
assert.ok(/^⏳ 2:00:0/.test(lastStatus()), "status line set");
console.log("✓ Enter starts timer (120 min), status line shows countdown");

// 8. /timer again → view screen with remaining + both times, Close preselected
uiResult = "sentinel";
openUI(""); // fresh screen, phase view
const viewText = stripAnsi(render());
assert.match(viewText, /Timer running/);
assert.match(viewText, /Remaining\s+2:00:0\d/);
assert.match(viewText, /Your time\s+20\d\d-\d\d-\d\d \d\d:\d\d/);
assert.match(viewText, /UTC\s+20\d\d-\d\d-\d\d \d\d:\d\d UTC/);
assert.match(viewText, /❯ Close/); // Close preselected
console.log("✓ /timer while running shows remaining + target times, Close preselected");

// 9. left → Cancel selected; Enter cancels
press("\x1b[D"); // left → Cancel
press("\r");
assert.deepStrictEqual(uiResult, { type: "cancelled" });
assert.strictEqual(lastStatus(), undefined, "status cleared (no fire ever happened)");
console.log("✓ Cancel cancels the timer and clears the status line");

// 10. /timer cancel when nothing runs → warning
notifications.length = 0;
await registrations.commands.timer.handler("cancel", ctx);
assert.ok(notifications.some((n) => n.t === "warning" && /No timer running/.test(n.m)));
console.log("✓ /timer cancel with no timer warns");

// 11. Esc on adjust screen exits silently
uiResult = "sentinel";
openUI("");
press("\x1b");
assert.strictEqual(uiResult, undefined);
console.log("✓ Esc exits the adjust screen");

// 12. /timer 5 → straight to confirm screen
uiResult = undefined;
openUI("5");
assert.match(stripAnsi(render()), /Start the timer\?/);
assert.match(stripAnsi(render()), /5 min/);
press("\r");
assert.deepStrictEqual(uiResult, { type: "started", minutes: 5 });
screen.dispose();
console.log("✓ /timer 5 skips straight to confirm and starts");

// --- fire path with mock timers ----------------------------------------------

// 13. fire while idle → proceed sent, result STAYS in the status bar
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
notifications.length = 0;
sentMessages.length = 0;
statuses.length = 0;
const rpcCtx = makeCtx("rpc");
await registrations.commands.timer.handler("1", rpcCtx);
mock.timers.tick(61 * 60 * 1000);
assert.ok(sentMessages.some((s) => s.content === "proceed"), "proceed sent");
assert.ok(notifications.some((n) => /Timer finished/.test(n.m)));
assert.match(lastStatus(), /✅ Timer done \d\d:\d\d · proceed dispatched/, "result kept in footer");
console.log('✓ timer fires, sends "proceed", footer keeps "✅ Timer done · dispatched"');

// 14. agent_start upgrades dispatched → agent resumed
registrations.events.agent_start();
assert.match(lastStatus(), /✅ Timer done \d\d:\d\d · agent resumed/);
// further agent_starts do not downgrade / rewrite anything
statuses.length = 0;
registrations.events.agent_start();
assert.strictEqual(lastStatus(), undefined, "no repeated status writes");
console.log("✓ agent_start upgrades record to \"agent resumed\" (once)");

// 15. adjust screen shows the last-fire block
openUI("");
const lastBlock = stripAnsi(render());
assert.match(lastBlock, /Last timer/);
assert.match(lastBlock, /Triggered\s+20\d\d-\d\d-\d\d \d\d:\d\d \(GMT[^)]*\)/);
assert.match(lastBlock, /Action\s+proceed/);
assert.match(lastBlock, /Status\s+agent resumed \d\d:\d\d/);
console.log("✓ /timer setup screen shows the Last timer record");

// 16. new countdown takes footer priority; cancel restores the record
mock.timers.reset();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
await registrations.commands.timer.handler("2", rpcCtx);
assert.strictEqual(lastStatus(), "⏳ 2:00", "countdown replaces record in footer");
registrations.events.agent_start(); // no rewrite while a countdown is active
assert.strictEqual(lastStatus(), "⏳ 2:00", "countdown keeps priority");
await registrations.commands.timer.handler("cancel", rpcCtx);
assert.match(lastStatus(), /✅ Timer done \d\d:\d\d · agent resumed/, "cancel restores record");
console.log("✓ active countdown outranks the record; cancel restores it");

// 17. busy agent at fire time → followUp delivery, then resumed on next run
mock.timers.reset();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
sentMessages.length = 0;
statuses.length = 0;
const busyCtx = makeCtx("rpc");
busyCtx.isIdle = () => false;
await registrations.commands.timer.handler("1", busyCtx);
mock.timers.tick(61 * 60 * 1000);
assert.ok(sentMessages.some((s) => s.content === "proceed" && s.opts?.deliverAs === "followUp"));
assert.match(lastStatus(), /proceed dispatched/, "queued message is only dispatched");
registrations.events.agent_start();
assert.match(lastStatus(), /agent resumed/);
console.log("✓ busy agent → followUp queued (dispatched), agent_start → resumed");

// 18. send failure → failed status + error notify + record
mock.timers.reset();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
sendImpl = () => {
	throw new Error("boom");
};
notifications.length = 0;
statuses.length = 0;
await registrations.commands.timer.handler("1", rpcCtx);
mock.timers.tick(61 * 60 * 1000);
assert.ok(notifications.some((n) => n.t === "error" && /failed: boom/.test(n.m)));
assert.match(lastStatus(), /✖ Timer done \d\d:\d\d · proceed failed/);
sendImpl = (content, opts) => sentMessages.push({ content, opts });
openUI("");
assert.match(stripAnsi(render()), /Status\s+failed — boom/);
console.log("✓ send failure recorded as failed with the error");

// 19. shutdown clears timer + record
mock.timers.reset();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
sentMessages.length = 0;
statuses.length = 0;
await registrations.commands.timer.handler("1", rpcCtx);
registrations.events.session_shutdown();
mock.timers.tick(61 * 60 * 1000);
assert.strictEqual(sentMessages.length, 0, "no proceed after shutdown");
assert.strictEqual(lastStatus(), undefined, "footer cleared");
openUI("");
assert.ok(!stripAnsi(render()).includes("Last timer"), "record gone after shutdown");
console.log("✓ session_shutdown clears timer, record, and footer");

// 20. bare /timer in non-tui mode reports remaining or usage
mock.timers.reset();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
await registrations.commands.timer.handler("1", rpcCtx);
notifications.length = 0;
await registrations.commands.timer.handler("", rpcCtx);
assert.ok(notifications.some((n) => /Timer running — \d+:\d\d remaining/.test(n.m)));
console.log("✓ bare /timer in RPC mode reports remaining time");

// 21. bad args
notifications.length = 0;
await registrations.commands.timer.handler("abc", ctx);
assert.ok(notifications.some((n) => /Usage/.test(n.m)));
notifications.length = 0;
await registrations.commands.timer.handler("2000", ctx);
assert.ok(notifications.some((n) => /between 1 and 1440/.test(n.m)));
console.log("✓ invalid arguments rejected");

// completions
const completions = registrations.commands.timer.getArgumentCompletions("c");
assert.deepStrictEqual(completions, [{ value: "cancel", label: "cancel", description: "cancel the running timer" }]);
console.log("✓ argument completions work");

// 22. duplicate-load guard: with two copies installed (e.g. local path + npm),
// only the first to load registers /timer; the second stays dormant; a
// shutdown releases the slot so the next runtime re-registers.
const mkPi = (cmds) => ({
	registerCommand: (n, o) => (cmds[n] = o),
	on: () => {},
	sendUserMessage: () => {},
});
// test 19's session_shutdown released the sentinel → a fresh copy registers
const cmdsA = {};
mod.default(mkPi(cmdsA));
assert.ok(cmdsA.timer, "fresh runtime re-registers after shutdown");
// a second copy loaded alongside the first stays dormant
const cmdsB = {};
mod.default(mkPi(cmdsB));
assert.deepStrictEqual(Object.keys(cmdsB), [], "second copy registers nothing");
console.log("✓ duplicate install stays dormant; reload re-registers");

console.log("\nALL TESTS PASSED");

// Some screens keep 1s refresh intervals alive on purpose; a smoke test may
// exit as soon as the assertions are green.
process.exit(0);
