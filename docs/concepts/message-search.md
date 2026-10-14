# Message search

What backs search, what it is honestly bad at, and where the boundary with username autocomplete sits.

Decisions are in [`docs/adr/0009`](../adr/0009-message-search.md). Read after
[the message lifecycle](./message-lifecycle.md), which establishes that search indexes a table that
already commits a message and an outbox row in one transaction.

---

## Postgres full-text, behind one function

```sql
search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
CREATE INDEX ON messages USING GIN (search_vector);
CREATE INDEX ON messages USING GIN (body gin_trgm_ops);
CREATE INDEX ON "user"  USING GIN (handle gin_trgm_ops);
```

Query with `websearch_to_tsquery('simple', $1)`, rank with `ts_rank_cd`, and highlight with
`ts_headline`.

**The whole search surface is one exported function.** That is what makes swapping engines later a
one-file change instead of a rewrite.

### Why not Meilisearch, Typesense, or Algolia

Because a dedicated engine is a **second datastore that must mirror the first**: a change feed or
outbox consumer to stay in sync, a rebuild-on-drift story, per-user access control it must understand
*independently* — so a search bug becomes a data-leak bug — and a consistency surface you have to
test.

The claim that such engines are "always consistent with your primary data" is true only because for
them the index *is* the system of record. Nobody can make that claim when Postgres is.

### `'simple'`, not `'english'`

`'english'` is actively wrong for a messenger. It **drops stop words** — the PostgreSQL docs' own
example shows *"the resulting `tsvector` does not contain the words `a`, `on`, or `it`"* — and it
**stems**, so `rats` becomes `rat`.

People search for exact names and exact words. `'simple'` lowercases and does nothing else. (The
built-in `pg_catalog.simple` dictionary has no stopwords file, which is why it removes nothing — a
fact from the catalogue rather than a sentence in the docs.)

### `websearch_to_tsquery` for raw input

Documented: *"this function will never raise syntax errors, which makes it possible to use
raw user-supplied input for search."*

Caveat worth knowing: it does not recognise `tsquery` operators, weight labels, or prefix labels in
its input — so a user typing `*` gets nothing special, and garbage input is silently reduced rather
than rejected.

---

## The two weak spots, stated honestly

### Prefix matching, and a minimum of three characters

Prefix matching is real and documented — `to_tsquery('supern:*A')`. The **performance** consequence
is not documented anywhere on `postgresql.org`, and that is worth saying plainly rather than citing a
page that does not say it.

The mechanic follows from `pg_trgm`: *"a pattern with no extractable trigrams will degenerate to a
full-index scan."* One or two characters produce no trigrams. So:

- **Guard at 3 characters minimum.**
- Guarding on length alone is not enough — `pg_trgm` ignores non-word characters, so a query of pure
  punctuation also yields no trigrams and scans everything.

`pg_trgm` is genuinely the right tool: it indexes `LIKE`, `ILIKE`, `~` and `=`, and unlike B-tree
searches *"the search string need not be left-anchored."*

### Ranking silently returns zero on a stripped vector

`ts_rank_cd` *"requires lexeme positional information… it ignores any 'stripped' lexemes in the
`tsvector`. If there are no unstripmed lexemes in the input, the result will be zero."*

Our stored column keeps positions, so this is fine. It is written down because anyone stripping
positions to save space would not get wrong results — they would get **every result ranked
identically**, which reads as a ranking bug and isn't one.

---

## Scope and shape

**Message body only, in v1.** Every indexed field is GIN write amplification on a write-heavy table.
Sender name and conversation title search is a legitimate later addition and costs a second generated
column; untuning a bloated index under load does not.

**Both scopes, from the same function** — per-conversation is a predicate, cross-conversation adds a
membership join. The cross-conversation query is the useful one and the expensive one, so it gets
written first, against pressure, rather than second by accident.

**Snippets come from `ts_headline`, not the body.** Deriving the highlight client-side marks words
the index did not match — a small inconsistency nobody reports and everybody notices. With `'simple'`
there is no stemming to desynchronise the two, so it is free.

### The operational guard

**`gin_fuzzy_search_limit`**, not `gin_pending_list_limit`. The latter is a pending-list *size*
threshold in kilobytes, default 4MB, and has nothing to do with rows returned.

Documented verbatim: *"GIN has a configurable soft upper limit on the number of rows returned… It is
set to 0 (meaning no limit) by default"*, with *"values in the thousands (e.g., 5000 — 20000)"*
recommended. A search for a common word against an unlimited GIN scan is a real problem.

---

## Username search is a different problem

It is autocomplete over one indexed column. Routing it through a message ranker builds machinery
nobody needs, so it gets its own trigram index and no ranking function.

**GIN, not GiST.** The docs note KNN (`ORDER BY t <-> 'word'`) *"can be implemented quite efficiently
by GiST indexes, but not by GIN indexes"* — which is only relevant if someone reaches for
nearest-neighbour ranking, which they should not.

---

## Corrections worth keeping

Three claims in the original ticket did not survive checking, and one of them was mine:

- The GIN row limit is **`gin_fuzzy_search_limit`**. I had attributed it to `gin_pending_list_limit`,
  which is a different setting with a different unit.
- **Postgres does not recommend a stored generated column over an expression index.** The docs
  present both sides — the stored column avoids specifying the configuration in the query and
  searches faster; the expression index is *"simpler to set up… and requires less disk space."* We
  chose it for index eligibility, not on the docs' authority.
- **The short-prefix performance warning is folklore**, not documentation. Stated as engineering
  judgment throughout rather than cited.
- The documented dictionary templates are **simple, synonym, thesaurus, ispell, snowball**. There is
  no `stop` or `extended` template; `extended` was a historical snowball alias and has been removed.