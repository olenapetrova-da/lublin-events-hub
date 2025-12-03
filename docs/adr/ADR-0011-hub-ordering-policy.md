# ADR-0011: Hub ordering policy

*Status:* Accepted  
*Date:* 2025-11-05  
*Applies to:* LEHv1, LEHv2

## Context

Clients expect time-specific events first. Ongoing/no-time items (e.g., exhibitions) should not overshadow events with exact showtimes. :contentReference[oaicite:9]{index=9}

## Decision

- **Primary grouping:** timed events first, then ongoing/no-time.
- **Within each group:**
  - Sort by `Date` ascending.
  - If a time exists, sort by the earliest `Time` in that row.
  - Tie-breaker: `Title` (case-insensitive) ascending.
- **Showtime union:** when `group_times=1`, union same-title/same-date showtimes into a single row (comma-separated, earliest-first).

## Consequences

- Users see actionable events first.
- Stable, deterministic ordering; less churn between runs.
- Hub behavior is explicit and testable.

## References

- ADR-0004 (hub JSON mode)  
- `docs/specs/adapter-contract.md` (group_times)  
- `docs/specs/sources/zoom-lublin.md` (multi-time rules)

## LEHv2 note (2025-12)

- LEHv2 ingestion still calls the **Hub** with `group_times=1`; the Hub ordering policy remains unchanged.
- DB queries in LEHv2 (`events`/`showtimes`) should preserve the **same user-visible ordering principle** (timed first, then ongoing, then title) when building lists for the Telegram bot.
