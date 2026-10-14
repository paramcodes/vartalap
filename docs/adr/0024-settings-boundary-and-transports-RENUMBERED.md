# 0024. Three homes for a setting, two transports for a change, three switches that must not exist

**Status:** ⚠️ **Renumbered, not superseded** — this decision stands
**Date:** 2026-10-14
**Renumbered to:** **[0022-settings-boundary-and-transports](0022-settings-boundary-and-transports.md)**
**This is not the decision.** Renumbered because sibling agents took ADR numbers 0011–0020 in the same
batch. Kept under the old name because three sibling documents cite it.

## What moved and why

Nothing here was changed by the renumbering. **Read [0022](0022-settings-boundary-and-transports.md).**

The current file supersedes this one on four points, because adjacent tickets decided them while this
one was being written and duplicating them would have created two sources of truth:

| This file said | Now decided by |
|---|---|
| `session.cookieCache` is off, and here is why | [0018-socket-is-a-lease](0018-socket-is-a-lease.md) — kept, and extended with the socket disconnect |
| Deletion anonymises the author, tombstones the handle, retains messages and receipts | [0041-erasure-is-a-tombstone](0041-erasure-is-a-tombstone.md) |
| Handle changes allowed at one per 7 days | **rejected** — [0016-identity-is-one-table](0016-identity-is-one-table.md) and [0017-handle-alphabet](0017-handle-alphabet.md) |
| Rate limiting is "the Redis token bucket every other limiter uses" | [0043-rate-limits](0043-rate-limits.md), which is that decision |

## What survives here unchanged, and is still the contribution

- **The three-homes rule.** Anything needed before first paint is device-local; anything needing the
  server's authority is account-scoped; anything scoped to a relationship lives on the membership.
  Theme fails the first test, which is *why* it is device-local.
- **Two transports.** Disclosure changes (avatar, display name) ride the socket because direct
  conversations derive their title and picture. Privacy changes are authenticated `POST`s, because a
  socket write has no defined failure and a privacy decision on a fan-out channel is a broadcast of a
  private act.
- **Three switches that must not exist** — last seen, hide-active-status, profile visibility — and
  the rule underneath them: **never render a disabled switch.** Render a sentence.
- **Read-receipt sharing is per-conversation**, with no global switch, and the copy must not claim
  invisibility: progress *rate* is observable.
- **Notification permission is not a control we own**; it is gesture-only, and `default` means act as
  denied. **The push endpoint is a capability URL** and is never rendered.
- **Export contains no Credential and no session token**, and the devices list never renders a token.