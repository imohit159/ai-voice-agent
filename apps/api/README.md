# API modular monolith

The API is one Fastify process and one SQLite database. Modules own cohesive behavior; they do not introduce separate deployments, queues, or internal HTTP calls.

```text
src/
├── index.ts                      Process entry point and signal handling
├── app.ts                        Composition, plugins, module registration, shutdown
├── config/
│   ├── index.ts                  Typed environment configuration and readiness
│   └── paths.ts                  Workspace and built frontend locations
├── modules/
│   ├── auth/                     Operator sessions, login/logout, password checks
│   ├── workspace/                Dashboard state, agent settings, test-order reset
│   ├── calls/
│   │   ├── index.ts              Configuration-free application interface
│   │   ├── module.ts             Fastify registration and expiry lifecycle
│   │   ├── service.ts            Admission, idempotency, dialing, reconciliation
│   │   ├── routes.ts             Operator call endpoints
│   │   ├── callbacks.routes.ts   Signed Exotel callbacks and flow resolution
│   │   └── infrastructure/       Exotel HTTP adapter
│   └── voice/
│       ├── index.ts              Voice transport interface and registration
│       ├── routes.ts             Single-use browser/phone stream admission
│       ├── streams.ts            Stream protocol and session lifecycle
│       ├── live.ts               Provider selection from saved call settings
│       ├── voice.ts              Shared provider interface
│       ├── providers/            Gemini and Sarvam implementations
│       ├── outcome.ts            Customer-evidence validation
│       ├── prompt.ts             Conversation instructions
│       └── audio.ts              Bounded PCM conversion and framing
└── platform/
    ├── http/                     Shared headers, error responses, operator guards
    ├── security/                 Purpose-bound signed tokens
    └── persistence/              SQLite Store and atomic call/order writes
```

Modules expose `index.ts` for callers. Calls additionally exposes `module.ts` for startup registration: its application interface remains usable without loading environment configuration or provider adapters. `app.ts` assembles dependencies and owns the database; modules own their behavior and timers. HTTP handlers validate transport input and invoke application services. Calls and workspace services receive configuration and dependencies through construction.

`pnpm check` and `pnpm build` enforce source import boundaries with `scripts/check-boundaries.mjs`: cross-module imports use public entry points, configuration/platform never import business modules or bootstrap, and application services do not import configuration, route handlers, or provider infrastructure. Tests may inspect internal adapters to verify provider protocols.

The concrete SQLite Store remains shared because recording a phone decision changes both the call and its order within one transaction. Splitting storage into independent module databases would weaken that invariant. Existing data, endpoints, settings snapshots, idempotency keys, origin checks, signed tokens, and WebSocket shutdown ordering remain compatible.

## Why dist exists

`dist/` is generated JavaScript and source maps, ignored by Git. It mirrors the source module structure.

Run these commands from the repository root:

- `pnpm dev`: watch API TypeScript source using tsx; API `dist` is not used.
- `pnpm build`: check module boundaries and types, remove stale API outputs, and compile the deployment artifacts.
- `pnpm start`: run `apps/api/dist/index.js` with Node.

The contracts package is compiled for the shared workspace imports. The API at port 3000 serves frontend assets from `apps/web/dist`; use the Vite development workflow for frontend hot reload. Do not edit generated files. Build cleanup affects only `apps/api/dist`, preserving source, configuration, and database files.
