# ADR-003: TDD as a Mandatory Pipeline Gate

## Status

Accepted

## Date

2026-03-29

## Context

Nerva's `/build-from-schema` pipeline generates route handlers, middleware, and service code from an OpenAPI specification. Code generation introduces a specific risk: **generated code can appear correct without actually matching the contract it was generated from.** Without tests that independently verify the OpenAPI contract, there is no guarantee that the generated API behaves as specified.

The pipeline has 10 phases. The question is whether integration tests should be written before route handlers (TDD, phases 2 then 3) or after (traditional testing, phases 3 then a later test phase).

Key considerations:

- **The OpenAPI spec is the contract.** Tests derived from the spec verify that the API conforms to what was promised, independent of how the code was generated.
- **Code generation can drift.** If tests are written after handlers, there is a risk of writing tests that verify the implementation rather than the specification — testing what the code does rather than what it should do.
- **Pipeline phases are sequential.** A hard gate between test writing (Phase 2) and code generation (Phase 3) ensures tests are never skipped or deferred.
- **80% coverage threshold.** The quality gate at Phase 7 requires minimum 80% code coverage. Writing tests first makes this threshold achievable by design rather than requiring retroactive test writing.

## Decision

**TDD is enforced as a hard gate in the pipeline.** Phase 2 (test writing) must complete before Phase 3 (route generation) can begin. This is configured in `.claude/pipeline.config.json`:

```json
{
  "tdd": {
    "enforced": true,
    "redPhaseRequired": true,
    "greenPhaseRequired": true,
    "coverageThreshold": 80,
    "integrationTestRequired": true,
    "contractTestRequired": true,
    "testExistenceGate": true
  }
}
```

The pipeline orchestration enforces this dependency:

- Phase 2 (`tdd-scaffold`) depends on Phase 1 (`database-design`) and is **blocking**.
- Phase 3 (`route-generation`) depends on Phase 2 (`tdd-scaffold`) and cannot start until all tests are confirmed failing (RED phase).

## Consequences

### Positive

- **Tests verify the spec, not the implementation.** Because tests are written from the OpenAPI specification before any handler code exists, they are an independent check on contract conformance.
- **Coverage by design.** Every endpoint has integration tests before its handler is written, so the 80% coverage threshold is met naturally rather than requiring a separate test-writing effort.
- **Regressions caught immediately.** When modifying generated code or adding features, the pre-existing test suite catches contract violations.
- **Tests serve as executable documentation.** Integration tests demonstrate how each endpoint is called and what it returns, serving as living documentation for API consumers.
- **Confidence in refactoring.** Generated code can be restructured (extracting services, optimizing queries) with confidence that the test suite will catch behavioral changes.

### Negative

- **Slower initial pipeline execution.** Writing tests before code adds time to the generation process. The pipeline cannot produce a running API until both Phase 2 and Phase 3 complete.
- **Test maintenance burden.** If the OpenAPI spec changes, tests must be updated before route handlers can be regenerated. This is by design (the spec is the source of truth) but adds friction to spec changes.
- **Hard gate can block progress.** If tests cannot be written for a particular endpoint (e.g., due to external dependencies), the entire pipeline stalls. The `refactorPhaseOptional: true` config provides some flexibility, but the RED and GREEN phases are mandatory.

### Neutral

- The TDD approach follows the Red-Green-Refactor cycle: tests fail first (Red), handlers make them pass (Green), then code is cleaned up (Refactor, optional). This is a well-established methodology, not a Nerva invention — but enforcing it in an automated pipeline is unusual.
