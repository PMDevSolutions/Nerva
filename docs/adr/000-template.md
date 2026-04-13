# ADR-000: [Short Title of Decision]

## Status

[Proposed | Accepted | Deprecated | Superseded by ADR-NNN]

## Date

YYYY-MM-DD

## Context

What is the issue that we're seeing that is motivating this decision or change? Describe the forces at play — technical constraints, business requirements, team capabilities, and any other factors influencing the decision.

## Decision

What is the change that we're proposing and/or doing? State the decision clearly and concisely.

## Consequences

What becomes easier or more difficult to do because of this change?

### Positive

- List the benefits of this decision.

### Negative

- List the drawbacks or trade-offs.

### Neutral

- List any side effects that are neither clearly positive nor negative.

---

## Usage

To propose a new ADR:

1. Copy this template to `NNN-title.md` where `NNN` is the next sequential number.
2. Fill in all sections. The Context section should be thorough — it's the most valuable part.
3. Set status to **Proposed**.
4. Open a pull request for team review.
5. Once merged, update status to **Accepted** and add the date.
6. Add an entry to the [ADR index](README.md).

To supersede an ADR:

1. Create a new ADR referencing the old one.
2. Update the old ADR's status to **Superseded by ADR-NNN** (link to the new ADR).
