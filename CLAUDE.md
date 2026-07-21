# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Crivo is an academic-integrity monitoring API for GitHub-based coursework. Professors create disciplines/turmas/trabalhos; students get repositories generated from a template inside a GitHub org; the API ingests push webhooks, enriches commits with line stats, runs anomaly detectors, and freezes deliveries at the deadline.

Domain language (schema, routes, and variables) is **Portuguese**: `usuario`, `disciplina`, `turma`, `matricula`, `trabalho`, `equipe`, `repositorio`, `push`, `commit`, `entrega` (frozen delivery), `sinalizacao` (anomaly flag). Keep new code in the same language rather than mixing English domain terms.

## Commands

```bash
npm run dev          # API (tsx watch src/index.ts)
npm run worker       # worker process — REQUIRED, see "Dois processos" below
npm run build        # tsc -p tsconfig.build.json -> dist/
npm test             # vitest run
npx vitest run tests/webhook.test.ts           # single file
npx vitest run -t "raw body"                   # single test by name
docker compose up -d # postgres, redis, api, worker

npx prisma migrate dev --name <descricao>  # cria migration + aplica em dev
npx prisma migrate deploy                  # aplica migrations em produção
npx prisma generate                        # regenera o client após editar o schema
npx prisma db seed                         # roda prisma/seed.ts via tsx
```

Migrations são versionadas em `prisma/migrations/`. **Não use `prisma db push`** — ele altera o banco sem gravar histórico e faz o `migrate` divergir.

There is no linter configured. Swagger UI is served at `/docs`.

## Dois processos: API + worker

Produção roda **dois processos a partir do mesmo código**:

| Processo | Comando (dev / prod) | Responsabilidade |
| --- | --- | --- |
| API | `npm run dev` / `npm start` | HTTP, webhooks, **apenas enfileira** jobs |
| Worker | `npm run worker` / `npm run start:worker` | consome `stats-commit`, `detector`, `repo-setup`, `congelador` |

`src/index.ts` **não** importa `src/jobs/worker.ts`. Sem o processo worker, os jobs se acumulam no Redis e nada é processado: commits ficam com `stats_status = PENDENTE`, detectores nunca rodam, repositórios ficam em `setup_status = PENDENTE` e nada é congelado. O worker registra o repeatable job do congelador no boot (`scheduleCongelador()`), com `jobId` fixo para não duplicar schedulers a cada restart.

## Architecture

**Stack:** Fastify 5 (ESM, `"type": "module"` — all relative imports must carry the `.js` extension), Prisma/PostgreSQL, BullMQ/Redis, Octokit (GitHub App), Zod, JWT.

**Request → detection pipeline:**

1. `POST /webhooks/github` (`src/routes/webhooks.ts`) verifies the HMAC-SHA256 signature, resolves the repo by `github_repo_id`, deduplicates on `github_delivery_id`, and writes the `Push` + `Commit` rows in one transaction. Commit authors are resolved to a `Usuario` by looking up the lowercased author email in `EmailCommit`; unresolved authors stay `null`.
2. It then enqueues one `stats-commit` job per new commit and one `detector` job for the repo (`src/jobs/queues.ts`).
3. The `stats-commit` worker (`src/jobs/worker.ts`) calls the GitHub API for `additions`/`deletions`, sets `stats_status = CALCULADO`, and **re-enqueues** a detector job — this second pass is what makes `COMMIT_GIGANTE` (which only counts `CALCULADO` commits) fire.
4. `src/detectors/index.ts` runs all five detectors over the repo. `createSignal` skips creation when a `PENDENTE` signal of the same type already exists on the repo, so detectors are safe to re-run but will not re-flag until a professor resolves the existing one.

**Detector thresholds are centralized in `config.detectors`** (`src/lib/config.ts`) — never hardcode them in `src/detectors/index.ts`.

**Freezing:** `runCongelador({ trabalhoId?, force? })` (`src/jobs/congelador.ts`) sweeps trabalhos whose `deadline` has passed, tags `refs/tags/entrega-N` at main's HEAD, and creates an `Entrega`. Two callers: the repeatable job (every `CONGELADOR_INTERVAL_MS`, default 60s) with no arguments, and `POST /prof/trabalhos/:id/congelar` scoped to one trabalho.

- **N is counted per repository**, not per trabalho — the tag lives in the repo, so every repo gets `entrega-1` on the first sweep and only diverges if refrozen.
- **Idempotence is what makes the 60s repeat safe**: a repo that already has an `Entrega` is skipped. `?force=true` on the manual endpoint bypasses that skip to produce `entrega-N+1` (e.g. the deadline was extended). Never remove the skip from the automatic path or every sweep would mint a new tag.
- The manual endpoint no longer rewrites the trabalho's `deadline` to `now` — passing `trabalhoId` scopes the sweep without that destructive side effect.

**Repo setup is a job, not inline work.** `createRepositoryFor{Student,Team}` generates the repo from the template, persists the row, and enqueues `repo-setup`. The worker calls `configureRepository()` (poll for `main`, add collaborators, protect the branch) with 5 attempts and exponential backoff; when the retries are exhausted it writes `setup_status = ERRO` plus `setup_erro` on the `Repositorio`. That status is surfaced to professors in the grade rows and in `getRepositoryMetrics`, so a student left without push access is visible rather than buried in logs.

**The Octokit `App` is built lazily** (`getGithubApp()`). Constructing it at import time throws when `GITHUB_PRIVATE_KEY` is unset, which broke every test that merely imported a route.

## Conventions that will bite you

- **Validation is manual.** `src/index.ts` installs `fastify.setValidatorCompiler(() => () => true)`, disabling Fastify's ajv. Every handler validates with Zod itself (`safeParse`/`parse`). `schema.body`/`params`/`querystring` built via `docSchema()` (`src/lib/openapi.ts`) are **documentation only** — adding one does nothing at runtime. New routes must validate explicitly.
- **BigInt.** `github_id` and `github_repo_id` are `BigInt`. `src/lib/serializer.ts` patches `BigInt.prototype.toJSON` (imported early in `index.ts`) and exports `serializeBigInt()` for payloads built by hand or signed into JWTs.
- **Auth.** `requireAuth` / `requireProfessor` in `src/lib/auth.ts`; the token is read from the `token` httpOnly cookie, falling back to `Authorization: Bearer`. `src/routes/alunos.ts` and `src/routes/professores.ts` apply their guard with a plugin-wide `addHook('preHandler', …)`, so every route in those files is protected by default. `src/routes/auth.ts` attaches `preHandler` per route instead.
- **Role assignment** happens at OAuth callback from `PROFESSOR_LOGINS` (comma-separated logins, lowercased). Rule: promote ALUNO→PROFESSOR, never demote.
- **GitHub calls** go through `getInstallationOctokit()` (installation id cached per process) wrapped in `withGithubRetry()` for 403/429/5xx backoff — use both rather than calling Octokit directly.
- **Repo creation** (`src/services/repo.ts`) generates from the trabalho's `template_repo`, then polls up to ~20s for the `main` branch to materialize before adding collaborators and enabling branch protection.
- **Config has permissive defaults** (mock secrets, localhost URLs) so tests and dev boot without a `.env`; see `.env.example` for the real set.

## Tests

Vitest, no DB or Redis required — `tests/` mock `../src/lib/prisma.js`, `../src/jobs/queues.js`, `../src/lib/octokit.js`, and `bullmq` with `vi.mock`. Prisma mocks are partial (only the model methods a test needs), so adding a query to a code path usually means extending the mock object — a missing `push.create` silently turns the handler into a 500. `buildApp()` is exported from `src/index.ts` and the listener is skipped when `NODE_ENV === 'test'`; use `app.inject()` for HTTP tests.

Mock `bullmq` with classes (`Queue: class { add = vi.fn(); }`), not `vi.fn().mockImplementation(() => ({}))` — the latter is not a constructor and fails at import.

Two invariants worth keeping green:

- `tests/webhook.test.ts` asserts the HMAC is computed over the **raw body**: a payload reserialized through `JSON.parse`/`stringify` must fail signature verification with the original signature.
- `tests/alunos_metricas.test.ts` asserts a student cannot read another student's metrics (403 for non-owner / non-team-member) and that `getRepositoryMetrics` is never even reached on denial.
