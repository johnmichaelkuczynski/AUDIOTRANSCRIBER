---
name: Legal transcript polish quality
description: Durable quality rules for publication-grade legal transcript polishing.
---

Legal transcript polishing must separate global identity resolution from local chunk copyediting. Use a strong, dedicated name-ledger pass driven by direct self-introductions, explicit confirmations, all observed variants, and speaker-turn context.

**Why:** A complex all-purpose skeleton can omit phonetic variants even when a focused identity pass resolves them correctly. Word-count pressure also rewards retaining filler, while blanket phrase deletion can damage meaningful language such as “as you know.”

When a speaker’s identity is established by self-introduction, direct confirmation, repeated direct address, or an explicit user mapping, replace generic source labels with one canonical legal label. An exact spelling supplied by the user outranks an ASR spelling.

**Why:** Preserving `SPEAKER C/E` after conclusive identification made an otherwise polished legal transcript look unfinished. Generic one-letter labels must never enter body-name canonicalization: treating `A/C/D` as surname variants can corrupt ordinary articles and abbreviations throughout the text.

**How to apply:** Allow polished text to shorten materially; remove true vocal fillers and repetitions deterministically; treat discourse markers contextually; inherit labels on split continuation paragraphs; canonicalize names globally; map resolved speakers to canonical labels; exclude generic or shorter-than-three-character variants from body replacement; and refuse completion when labels, variants, legal terms, typography, or disfluency checks fail. When text remains genuinely ambiguous and stored audio exists, inspect the relevant audio segment rather than guessing a name.

Preserve semantically surprising party labels or pronouns when direct audio confirms they were spoken. For low-confidence nonsense words, use a tightly isolated audio segment, multiple independent recognizers, phonetic evidence, and sentence context; do not silently substitute a merely plausible word.

**Why:** Legal-role context can tempt an editor to “fix” accurate testimony, while several recognizers may produce different near-phonetic guesses for the same unclear word.

**How to apply:** Treat direct audio as authoritative over contextual expectations. Correct only when the acoustic reading and the surrounding phrase jointly support the replacement; otherwise mark the word unclear rather than rewriting testimony.