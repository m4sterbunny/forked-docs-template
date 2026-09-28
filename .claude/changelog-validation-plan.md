# `docs-deprecated-apis` check — false positives and missed hits

Moved from `mdk-prv`'s `gateway-api-removal-0.6.0-docs-impact.md` (section 6,
"The validation gap that surfaced this"), written while validating the 0.6.0
changelog on 2026-07-29 and re-confirmed 2026-08-06. That plan's docs-side
work is otherwise complete; this piece is tooling work against this repo
(`forked-docs-template`, upstream `tetherto/docs-template`), specifically
`validation/checks/docs-deprecated-apis.mjs`, so it lives here instead.

## The two defects

Recorded so they aren't rediscovered. Confirmed against 0.6.0's `CHANGELOG.md`
in `mdk-prv`, and against the actual extractor code in this repo.

### 1. Misses whole-surface removals that don't repeat a removal verb

`extractDeprecatedFromRemovedBullets` (docs-deprecated-apis.mjs:196-211) only
matches a bullet if the text between the dash and the words
"removed"/"deleted"/"retired" contains a backtick span starting with `@` or
containing `(`:

```js
const removedPattern = /(?:^|\n)[-*]\s+(?:\*\*)?([^*\n]+?)(?:\*\*)?\s+(?:removed|deleted|retired)/gmi;
```

0.6.0's actual `## Removed` bullet for the single biggest breaking change in
the release:

```
- The Gateway's entire built-in HTTP API surface — see Breaking changes for
  the module-by-module list, plus the `ws` integration test and the ~40 unit
  suites covering the deleted routes, handlers, and libraries
```

doesn't contain the word "removed"/"deleted"/"retired" as a standalone token
next to the subject at all (it relies on the `## Removed` heading to convey
that, which is normal, good changelog writing — repeating "removed" in every
bullet under a heading already called "Removed" is redundant). So the whole
bullet fails the regex and contributes zero extracted terms, even though
`splitIntoSections` + `DEPRECATION_HEADING` already correctly identified it as
being under a removal heading. The heading-level gate is doing the real
classification work; the inline-verb requirement on top of it is redundant
*and* is the actual hole.

Same root cause explains the plan's original framing ("only extracted via
bold spans or a `@scope/package` code span"): `[^*\n]+` can't contain `*`, so
a match only succeeds when the captured span is either plain text immediately
followed by the verb, or fully wrapped in `**bold**` — anything with a
backtick-only subject and prose after it (like the bullet above) never
matches.

### 2. Verifies against changelog prose, not the prior release tag

`loadDeprecatedFromChangelogs` (docs-deprecated-apis.mjs:242-303) parses
`CHANGELOG.md` plus every file under the configured `changelog_archives`
paths, merges every extracted term from *all* of them, and never checks
real repo state. There's no `git show <tag>:...` or `git ls-tree` call
anywhere in the file — "deprecated" status is inferred entirely from
matching prose patterns.

The plan's four 0.6.0 false positives were each things that still genuinely
existed at `v0.5.0` (confirmed by hand with `git ls-tree`/`git show`) but got
extracted as "deprecated" anyway, because the extractor can't distinguish
"this term is really gone from the code" from "this term merely matched one
of the four prose-heuristic patterns somewhere in changelog history."

## Refactor notes

Concrete changes, in the same file (`validation/checks/docs-deprecated-apis.mjs`)
unless noted:

1. **Decouple heading-gate from inline-verb-gate for the removed-bullets
   extractor.** `extractDeprecatedFromRemovedBullets` already only runs on
   sections where `DEPRECATION_HEADING.test(section.heading)` is true (see
   `parseChangelogForDeprecations`, line 226-227) — that's the real signal.
   Drop the trailing `(?:removed|deleted|retired)` requirement from
   `removedPattern` and instead extract from *every* bullet in a gated
   section, the same way `extractDeprecatedFromTables` already treats an
   entire table as fair game once its section heading qualifies.

2. **Broaden identifier extraction on plain "Removed" bullets past
   `@pkg`/`func(`.** Reuse the classification already written for table rows
   (line 111-126: `/` → path, `@` prefix → package, `(` → function, `^[A-Z]`
   → class, else → function) instead of the narrower two-branch check
   currently inline in `extractDeprecatedFromRemovedBullets`. This also
   starts populating `deprecated.classes` from removed-bullets, which the
   current version never does at all.

3. **Fail loud, not silent, on bullets with no backtick span.** A bullet like
   the Gateway-API-surface one above has no clean identifier to extract
   automatically at all — no backticks anywhere near the subject. Rather than
   silently contributing nothing, have the extractor collect these as a
   separate `unparsed` bucket and print them as a warning ("N `## Removed`
   bullets had no backtick-wrapped identifier, review manually") so a human
   catches the miss instead of it just not showing up in any output.

4. **Anchor extraction to the tag diff, not the full cumulative prose.**
   Replace "read `CHANGELOG.md` + every archived file, merge everything" with
   a diff against the previous release tag: `git -C <source_repo.path> show
   <prevTag>:CHANGELOG.md` vs. the working tree's `CHANGELOG.md` (or the new
   tag), and only parse the *added* lines. This directly targets the false-positive
   mechanism — a term can only be "deprecated by 0.6.0" if it's part of what
   changed between `v0.5.0` and `v0.6.0`, not just something that appears
   somewhere in the accumulated prose of every past changelog. `prevTag` can
   be read from `config.yaml` (new field, e.g. `source_repo.prev_tag`) or
   resolved automatically via `git describe --tags --abbrev=0 <tag>^` from
   the current tag.

5. **Optional, stronger version of (4): verify against real tree state, not
   just diffed prose.** For each candidate identifier extracted from the
   diff, confirm it actually resolves in the pre-release tree (`git show
   <prevTag>:<path>` for paths/packages, or `git grep` scoped to that tag for
   function/class names) before adding it to the deprecated set. This is the
   most direct fix for "confirmed with `git ls-tree`/`git show`" — do that
   check automatically instead of by hand after the fact.

Priority: (1)+(2) fix the miss (false negative) that let the whole Gateway
API removal through undetected; (4) is the more impactful fix for the false
positives, since it changes what population of terms is even considered
rather than filtering after the fact. (3) and (5) are lower-effort
hardening on top of either.
