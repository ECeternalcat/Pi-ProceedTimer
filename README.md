# pi-proceed-timer

A [pi](https://github.com/earendil-works/pi) extension that adds a `/timer`
command: a countdown that sends **`proceed`** as a user message when it ends,
so the agent picks the work back up — for example after a provider
rate-limit window (e.g. a 5-hour limit) while you sleep.

Deliberately **manual**: every provider words its limit message differently,
so you read the message and start the timer yourself.

## Install

```bash
pi install npm:pi-proceed-timer
# or from a checkout:
pi install ./pi-proceed-timer
```

## Usage

| Command | Behavior |
|---|---|
| `/timer` | Interactive setup; while a timer runs, shows its status |
| `/timer <minutes>` | Skip straight to the confirm screen (e.g. `/timer 300`) |
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

 ↓ increase · ↑ decrease · hold longer = faster (now 1 min/press)
 type digits to enter directly · backspace edits

 Enter continue · Esc cancel
──────────────────────────────────────────────
```

- **↓ increases, ↑ decreases.** Holding a key accelerates: steps of 1 → 5 →
  10 → 30 minutes per press as the auto-repeat continues. Release 450 ms to
  reset.
- **Type digits** to enter a value directly (`120`), Backspace edits.
- Range: 1–1440 minutes.

### Confirming

```
 Start the timer?

 Wait for 2 h

 Your time   2026-10-23 09:30 (GMT-8)
 UTC         2026-10-23 17:30 UTC

 When it ends, pi sends "proceed".

   Readjust    ❯ Confirm

 ←/→ choose · Enter start · Esc cancel
```

The target time is shown in **your timezone and UTC**. `Confirm` is the
default; Enter again starts the timer.

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
- The `proceed` text and timings are not configurable yet; edit
  `extensions/timer.ts` constants if you need different behavior.

## Development

```bash
npm install        # dev deps: typescript + host packages for typecheck
npm run typecheck  # tsc --strict against the pi extension API
npm test           # headless end-to-end smoke tests (node:test)
```

The smoke test drives the whole UI flow with fake TUI/theme/keybindings
objects and fast-forwards timers with `node:test` mock timers — no terminal
or model needed.

To develop against a live pi, install this checkout as a local package and
reload after edits:

```bash
pi install "D:/Code/pi proceed timer"
# in pi: /reload
```

## License

[MIT](LICENSE)
