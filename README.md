# pi-proceed-timer

A [pi](https://github.com/earendil-works/pi) extension that adds a `/timer`
command: a countdown that sends **`proceed`** as a user message when it ends,
so the agent picks the work back up — for example after a provider
rate-limit window (e.g. a 5-hour limit) while you sleep.

Deliberately **manual**: every provider words its limit message differently,
so you read the message and start the timer yourself.

## Install

Install from **one** channel per machine. A local checkout, the npm
package, and a git checkout are distinct packages to pi — installing several
at once loads several copies of this extension. The extension keeps `/timer`
single-registered (the first copy to load wins, the others stay dormant),
but you should still remove the extras with `pi remove <source>`.

For daily use, install from npm:

```bash
pi install npm:pi-proceed-timer
```

Alternatives:

```bash
# from GitHub, pinned to a tag
pi install git:github.com/ECeternalcat/Pi-ProceedTimer@v1.0.0
# from a local checkout (development — see below)
pi install ./Pi-ProceedTimer
```

Update the npm copy with `pi update --extensions`; remove any copy with
`pi remove <source>`.

## Usage

| Command | Behavior |
|---|---|
| `/timer` | Interactive setup; while a timer runs, shows its status |
| `/timer <minutes>` | Start at the message step with the given duration (e.g. `/timer 300`) |
| `/timer cancel` | Cancel the running timer (works in every mode) |

### Setting the timer

```
──────────────────────────────────────────────
 Last timer
   Triggered  2026-10-23 07:30 (GMT-8)
   Action     proceed
   Status     agent resumed 07:30

 How many minutes should pi wait?

                   30 min
     in 30 min → 18:55 (GMT+8) · 10:55 UTC

 ↓ increase · ↑ decrease · hold longer = faster (now 1 min/press)
 type digits to enter directly · backspace edits

 Enter continue · Esc cancel
──────────────────────────────────────────────
```

- **↓ increases, ↑ decreases** — one minute per press, no matter how fast
  you tap (deliberate presses never trigger the acceleration ramp).
- **Hold** a key to accelerate: the terminal's auto-repeat ramps the step
  through 5 → 10 → 30 minutes per press (~0.3 s / ~0.7 s / ~1.4 s of holding
  at a typical repeat rate); release to reset the ramp.
- **Type digits** to enter a value directly (`120`), Backspace edits.
- The **live conversion line** under the value shows the equivalent duration
  (`in 1 h 24 min`) and the target time in your timezone and UTC, updating as
  you adjust — and refreshing every second while the screen is open. Targets
  on another day get a weekday prefix (`Sat 01:15`).
- Range: 1–1440 minutes.

### Choosing the message

```
──────────────────────────────────────────────
 Message to send when the timer ends

   ❯ proceed
     Custom…

 ↑/↓ or ←/→ choose · Enter select · Esc back
──────────────────────────────────────────────
```

`proceed` is the default and preselected — one Enter accepts it. Pick
`Custom…` to type any single-line message (Enter confirms, Backspace edits,
Esc goes back; empty input is rejected). The wizard remembers your custom
message across Readjust for quick reuse.

### Confirming

```
 Start the timer?

 Wait for 2 h

 Your time   2026-10-23 09:30 (GMT-8)
 UTC         2026-10-23 17:30 UTC
 Message     continue the refactor

   Readjust    ❯ Confirm

 ←/→ choose · Enter start · Esc cancel
```

The target time is shown in **your timezone and UTC**, plus the exact
message that will be sent (long messages wrap). `Confirm` is the default;
Enter again starts the timer.

### While it runs

`/timer` shows the remaining time (refreshing), the target local/UTC time,
and `Cancel / Close`. The footer status line keeps a compact
`⏳ 2:00:00` countdown.

### After it fires

The footer keeps the result until the next timer starts, so the next morning
you can see whether it went off:

- `✅ Timer done 07:30 · proceed dispatched` — `sendUserMessage()` returned
  without throwing (queued as a follow-up when the agent was busy)
- `✅ Timer done 07:30 · agent resumed` — an agent run was observed after the
  dispatch. This is deliberately distinct from *dispatched*: a queued message
  does not guarantee the model actually resumed work.
- `✖ Timer done 07:30 · proceed failed` — the send threw; the error is
  shown in `/timer`

`/timer`'s setup screen shows the same record in full (as in the first
screenshot above). The record lives in memory only and disappears when the
session is switched, reloaded, or closed.

## Notes & limitations

- One timer per session, kept in the extension runtime. `/new`, `/resume`,
  or `/reload` clears it (`session_shutdown`).
- Non-interactive modes (RPC/print): use `/timer <minutes>` and
  `/timer cancel`; a bare `/timer` reports the remaining time.
- The message defaults to `proceed`; the wizard can set any single-line
  message (capped at 200 characters). Timing constants live in
  `extensions/timer.ts` if you need different behavior.
- The timer sends proceed once at the scheduled time. It does not bypass provider rate limits or automatically detect when quotas reset. Pi must remain running for the timer to fire.  

## Development

```bash
npm install        # dev deps: typescript + host packages for typecheck
npm run typecheck  # tsc --strict against the pi extension API
npm test           # headless end-to-end smoke tests (node:test)
```

The smoke test drives the whole UI flow with fake TUI/theme/keybindings
objects and fast-forwards timers with `node:test` mock timers — no terminal
or model needed.

To develop against a live pi, clone the repo and install it as a local
package — pi loads extensions straight from that path, so edits take effect
after `/reload` with no copy step. Keep the dev machine on the local install
only (skip the npm one there):

```bash
git clone https://github.com/ECeternalcat/Pi-ProceedTimer.git
cd Pi-ProceedTimer
pi install .
# edit extensions/timer.ts, then in pi: /reload
```

## Release

Maintainer steps:

1. `npm version patch|minor|major` (bumps `package.json`, commits, tags)
2. `git push --follow-tags`
3. `npm publish` — requires 2FA; npm opens a browser page to approve
4. verify with `npm view pi-proceed-timer version` and
   `pi install npm:pi-proceed-timer` on another machine

## License

[MIT](LICENSE)
