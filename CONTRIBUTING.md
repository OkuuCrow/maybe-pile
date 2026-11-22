# Contributing to Maybe Pile

Thanks for helping! A few ground rules keep the app safe and dependable.

## Setup

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint && npm run typecheck && npm run format:check && npm test && npm run test:e2e
```

## Where things go

- `src/domain/`: pure business rules (status/progress, merge, links, CSV, themes). No Node or Electron imports (enforced by ESLint). Unit-test everything here.
- `src/db/`: SQLite access, migrations and repositories. Never edit a released migration; add a new one ([docs/migrations.md](docs/migrations.md)).
- `src/main/services/`: business operations composed in transactions. They must not import `electron`; inject adapters instead, so they stay testable in plain Node.
- `src/main/ipc/`: new IPC channels must be added to `API_SHAPE` (`src/shared/ipc-channels.ts`), get a strict Zod request schema in `REQUEST_SCHEMAS`, a response type, and a handler. The dispatcher test automatically checks that every channel rejects garbage. Update the API snapshot deliberately, and regenerate the docs table with `node scripts/run-ts.mjs scripts/gen-ipc-docs.ts`.
- `src/renderer/`: React UI. It may only talk to `window.maybePile`. No `dangerouslySetInnerHTML`, no `innerHTML`, no Node imports.
- `src/providers/`: see "How to add a provider" in [docs/providers.md](docs/providers.md). Tests must use `FakeHttp` and never hit live APIs.

## Standards

- Strict TypeScript; no `any` without a written justification.
- Every user-facing string goes in `src/renderer/app/strings.ts` where practical.
- New UI must pass the axe checks in `tests/ui/` and be fully keyboard operable, with labels for all controls and status conveyed by text as well as colour.
- Errors that reach the UI must be `UserSafeError`s: no stack traces, secrets or paths.
- Log IDs and error codes, never titles, notes or keys.
- Comments explain *why* (non-obvious decisions, edge cases, security), not *what*.

## Commits

Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

## License

By contributing you agree that your contributions are licensed under the MIT License.
