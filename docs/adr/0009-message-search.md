# 0009. Message search is Postgres full-text, behind one exported function

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Message search: Postgres full-text and its prefix weakness"
**Teaches:** [`docs/concepts/message-search.md`](../concepts/message-search.md)

## Context

The map placed message search and username search in v1 and settled Postgres as the datastore, which
makes full-text search the obvious default. The default has a real weakness — it does not do
incremental prefix matching well — and the usual answer to that weakness is a dedicated search
engine.

That answer has a bill, and the bill is the whole decision.

## Decision

**Postgres full-text search with a stored generated `tsvector` column and a GIN index**, plus a
trigram index for short prefixes and a separate trigram index on the handle column. The entire
search surface sits behind **one exported function**.

- `'simple'` configuration, not `'english'`
- `websearch_to_tsquery` for raw user input
- `ts_rank_cd` with `ts_headline` for ranking and snippets
- **Message body only** is indexed
- `gin_fuzzy_search_limit` set to the low thousands

## Why not a dedicated engine

The objection is recorded here rather than dismissed, because someone will ask it again:

A dedicated engine is a **second datastore that must mirror the first**. It needs a change feed or an
outbox consumer to stay in sync, a rebuild-on-drift story, **per-user access control it must
understand independently** — so a search bug becomes a data-leak bug — and a consistency surface you
have to test. Meilisearch's claim that results are "always consistent with your primary data" is
true only because for them the index *is* the system of record. Nobody can make that claim when
Postgres is.

The mitigation that makes deferral cheap: **one exported function**. Swapping engines later is then
one file, and the call sites do not know.

## The two weak spots, stated honestly

### Prefix matching degrades for short strings — and PostgreSQL does not document it

Prefix matching exists and is documented: lexemes in a `tsquery` may be labelled `*`. The *performance*
consequence is not. A one- or two-character prefix yields no trigrams, and the `pg_trgm` documentation
says what follows — *"a pattern with no extractable trigrams will degenerate to a full-index scan"* —
but **no `postgresql.org` page warns that prefix matching gets slow for short prefixes**. That is
folklore from mailing lists, and this record labels it engineering judgment rather than citing a doc.

The practical rule is a **minimum of three characters**, and note the second trap: `pg_trgm` ignores
non-word characters, so a query of pure punctuation also produces no trigrams and scans the same way.
Guarding on length alone does not close it.

### Ranking silently returns zero on a stripped vector

`ts_rank_cd` *"requires lexeme positional information… it ignores any 'stripped' lexemes in the
`tsvector`. If there are no unstripped lexemes in the input, the result will be zero."*

Our stored column keeps positions, so this is fine today. It is written down because a future someone
stripping positions to save space would not get wrong results — they would get **every result ranked
identically**, which looks like a ranking bug and is not.

## Corrections to the original ticket

**Two claims in the ticket are folklore, and one was mine:**

- The operational guard is **`gin_fuzzy_search_limit`**, not `gin_pending_list_limit`. The latter is a
  pending-list *size* threshold in kilobytes, default 4MB, and has nothing to do with rows returned.
  The former is documented verbatim: *"GIN has a configurable soft upper limit on the number of rows
  returned… It is set to 0 (meaning no limit) by default"*, with values *"in the thousands (e.g., 5000
  — 20000)"* recommended. A common-word query against an unlimited GIN scan is a genuine problem.
- **Postgres does not recommend a stored generated column over an expression index.** The docs present
  both sides. The stored column's advantages are that you need not specify the text search
  configuration in the query to use the index, and that searches are faster. The expression index is
  *"simpler to set up… and requires less disk space since the `tsvector` representation is not stored
  explicitly."* We take the stored column for index eligibility, not because the docs say so.
- **The documented dictionary templates are simple, synonym, thesaurus, ispell, snowball.** There is no
  `stop` or `extended` template; `extended` was a historical alias for snowball and has been removed.

## Why `'simple'` and not `'english'`

Because `'english'` is actively wrong for this product. It drops stop words — the documentation's own
example shows *"the resulting `tsvector` does not contain the words `a`, `on`, or `it`"* — and it
stems, so `rats` becomes `rat`. A messenger where people search for **exact names and exact words**
should not have `Sam` match `same`, and should still find a message containing the word "on".

`'simple'` lowercases and does nothing else. Note the precise claim: the built-in `pg_catalog.simple`
dictionary has **no stopwords file** (which is why it removes nothing), rather than the documentation
stating that directly.

## Consequences

- **Search is a write-path cost.** Every message writes a `tsvector`, and GIN write amplification is
  real. Indexing **body only** is deliberate: sender names and conversation titles would multiply it
  on a table that already commits a message and an outbox row in one transaction. Adding them later
  is a second generated column; untuning a bloated index under load is not cheap.
- **The expensive query is written first.** Cross-conversation search needs a membership join and is
  the one people actually want; per-conversation search is a predicate on the same shape. Both come
  from the one exported function, which means the hard version is built against pressure and the easy
  one is a filter.
- **Snippets must come from `ts_headline`, not the body.** Deriving the highlight client-side from the
  message body marks words the index did not match — a small inconsistency nobody reports and
  everybody notices. With `'simple'` and no stemming there is nothing to desynchronise, so it is free.
- **Username search is a separate problem and gets a separate index.** It is autocomplete over one
  column; routing it through a message ranker builds machinery nobody needs. A trigram index on the
  handle, with **GIN** rather than GiST — the documentation notes KNN (`ORDER BY t <-> 'word'`) is
  efficient on GiST *"but not by GIN indexes"*, which is only relevant if someone reaches for
  nearest-neighbour ranking, which they should not.

## What would reverse this

**Latency, and only latency.** Postgres full-text stops being the right answer when a search is slow
enough that users notice — at which point the one-function boundary is what makes the migration
survivable, and the objection recorded above is what makes it a considered choice rather than a
default nobody questioned.

**The shape is already right for that.** One exported function, body-only indexing, and prefix search
delegated to trigrams are all decisions that a different engine would invert. None of them are baked
into a call site.