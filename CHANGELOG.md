# Changelog

All notable changes to @openmoca/moca-convert. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-11-11

### Changed

- New packages declare `mocaVersion` `0.6` (moca-spec 0.6.0).
- NOTICE gives the full name: Modular Ontology, Content & Attestation.

## [0.5.0] - Not published

The first release from this repository. It was previously part of moca-spec at 0.4.0-alpha.1.

### Added

- The `directory` adapter writes the folders as the package's structure
  (`structure.ttl`): a concept for the package, each folder and each file,
  parts by `dct:hasPart`, and each folder's order by name as an ordered
  collection. A folder is labelled by its `index.md` or README title, else by
  its name without a leading order number. Each file's node is bound to its
  concept, unless its frontmatter already has a `moca` block (a
  `STRUCTURE_NOT_BOUND` warning). `--no-structure` keeps the previous output.
- A `youtube` adapter that converts a YouTube capture folder (one node per
  video, with its description under `sources/`, WebVTT captions under
  `media/`, chapter time-range evidence, and a `structure.ttl` in playlist
  order for a playlist), and a `moca-youtube` command that captures a video
  or playlist with yt-dlp and runs the conversion. Adapters can now add files
  under `sources/` and `media/`, and `structure.ttl`.
- A `pdf` adapter (using Mozilla's pdf.js) that converts a PDF, a folder of
  PDFs, or a folder with a `pdfs.json` listing documents in order with their
  URLs and SHA-256 digests. Each document becomes a node per section; each
  node cites its pages as RFC 3778 `page=` evidence, and `structure.ttl` keeps
  documents and sections in order. `--sources copy` (default) carries the PDFs
  under `sources/`; `--sources link` cites them by URL.
