# Content issues — UNDERCITY

Findings from reconciling `content/faults.json`, `content/specs.json` and
`content/sectors.json` against each other and against the design documents.

**Pipeline discipline (spec §1):** never hand-edit the generated JSON. Fix the
issue in `tools/undercity-crossref-matrix.xlsx`, recalculate, then re-run
`tools/export_faults.py`. A hand-fix desynchronises paper from server and makes
a fault unsolvable mid-session — the one failure the facilitator cannot recover
from live.

`lib/validate.js` re-runs these checks at every boot. Errors abort startup;
warnings print loudly and allow the run.

---

## ✅ FIXED — F-208 flavour line contradicted the answer key

**Was: session-breaking.** A team doing everything correctly could not solve
this fault. Corrected at source and re-exported.

| | Before | After |
|---|---|---|
| Flavour (prints on the fault card) | "match AGR **West** cycle code" | "match AGR **East** cycle code" |
| `spec_refs` | `A4-3` "Array East" = 915 | unchanged |
| `valid_codes` | `["P-05-915"]` | unchanged |

A team reading the old card fetched `A4-4` "Array West" = 534, submitted
`P-05-534`, and was rejected — with no recovery path, since spec values are
deliberately meaningless out of context (spec §3.3) and three guesses trigger
the 20-second lockout.

### Which half was wrong

The `spec_refs` assignment was right; the flavour text was wrong. The matrix's
own `Used By` column records the intended allocation:

| Spec | Row label | Value | Used By |
|---|---|---|---|
| `A4-3` | Array East | 915 | **F-208** |
| `A4-4` | Array West | 534 | **F-401** |

`F-401` independently confirms it — its flavour says "AGR **West** array code"
and it refs `A4-4`. Repointing F-208 at `A4-4` would have made two faults share
one spec value, orphaned `A4-3`, and weakened the uniqueness property that makes
overheard numbers useless.

### How it was fixed

In `tools/undercity-crossref-matrix.xlsx`, sheet `Faults`, column E of the
`F-208` row: "AGR West" → "AGR East". The workbook was recalculated and
`tools/export_faults.py` re-run. `tools/build_crossref.py` (the generator)
carries the same corrected string, so a regenerated workbook stays fixed.

### Verified after the fix

- The re-exported `faults.json` differs from the previous one **in that single
  flavour string** — nothing else across 36 faults changed.
- **No spec-value drift.** All 66 values are identical to before: `W4-3` still
  prints 340, 290 still appears in no table, all values still unique.
  **Only F-208's own fault card needs reprinting — no binder changes.**
- A fresh export from the vendored workbook reproduces all three committed
  fixtures **byte-for-byte**, proving the committed content is generated rather
  than hand-edited.
- `build_crossref.py` is deterministic (`random.seed(9)`): re-running it
  reproduces all 66 spec values and every flavour line exactly, so regenerating
  the workbook never invalidates printed binders.
- `lib/validate.js` now reports **0 errors and 0 warnings**; the server boots
  without a warning banner.
- Both structural edge cases survive: `F-201` two codes, `F-210` zero.

`test/validate.test.js` no longer asserts the defect. It now asserts the shipped
content is clean, that F-208's card and key name the same row, and — on a
mutated in-memory fixture — that the prose detector still fires. Fixing the
content must not silently retire the check that caught it.

---

## ⚠️ OPEN — `export_faults.py` references a `recalc.py` that does not exist

Low severity: affects an error path only, not a normal run.

When the exporter hits its formula-cache guard it instructs the operator to
`run: python recalc.py <workbook> 60`. That file is not in this repo and was not
supplied with the rectified pipeline, so the instruction is currently a dead end.
The reference appears in three places: the module docstring, the
zero-validation-rows error, and the empty-resolution-code error.

The exporter is otherwise adopted verbatim as canonical, so the wording is left
untouched rather than guessed at. Two ways to close this:

- drop `recalc.py` into `tools/` (the messages then become accurate with no code
  change), or
- reword the two messages to name the manual route as well — recalculating by
  opening the workbook in Excel/LibreOffice and saving.

Until then, the manual route is the one that works: **open the workbook, save
it, re-export.**

---

## 🔧 FIXED — exporter accepted an uncalculated workbook silently

**Severity: would have shipped an unplayable build with a ✓.**

`export_faults.py` classified a fault as a false alarm whenever its resolution
code cell read empty:

```python
is_false_alarm = rescode is None or "NO CODE" in rescode
```

But an empty cell does not mean "false alarm". In a healthy workbook a genuine
false alarm is authored as the literal string `NO CODE (false alarm)`, while a
real fault's code is the formula `=J23&"-"&TEXT(L23,"000")`. `openpyxl` reads
formulas via their **cached** values, and that cache is discarded whenever the
workbook is written by a script rather than by Excel or LibreOffice.

So a single scripted edit to any cell turned **all 36 faults into codeless
ghosts**, and both safety nets failed open:

- the malformed-code check (`"did you run recalc.py?"`) only inspects faults
  that are *not* false alarms, so it never ran;
- the Validation sheet is itself formula-driven, so it read as `0 checks OK`
  rather than as a failure.

The exporter printed `✓ wrote content/faults.json (36 faults…)` and exited 0.
Loading that content would have given every team an unsolvable alert.

**Fixed** in `tools/export_faults.py`, implementing what its own docstring
already promised ("Aborts on failed validation or unrecalculated formulas"):

1. only the explicit `NO CODE` marker declares a false alarm; an empty cell is
   now a hard error naming the recalculation step;
2. a Validation sheet yielding zero readable checks is an error, not a pass;
3. a fault carrying a procedure but no resolution code is an error.

Verified both ways: against the healthy workbook the export is byte-identical
to the shipped fixtures; against a script-written workbook it now aborts with
exit 1 and writes nothing.

**Practical note for content edits:** edit the matrix in Excel or LibreOffice
so formulas recalculate on save. Editing it with `openpyxl` strips the cache,
and the export will now correctly refuse to run.

---

## ✅ Checked and cleared

- **F-209 is not a defect.** Its flavour reads "North array dead; re-strike
  needs COM Grid South calibration offset." The "North array" is AGR's *own*
  broken equipment; the spec it needs is COM `C3-2` "Grid South" (931). The two
  directions refer to different things and the card is coherent. `lib/validate.js`
  scopes its prose check to the clause naming the source binder so this no
  longer raises a false positive.

## ✅ Validation results (36 faults, 66 specs, 6 sectors)

- Declared `meta` counts match actual contents.
- Round split R0:6 · R1:8 · R2:12 · R3:6 · R4:4 — matches spec §4.2 deck composition.
- Every non-false-alarm `valid_code` re-derives exactly from `procedure` + its spec values.
- No duplicate spec values; the reserved value 290 does not appear in any spec table.
- No ambiguous codes (no two faults in one sector share a resolution code).
- Exactly one buried Appendix C spec per binder — `PC-1`, `WC-1`, `MC-1`, `TC-1`, `AC-1`, `CC-1`.
- Both structural edge cases intact: `F-201` carries two valid codes, `F-210` carries zero.
- Discrepancy seed intact: `W4-3` Lower Reservoir = 340, flagged; big screen telemetry = 290.
- 21 specs are unreferenced — intentional decoy rows, marked "decoy row" in the matrix.
