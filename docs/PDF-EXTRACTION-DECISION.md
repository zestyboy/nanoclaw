# PDF Extraction Decision

Short note capturing why this repo uses `pdftotext` for the current NanoClaw feature, while still preferring `Marker` for true PDF-to-Markdown conversion outside this narrow scope.

---

## Decision

For the PDF extraction feature implemented in this branch, NanoClaw should use:

- `pdftotext` for text extraction
- `pdfinfo` for page counts and metadata hints

For a separate workflow whose goal is faithful PDF-to-Markdown conversion, prefer:

- `Marker` as the primary tool
- `markitdown` and `Pandoc` only as fallbacks or for other document types

---

## Why

The feature in this repo is not a general PDF-to-Markdown pipeline. It is a lightweight host-side extraction step that:

- writes a cached `.txt` sidecar
- returns an excerpt for agent context
- flags likely scanned PDFs when extracted text is sparse
- keeps dependencies and runtime cost low inside the NanoClaw container flow

That makes `pdftotext` the best fit for the current implementation. It is fast, simple, already aligned with the existing PDF reader skill, and avoids bringing in a much heavier layout-analysis stack for output the system currently flattens back into plain text anyway.

`Marker` remains the best choice when the actual product goal is structured PDF-to-Markdown with headings, layout recovery, and better handling of visually complex PDFs. That is a different problem from "get enough readable text into agent context."

---

## Option Summary

### `pdftotext`

Best fit for the current NanoClaw feature.

- Fast and small dependency footprint
- Good for text-based PDFs
- Matches the current `.txt` caching and excerpt-based API
- Does not preserve Markdown structure
- Does not solve scanned PDFs without OCR

### `Marker`

Best fit for true PDF-to-Markdown conversion.

- Strongest option here for layout-aware PDF parsing
- Better suited to headings, reading order, and richer structure
- Heavier operational cost than Poppler tools
- More useful when Markdown structure is actually consumed downstream

### `markitdown`

Useful as a broad document converter, but not the strongest default for PDFs.

- Good breadth across office and media formats
- PDF handling is weaker than a dedicated layout-aware tool
- Better treated as a fallback than the primary PDF path

### `Pandoc`

Excellent document converter, but not a native high-fidelity PDF parser.

- Strong for already-structured inputs like HTML or DOCX
- Not the right primary choice for raw PDF ingestion
- Better as a downstream formatter than the front-line PDF reader

---

## Revisit This Decision If

Re-evaluate the current `pdftotext` choice if NanoClaw starts to require any of the following:

- Markdown output instead of plain text sidecars
- heading or table preservation as part of the feature contract
- first-class support for scanned PDFs via OCR
- downstream agents that actually benefit from preserved PDF structure

If those become requirements, `Marker` should be the first tool to evaluate for the PDF path.
