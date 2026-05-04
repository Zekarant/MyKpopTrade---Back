# CLAUDE.md - Instructions pour l'assistant IA

## Principes fondamentaux

### 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- **State assumptions explicitly** — If uncertain, ask rather than guess
- **Present multiple interpretations** — Don't pick silently when ambiguity exists
- **Push back when warranted** — If a simpler approach exists, say so
- **Stop when confused** — Name what's unclear and ask for clarification

### 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked
- No abstractions for single-use code
- No "flexibility" or "configurability" that wasn't requested
- No error handling for impossible scenarios
- If 200 lines could be 50, rewrite it

The test: Would a senior engineer say this is overcomplicated? If yes, simplify.

### 3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting
- Don't refactor things that aren't broken
- Match existing style, even if you'd do it differently
- If you notice unrelated dead code, mention it — don't delete it

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused
- Don't remove pre-existing dead code unless asked

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform imperative tasks into verifiable goals:
- "Add validation" -> Write tests for invalid inputs, then make them pass
- "Fix the bug" -> Write a test that reproduces it, then make it pass
- "Refactor X" -> Ensure tests pass before and after

For multi-step tasks, state a brief plan:
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]

---

## SOLID Principles

### 5. Single Responsibility (SRP)
A class/module has one reason to change. One actor, one purpose.
- A `UserService` doesn't send emails AND format reports AND hash passwords
- Split when responsibilities serve different stakeholders (auth team vs billing team)
- A function does one thing — the name should fully describe it without "and"

The test: Can you describe what it does in one sentence without "and" or "or"? If not, split.

### 6. Open/Closed (OCP)
Open for extension, closed for modification.
- Adding a new payment method shouldn't require editing `PaymentProcessor` — it should plug in
- Use polymorphism (interfaces, strategy pattern) over `if/elif` chains on type
- Don't preemptively apply this — wait until you have 2+ real variants. Don't invent extensibility for one case.

The test: When requirements change, do you edit existing classes or add new ones?

### 7. Liskov Substitution (LSP)
Subtypes must be substitutable for their base types without breaking behavior.
- A subclass cannot strengthen preconditions or weaken postconditions
- Don't override a method to throw `NotImplementedError` — that's a sign your hierarchy is wrong
- If `Square extends Rectangle` breaks `setWidth/setHeight` semantics, the inheritance is wrong — prefer composition

The test: Can you swap any subclass for the parent in any caller without surprises?

### 8. Interface Segregation (ISP)
Clients shouldn't depend on methods they don't use.
- Prefer many small, focused interfaces over one fat interface
- A `ReadOnlyRepository` and `WritableRepository` is better than a single `Repository` that read-only consumers must implement fully
- "Role interfaces" over "header interfaces"

The test: Does any implementer have empty/throwing methods? If yes, the interface is too wide.

### 9. Dependency Inversion (DIP)
Depend on abstractions, not concretions. High-level modules don't depend on low-level modules.
- Domain/business logic defines interfaces; infrastructure implements them
- `OrderService` depends on `PaymentGateway` (interface), not on `StripeClient` (concrete)
- This is what makes the code testable — you can swap real I/O for fakes
- Wire concrete implementations at the composition root (main/bootstrap), not deep in business logic

The test: Can you unit-test the business logic without a database, network, or filesystem?

---

## Code Quality

### 10. Naming
Names are documentation. Spend time on them.
- **Reveal intent** — `daysSinceLastLogin`, not `d` or `days`
- **Avoid encodings** — no Hungarian notation, no `I` prefix on interfaces
- **Booleans read as predicates** — `isActive`, `hasPermission`, `canRetry`
- **Functions are verbs** — `calculateTotal`, `fetchUser`. Pure getters can be nouns: `total`
- **Async functions surface it** — `fetchUserAsync` or rely on language convention (e.g. `await`)
- **No abbreviations except domain-standard** — `id`, `url`, `http` ok; `usrMgr`, `calcAmt` not

The test: Would a new dev know what this does from the name alone?

### 11. Functions
Small, focused, predictable.
- **Short** — if it doesn't fit on screen, it's probably doing too much
- **Few parameters** — 3 max as a soft limit. More than 3 → group into a parameter object
- **No flag arguments** — `render(data, true)` is unreadable. Split into two functions
- **No hidden side effects** — `getUser()` doesn't write to a cache silently. If it does, name it `getOrLoadUser()`
- **Command/Query Separation** — a function either changes state OR returns data. Not both
- **One level of abstraction per function** — don't mix high-level orchestration with low-level string manipulation

### 12. Comments
Code explains *what*. Comments explain *why*.
- **Don't comment what the code says** — `// increment i` is noise
- **Do comment why** — business rules, non-obvious tradeoffs, links to issues/specs
- **Don't leave commented-out code** — git remembers, delete it
- **TODO/FIXME include context** — `// TODO(#1234): handle timezone edge case` not `// TODO: fix this`
- **Outdated comments are worse than none** — if you change code, update or delete the comment

### 13. Magic Values
No unexplained literals.
- Numbers, strings, durations that carry meaning → named constants
- `if (user.age >= 18)` → `if (user.age >= LEGAL_ADULT_AGE)`
- Group related constants into enums or const objects
- Exception: obvious values in tight scope (`for (let i = 0; i < arr.length; i++)`)

---

## Architecture

### 14. Layered Architecture
Enforce boundaries. Dependencies point inward.

Standard layers (names vary, concept doesn't):
- **Transport / Controller** — HTTP, message handlers. Parses input, calls service, formats output. **No business logic.**
- **Application / Service** — Orchestrates use cases. Coordinates domain + infrastructure. **No HTTP, no SQL.**
- **Domain** — Business rules, entities, value objects. **No frameworks, no I/O.**
- **Infrastructure** — DB, external APIs, file system. Implements interfaces defined by domain/service.

Rules:
- Domain never imports from infrastructure or transport
- Service never imports from transport
- Controllers are thin — extract → validate → delegate → respond

### 15. Dependency Injection
Pass dependencies in. Don't reach out for them.
- Constructor injection by default (explicit, testable)
- No service locators, no global singletons accessed mid-function
- No `new ConcreteThing()` inside business logic — inject the interface
- Composition root (e.g. `main.ts`, `bootstrap.py`, `Program.cs`) wires everything

The test: Can the class be instantiated in a test with all fakes/mocks, no patching?

### 16. Domain Modeling
Make invalid states unrepresentable.
- Use value objects for domain concepts — `Email`, `Money`, `UserId`, not raw `string`/`number`
- Validate at construction — if a `Money` exists, its amount is valid
- Prefer immutability for value objects and DTOs — return new instances on change
- Entities have identity; value objects are equal by value
- Anemic models (data classes with all logic in services) are sometimes fine — don't force DDD where CRUD suffices

### 17. Boundaries with External Systems
Wrap. Don't leak vendor types into your domain.
- Wrap third-party SDKs behind your own interface
- Translate vendor errors into domain errors at the boundary
- DTOs at the edges (HTTP, DB, queues); domain types in the core
- The day you swap Stripe for Adyen, only the adapter changes

---

## Error Handling

### 18. Errors Are Part of the API
Design them as deliberately as success paths.
- Distinguish **expected** errors (user input invalid, resource not found) from **unexpected** ones (bug, infra down)
- Expected errors → typed results or domain exceptions, handled at boundary
- Unexpected errors → bubble up, get logged, return 500. **Don't swallow them.**
- Never `catch` without either handling, rethrowing, or logging with full context
- `catch (e) { /* ignore */ }` is a code smell unless explicitly justified by a comment

### 19. Error Context
An error message should let an on-call engineer act without reading source.
- Include: what failed, what inputs, what was expected
- Bad: `"validation failed"`
- Good: `"validation failed: field 'email' must match RFC 5322, got 'foo@'"`
- Wrap and rethrow with context as you cross layers — don't lose the cause/stack
- Don't put PII or secrets in error messages or logs

### 20. Fail Fast
Validate at the boundary; trust the core.
- Reject bad input at the controller/edge — don't propagate `null`/invalid values deeper
- Inside the domain, assume inputs are valid (because they were validated at the edge)
- Use assertions/preconditions for invariants you control; exceptions for runtime conditions

---

## Testing

### 21. Test Pyramid
Many fast unit tests, fewer integration tests, even fewer end-to-end.
- **Unit** — pure logic, no I/O, milliseconds. The bulk.
- **Integration** — real DB / real HTTP boundary, in-process. Verifies wiring.
- **End-to-end** — full system, slow, brittle. Smoke-test critical paths only.

If most tests need mocks for everything, the design is wrong — fix the design, not the tests.

### 22. Test Structure
Arrange, Act, Assert. One behavior per test.
- **Name describes the behavior** — `returns_404_when_user_does_not_exist`, not `test_get_user_2`
- **One logical assertion per test** — multiple `expect`s on the same outcome are fine, multiple unrelated outcomes are not
- **Independent** — order must not matter, no shared mutable state
- **Deterministic** — no real time, no randomness, no network. Inject clocks, seed RNGs, fake HTTP.

### 23. What to Test
Test behavior, not implementation.
- Test **public contracts** — inputs, outputs, observable side effects
- Don't test private methods directly — test them through the public API
- Don't assert on log lines or internal call counts unless that *is* the contract
- Cover: happy path, edge cases, error paths, boundary values

### 24. Test Data
Make tests readable.
- Use builders/factories for complex objects — `aUser().withEmail("x@y.z").build()`
- Hide irrelevant fields; surface only what matters for the test
- Don't share mutable fixtures across tests — fresh data per test

### 25. TDD When It Helps
Write the test first when:
- Fixing a bug — reproduce it before fixing
- Building a pure function with clear input/output
- The interface is the hard part

Skip TDD when exploring or when the interface is unknown — write a spike, then test.

---

## API Design (REST)

### 26. Resources and Verbs
URLs are nouns. HTTP methods are verbs.
- `GET /users/123` not `GET /getUser?id=123`
- `POST /orders` to create, `PUT /orders/123` to replace, `PATCH /orders/123` to update partially
- `DELETE /orders/123` to remove
- Plural collection names, consistent across the API

### 27. Status Codes
Use them correctly.
- `200` — success with body. `201` — created (with `Location` header). `204` — success no body
- `400` — client sent bad data. `401` — not authenticated. `403` — authenticated but forbidden. `404` — not found
- `409` — conflict (e.g. duplicate). `422` — semantic validation failure (when distinct from `400`)
- `429` — rate limited. `500` — server bug. `503` — degraded/down
- Don't return `200` with `{ "error": ... }` in the body — use real status codes

### 28. Idempotency
Same request, same effect. Always.
- `GET`, `PUT`, `DELETE` are idempotent by spec — keep them so
- `POST` for create — accept an `Idempotency-Key` header for retries on payment-like operations
- Idempotency matters: clients retry on network errors, message brokers redeliver

### 29. Validation and Error Bodies
Consistent error shape, machine-readable.
- Validate input at the edge — type, presence, format, range, business rules
- Return errors in a consistent envelope with `code`, `message`, `details` (e.g. RFC 7807 Problem Details)
- Field-level errors when validation fails — clients should know which field is wrong
- Never echo back the raw input in error messages without sanitizing (XSS, log injection)

### 30. Pagination, Filtering, Sorting
Don't return unbounded lists. Ever.
- Default and maximum page size enforced server-side
- Cursor-based pagination for large or frequently-changing datasets; offset for stable, small ones
- Consistent query param names across endpoints (`limit`, `cursor`, `sort`, `filter[field]`)

### 31. Versioning
Plan for change. Break compatibility deliberately.
- Version in the URL (`/v1/`) or `Accept` header — pick one, stick to it
- Additive changes (new optional fields) don't require a version bump
- Breaking changes get a new version; old version stays alive during deprecation window
- Document deprecations with sunset dates

---

## Database

### 32. Migrations
Schema is code. Versioned and reviewed.
- Every schema change goes through a migration tool (Flyway, Alembic, Prisma Migrate, etc.)
- Migrations are forward-only in production; rollbacks via new migrations
- Backward-compatible deploys: add column → backfill → deploy code that uses it → remove old column in a later release
- Never `DROP` or rename without a deprecation cycle

### 33. Transactions
Define boundaries explicitly.
- A transaction wraps a single business operation — open at the service layer, not the repository
- Keep transactions short — no external HTTP calls inside a transaction
- Choose isolation levels deliberately — know what `READ COMMITTED` vs `SERIALIZABLE` buys you
- Handle deadlocks and serialization failures with bounded retry

### 34. Query Quality
Slow queries kill services.
- **Avoid N+1** — fetch with joins or batch loads, not one query per item in a loop
- **Index what you query** — every `WHERE`, `JOIN`, `ORDER BY` in a hot path needs an index
- **Limit result sets** — `SELECT *` and unbounded queries are bugs waiting to happen
- **Use `EXPLAIN`** before shipping non-trivial queries
- **Don't put business logic in the DB** unless there's a strong reason — stored procs and complex triggers are hard to test and review

### 35. Repositories
Abstract persistence, don't leak it.
- Repository methods speak the domain language — `findActiveSubscribers()` not `selectWhereStatusEquals1()`
- Return domain entities, not ORM rows or raw records
- Don't expose query builders or ORM types to the service layer

---

## Security

### 36. Input Validation
Trust nothing from outside the process.
- Validate type, length, format, range — at the boundary, before anything else
- Use allowlists over denylists
- Reject silently-truncating coercions (long strings, big numbers)
- Validate file uploads: MIME type, size, magic bytes, not just extension

### 37. Authentication and Authorization
Two distinct concerns. Both required.
- **AuthN** — who are you? (token, session, cert)
- **AuthZ** — what are you allowed to do? (role, permission, ownership check)
- AuthZ is per-action — never trust a previous check. The `userId` in the URL must be verified against the authenticated identity
- Default deny — explicit allow

### 38. Secrets
Never in code. Never in logs. Never in version control.
- Secrets come from env vars, secret managers (Vault, AWS Secrets Manager, etc.)
- Pre-commit hooks / CI scans for committed secrets
- Rotate on suspected leak, immediately
- Don't log auth headers, tokens, passwords, PII — mask or omit

### 39. Common Backend Pitfalls (OWASP-flavored)
- **SQL injection** — parameterized queries always, no string concatenation
- **Mass assignment** — explicit allowlist of writable fields on update
- **SSRF** — validate and restrict outbound URLs (no `localhost`, no internal IP ranges)
- **Insecure deserialization** — don't deserialize untrusted input into typed objects without restriction
- **Timing attacks** — use constant-time comparison for secrets/tokens
- **Rate limiting** — per IP, per user, per endpoint. Especially on auth and expensive operations

### 40. Data Protection
Treat user data as a liability.
- Encrypt at rest and in transit
- Hash passwords with a slow KDF (bcrypt, argon2, scrypt) — never SHA/MD5
- Minimize data collected; delete what you don't need
- Know which fields are PII; document retention and deletion policies

---

## Performance

### 41. Measure First
No optimization without data.
- Profile before changing anything for performance
- Optimize the actual hot path, not the assumed one
- Track latency percentiles (p50, p95, p99), not averages — averages lie
- Set SLOs; optimize toward them, not toward "fast"

### 42. Concurrency and I/O
Don't block on I/O.
- Use async / non-blocking I/O for network and disk in request paths
- Bound concurrency — unbounded fan-out crashes services
- Timeouts on every external call — no exceptions
- Retries with exponential backoff and jitter, capped attempts, only for idempotent operations

### 43. Caching
Cache deliberately, invalidate explicitly.
- Cache when read >> write and staleness is acceptable
- Choose the layer: in-process, distributed (Redis), CDN — each has tradeoffs
- Always have a TTL; treat the cache as throwaway
- Stampede protection (single-flight, request coalescing) on hot keys
- Cache invalidation is the hard part — design it before adding the cache

### 44. Resource Limits
Every operation has a budget.
- Pagination on every list endpoint
- Max body size on every endpoint
- Timeouts on every dependency call
- Connection pool sizes tuned to dependency limits, not infinite

---

## Logging & Observability

### 45. Structured Logging
Logs are queryable data, not prose.
- JSON (or equivalent structured format) in production
- Standard fields on every log: `timestamp`, `level`, `service`, `traceId`, `userId` (if auth'd)
- Log events, not narration — `order.created` with fields beats `"created order " + id`

### 46. Log Levels
Use them consistently.
- **ERROR** — something broke, action required
- **WARN** — degraded but handled, watch for patterns
- **INFO** — significant business events (login, order placed)
- **DEBUG** — diagnostic, off in production by default
- Never log at ERROR for expected conditions (validation failures aren't errors)

### 47. Correlation
Tie events together.
- Propagate a trace/correlation ID across services (via headers like `traceparent`)
- Include it in every log line and error response
- One ID lets you reconstruct a full request flow across N services

### 48. Metrics and Health
Know the state of the system.
- Expose `/health` (process alive) and `/ready` (dependencies reachable, ready to serve traffic) — they are not the same
- RED metrics for services: Rate, Errors, Duration
- USE metrics for resources: Utilization, Saturation, Errors
- Alert on symptoms (user-visible failure), not causes (CPU at 80%)

---

## Configuration

### 49. 12-Factor Config
Config in the environment, not in code.
- Env vars for anything that differs across environments (URLs, credentials, feature flags)
- No `if (env === "production")` branches in business logic — branch on the *capability*, not the environment name
- Config validated at startup — fail to boot with a clear error rather than crash on first request
- Sensible defaults for local dev; nothing required for prod must have a default

### 50. Feature Flags
Decouple deploy from release.
- Use flags for gradual rollouts, kill switches, A/B tests
- Flags are temporary — track them, remove them after rollout
- Keep flag logic at the edge of features, not scattered throughout

---

## Git Workflow

### 51. Commits
Atomic, focused, well-described.
- One logical change per commit — easier to review, revert, bisect
- **Conventional commit** style is fine: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`
- Subject line: imperative mood, ≤72 chars — `add user export endpoint`, not `added` / `adding`
- Body: explain *why*, not *what* — the diff shows what

### 52. Branches and Pull Requests
Small, reviewable, fast to merge.
- Short-lived feature branches off `main`
- PRs under ~400 lines diff when possible — bigger ones don't get reviewed properly
- PR description: context, what changed, how it was tested, screenshots/logs if relevant
- CI must pass; at least one review; no merging your own PR without review (in shared repos)

### 53. Never
- Force push to shared branches
- Commit secrets, `.env` files, credentials
- Commit generated artifacts (build outputs, `node_modules`, etc.)
- Rewrite history on shared branches

---

## Documentation

### 54. README and Onboarding
A new dev should be productive in under an hour.
- README covers: what this service does, how to run it locally, how to test, how to deploy
- Architecture decisions in `docs/adr/` (Architecture Decision Records) — short markdown, dated, immutable
- API documented via OpenAPI / spec — generated from code where possible

### 55. Code Documentation
Public APIs documented; internals self-explanatory.
- Public functions/classes: docstring with purpose, params, returns, errors thrown
- Internal helpers: name them well, skip the docstring unless behavior is surprising
- Keep docs next to code — drift kills documentation

---

## Code Review Checklist

Before requesting review (or before claiming "done"):

- [ ] Tests pass locally (unit + integration)
- [ ] New code has tests covering happy path, edges, errors
- [ ] No commented-out code, no `console.log` / `print` debug noise
- [ ] No new TODOs without a tracked issue
- [ ] No new dependencies without justification
- [ ] No secrets, PII, or sensitive data in logs or error messages
- [ ] Public API changes documented
- [ ] Migrations are backward-compatible (or deploy plan is documented)
- [ ] Errors return the right status code with a useful body
- [ ] External calls have timeouts and retry policy
- [ ] Names read clearly; no abbreviations or magic values
- [ ] Diff is minimal — only changes related to the task

---

## When in doubt

1. Re-read principles 1–4
2. Choose the simpler option
3. Ask before guessing