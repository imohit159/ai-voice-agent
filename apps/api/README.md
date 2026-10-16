# API modular monolith

The API is one Fastify process and one SQLite database. Modules own cohesive behavior; they do not introduce separate deployments, queues, or internal HTTP calls. Background work (scheduling, reconciliation, result delivery) runs as in-process interval jobs backed by persistent state.

```text
src/
├── index.ts                      Process entry point and signal handling
├── app.ts                        Composition, plugins, module wiring, shutdown
├── config/
│   ├── index.ts                  Typed, validated environment configuration
│   └── paths.ts                  Workspace and built frontend locations
├── modules/
│   ├── call-management/          Call requests, attempts and their lifecycle
│   │   ├── module.ts             Wiring, provider selection, background jobs
│   │   ├── service.ts            Intake rules, scheduling, provider events, recovery
│   │   ├── policy.ts             Pure calling-hours and retry rules (IST)
│   │   ├── repository.ts         call_requests and call_attempts persistence
│   │   ├── telephony.ts          Provider-neutral telephony port
│   │   ├── plivo.routes.ts       Signed Plivo ring/answer/hangup callbacks
│   │   └── infrastructure/       Plivo REST adapter and simulated provider
│   ├── integrations/             Business-system boundary
│   │   ├── module.ts             Wiring and result-delivery job
│   │   ├── routes.ts             Signed call-request intake
│   │   ├── service.ts            Result outbox and delivery retries
│   │   ├── repository.ts         result_deliveries persistence
│   │   └── infrastructure/       Signed webhook client
│   ├── auth/                     Operator sessions, login/logout, password checks
│   ├── workspace/                Dashboard state, agent settings, demo reset
│   ├── calls/                    Legacy browser practice sessions (replaced in stage 4)
│   └── voice/                    Legacy Node voice pipeline (replaced by Pipecat in stage 4)
└── platform/
    ├── http/                     Shared headers, error responses, operator guards
    ├── jobs/                     Non-overlapping interval jobs with graceful stop
    ├── security/                 Signed tokens and HMAC request signatures
    └── persistence/              SQLite connection, versioned migrations, legacy Store
```

## Dependency rules

`pnpm check` and `pnpm build` enforce source import boundaries with `scripts/check-boundaries.mjs`:

- Cross-module imports go through a module's `index.ts` or `module.ts`.
- `config/` and `platform/` never import business modules or bootstrap.
- Application services (`service.ts`) never import configuration, routes, or `infrastructure/`; they receive dependencies through construction. Adapters implement types the service owns.

`integrations` depends on `call-management` (to accept requests); `call-management` never depends on `integrations`. It reports finished attempts through the `onAttemptFinished` hook, which `app.ts` connects to the result outbox. The hook runs inside the transaction that settles the attempt, so an attempt can never finish without its result being queued.

## Persistence

`platform/persistence/database.ts` opens SQLite (WAL) and applies `migrations.ts` in order, tracked by `PRAGMA user_version`. Released migrations are never edited; add a new one. Repositories receive the shared connection; Node is the only writer.

## Why dist exists

`dist/` is generated JavaScript and source maps, ignored by Git. It mirrors the source module structure.

Run these commands from the repository root:

- `pnpm dev`: watch API TypeScript source using tsx; API `dist` is not used.
- `pnpm build`: check module boundaries and types, remove stale API outputs, and compile the deployment artifacts.
- `pnpm start`: run `apps/api/dist/index.js` with Node.

The contracts package is compiled for the shared workspace imports. The API at port 3000 serves frontend assets from `apps/web/dist`; use the Vite development workflow for frontend hot reload. Do not edit generated files.
