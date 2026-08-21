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

## 🔴 OPEN — F-208 flavour line contradicts the answer key

**Severity: session-breaking.** A team doing everything correctly cannot solve
this fault.

| | |
|---|---|
| Fault | `F-208` "Rail power flicker" (TRN, R2) |
| Flavour (prints on the fault card) | "Yard rail flickers on lamp-bank switching; match **AGR West** cycle code." |
| `spec_refs` | `A4-3` — "Array **East**" = **915** |
| `valid_codes` | `["P-05-915"]` |
| What the card sends the team to fetch | `A4-4` "Array West" = **534** → submits `P-05-534` → **rejected** |

Because spec values are unique per table cell and deliberately meaningless out
of context (spec §3.3), the team has no way to recover from the wrong row
except by guessing — and three guesses trigger the 20-second lockout.

### Which half is wrong

The `spec_refs` assignment is correct; **the flavour text is wrong**. The
matrix's own `Used By` column in the `SpecTables` sheet records the intended
allocation:

| Spec | Row label | Value | Used By |
|---|---|---|---|
| `A4-3` | Array East | 915 | **F-208** |
| `A4-4` | Array West | 534 | **F-401** |

`F-401`'s flavour independently confirms this — it says "AGR **West** array
code" and refs `A4-4`. Repointing F-208 at `A4-4` would make two faults share
one spec value, orphan `A4-3`, and weaken the uniqueness property that makes
overheard numbers useless.

### Recommended fix

In `tools/undercity-crossref-matrix.xlsx`, sheet `Faults`, row for `F-208`,
column E (`Flavour Line (card front)`):

```
- Yard rail flickers on lamp-bank switching; match AGR West cycle code.
+ Yard rail flickers on lamp-bank switching; match AGR East cycle code.
```

Then recalculate and re-export:

```
npm run export-content
```

No code change is required — `valid_codes` and `spec_refs` are already correct,
and the resolution code formula (`=J23&"-"&TEXT(L23,"000")`) is untouched.

### Status

Not applied. The three JSON fixtures in `content/` are byte-identical to the
exporter output supplied with the build. Awaiting the content owner's decision.

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
