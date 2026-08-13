# agave-dashboard

A web dashboard served by `agave-validator` itself.

```bash
agave-validator --dashboard-port 8910
```

Then open <http://127.0.0.1:8910>. There is nothing else to configure and no
second process to run. The SPA is embedded in the validator binary, and the data
comes from handles the validator already holds.

The dashboard has no authentication and it exposes validator internals, so it
binds to `127.0.0.1` unless you pass `--dashboard-bind-address`. Put it behind a
reverse proxy with auth before exposing it.

## Architecture

```
core/src/validator.rs ──► DashboardService
                            ├── collector thread  (samples state, diffs, publishes)
                            ├── info loader       (one-time validator-name scan)
                            └── server thread     (HTTP + websocket on one port)
```

`context.rs` holds the handles the dashboard reads through. The crate does not
depend on `solana-core`; anything core-only, such as startup progress, arrives
behind a closure, which keeps the wiring in `validator.rs` down to a few lines.

`collect.rs` samples five times a second but publishes only what changed, so an
idle validator produces almost no websocket traffic. `proto.rs` defines the
envelope format and the publisher, which retains the latest value of every key
so a client connecting late is caught up in one shot. `server.rs` routes a
connection by peeking at its request head, then either serves an embedded asset
or hands the untouched socket to soketto.

The SPA lives in `frontend/`. Its `dist` directory is checked in so that a plain
`cargo build` needs no Node toolchain.

## Wire protocol

Every message is a JSON envelope:

```json
{ "topic": "summary", "key": "cluster", "value": "testnet" }
```

Topics currently published:

| Topic     | Keys |
|-----------|------|
| `summary` | `version`, `commit_hash`, `cluster`, `identity_key`, `vote_key`, `startup_time_nanos`, `server_time_nanos`, `uptime_nanos`, `startup_progress`, `root_slot`, `optimistically_confirmed_slot`, `finalized_slot`, `completed_slot`, `estimated_slot`, `next_leader_slot`, `vote_slot`, `vote_distance`, `identity_balance`, `vote_balance`, `vote_commission`, `stake`, `validator_counts`, `live_program_cache`, `estimated_slot_duration_nanos`, `skip_rate`, `health`, `estimated_tps`, `tps_history`, `tps_sample` |
| `epoch`   | `new` |
| `peers`   | `all`, `update` |
| `slot`    | `overview`, `update` |

The only request a client can make today is `summary.ping`.

## Building the frontend

`frontend/dist` is committed to the repository, so a normal `cargo build` needs
no Node toolchain and produces a validator with the UI already inside it. You
only need the steps below when you change the UI, or when `dist` is missing:

```bash
cd dashboard/frontend
npm install
npm run build          # writes dist/, which build.rs embeds
```

Then build the validator again and commit the regenerated `dist`. `build.rs`
watches the directory, so cargo picks the new bundle up on its own.

If `dist` is missing, the crate still builds. Cargo prints a warning, and the
server serves a page explaining how to produce the bundle rather than returning
a 404.

`npm run dev` serves the UI on Vite's dev server and proxies `/websocket` to a
validator on `127.0.0.1:8910`. This is the fast loop for UI work, since it needs
no Rust rebuild.

## Not yet implemented

Two panels have no equivalent here yet, because the data behind them does not
exist in Agave:

A shred timeline. `shred_fetch_stage` distinguishes turbine from repair via
`PacketFlags::REPAIR`, but nothing records per-shred arrival timing. This needs
new instrumentation on the receive path.

A TPU waterfall. The per-stage packet counters exist in the streamer, sigverify,
and `BankingStageStats`, but they are private and only escape the process
through `datapoint_info!`. Reaching them means either a tee on the metrics
agent's `MetricsWriter` or plumbing the counters out directly.

Per-slot transaction detail (`slot.query`) is also unimplemented. It needs
blockstore reads rather than the in-memory slot ring.
