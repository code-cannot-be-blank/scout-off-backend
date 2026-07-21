# Performance Budget

This document defines target performance budgets for ScoutOff's most latency-sensitive API endpoints. Budgets are derived from a baseline run against the current implementation; they should be revisited when significant architectural changes land (e.g., a Redis cache layer, database migrations, or Soroban contract modifications).

## Budgets

All measurements are taken against a locally-running instance (single Node.js process, SQLite on disk) using the `scripts/loadtest.ts` autocannon harness.

| Endpoint | p50 | p95 | p99 | Throughput (req/s) |
|---|---|---|---|---|
| `GET /api/players` | ≤ 50 ms | ≤ 150 ms | ≤ 300 ms | ≥ 200 |
| `GET /api/players/:playerId` | ≤ 30 ms | ≤ 100 ms | ≤ 200 ms | ≥ 500 |
| `POST /auth/token` | ≤ 100 ms | ≤ 300 ms | ≤ 500 ms | ≥ 100 |

These budgets assume:

- Seeded dataset of at least 5 players (the default from `scripts/seed.ts`)
- No concurrent long-running Soroban RPC calls (the auth endpoint has no Stellar dependency; player detail reads from SQLite and cache)
- Server running on a modern laptop or CI-equivalent runner

## Running the Load Test

### 1. Seed the database

```bash
npx ts-node --project tsconfig.scripts.json scripts/seed.ts
```

### 2. Start the server

```bash
npm start
```

The server listens on `http://localhost:4000` by default (configurable via `PORT`).

### 3. Run the load test

```bash
npm run loadtest
```

This runs `autocannon` against the three endpoints sequentially, each for 30 seconds with 20 concurrent connections.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `LOADTEST_TARGET` | `http://localhost:4000` | Base URL of the running server |
| `LOADTEST_DURATION_SEC` | `30` | Seconds each endpoint is exercised |
| `LOADTEST_CONNECTIONS` | `20` | Number of concurrent connections |
| `LOADTEST_PLAYER_ID` | `seed-player-001` | Player id used for detail endpoint |

## CI

The load test is **not** wired into the standard per-PR CI pipeline. It is intended for manual runs before performance-sensitive releases. If a future CI runner is provisioned with adequate resources, the budgets above can be enforced by adding a step that fails if any metric exceeds the target.

## Baseline

A baseline run was conducted on [date] against the `main` branch at commit [sha] with the following results:

| Endpoint | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|
| `GET /api/players` | - | - | - | - |
| `GET /api/players/:playerId` | - | - | - | - |
| `POST /auth/token` | - | - | - | - |

*Note: Baseline numbers are intentionally blank — the first person to run `npm run loadtest` against their local environment should fill them in along with the date and commit sha, then open a follow-up PR to lock them in.*
