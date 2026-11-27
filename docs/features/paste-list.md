# Paste a list (§14.6, core)

Add → **Paste a list**: one title per line; hints like `Dune 2021 (movie)`, `Hades [game]`, `Severance — tv`,
numbering and bullets are understood. Up to 500 lines / 100 000 characters.

1. **Review list**: parsed lines (editable), duplicates of library items and repeated lines are pre-skipped.
2. **Look up online** (optional): one line at a time through the source's own rate limiter, five lines per
   round trip; each line gets up to 5 candidates with a confidence label. Low confidence is never chosen
   automatically.
3. **Import**: nothing is added until you press Import. All added items form one import batch, undoable
   from Import → History.

**Screenshot OCR is not shipped.** A local WASM OCR engine plus language data is a multi-megabyte
dependency whose licensing and bundle impact were not reviewed in this pack; text import covers the core
need. A developer can add an OCR adapter that produces the same editable line list before matching.
