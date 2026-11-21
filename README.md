# @openmoca/moca-convert

Creates MOCA packages from existing sources, including PDFs and YouTube
videos and playlists. Every node it writes is an OKF
concept document with a `type`, and the package id must be an absolute URI.

```sh
moca-convert <input> -o <dir> --id <uri> [--title text] [--version semver] [--type type]
             [--language bcp47] [--license spdx] [--from directory|markdown|obsidian|openapi|pdf|youtube]
             [--exclude glob...] [--chunker operation|tag] [--min-description-ratio 0-1]
             [--sources copy|link] [--max-pdf-mb n] [--max-pdf-pages n] [--pdf-timeout seconds]
             [--force] [--strict] [--format text|json] [--log-file file]
```

| Adapter | Input | Default `type` |
| --- | --- | --- |
| `directory` | A folder of Markdown, structure preserved: the folders become `structure.ttl` (parts and folder order), each file bound to its concept; `--no-structure` to leave it out | `Document` |
| `markdown` | One file or a glob; names from titles | `Document` |
| `obsidian` | A vault (has `.obsidian/`); wikilinks become Markdown links | `Note` |
| `openapi` | An OpenAPI 3.x document with real descriptions | `API Operation` or `API Tag` |
| `pdf` | A PDF, a folder of PDFs, or a folder with a `pdfs.json` | `Document` |
| `youtube` | A capture folder written by `moca-youtube` | `Video` |

- Existing frontmatter is kept byte for byte. A file without a `type` gets
  `type` (and `title`, if missing) added at the top of its frontmatter.
- The adapter is detected from the input unless `--from` is given; ambiguous
  input is refused, not guessed.
- Hidden files and folders (`.git/`, `.obsidian/`, Obsidian's `.trash/` of
  deleted notes) and symbolic links in an input folder are not read.
- Obsidian wikilinks are rewritten in the note's body only, never in its
  front matter, and each link target is percent-encoded.
- OpenAPI: each operation's parameters include its path's and those it
  references (`$ref`). Schema references are expanded up to 1,000 objects a
  schema; beyond that they are shown as `{"$ref": ...}`. Two operations whose
  paths give the same file name get distinct files (`get-a-b.md`,
  `get-a-b-2.md`).
- Output is written to a folder beside `-o`, read back with the reference
  Reader, and only then moved into place. If it would be invalid, nothing is
  written.
- `--force` replaces an output folder only when it holds a previous package
  (it has a `moca.json`); it refuses any other folder. The previous package is
  moved aside, the new one moved in, and only then is the old one deleted.
- `--log-file <file>` records the adapter, timings and any failure, on every
  exit.

## PDF

PDFs with a text layer become one node per section:

- Headings come from the PDF's bookmarks when they cover the document, and
  otherwise from the type: sizes clearly larger than the body text are
  heading levels, and a whole line in bold at body size is one level below.
  A document is split at the first heading level that occurs more than once
  (the sections of a chapter, or the chapters of a book); deeper headings stay
  inside the node, where `moca-index --chunk headings` can split them.
- Running headers and footers, page numbers and small figure labels are
  dropped. Paragraphs run on across columns and pages, words hyphenated at a
  line end are rejoined, and bullets, numbered items and figure captions are
  kept as lists and captions.
- Each node cites every page it came from as an RFC 3778 `page=` fragment,
  with the printed page number (`p. 4-12`) as the note when the PDF has page
  labels or prints numbers in its footer. `structure.ttl` keeps the documents
  and their sections in order, and each node is bound to its section.
- `--sources copy` (the default) puts each PDF under `sources/`, so the
  package is `self-contained-evidence`. `--sources link` cites each PDF by
  its `url` instead, for PDFs too large to carry.
- A PDF without a text layer (a scan) is reported and left out; run OCR on
  it first.
- A PDF over 256 MB or 2,000 pages, or that takes over 10 minutes to read, is
  refused; `--max-pdf-mb`, `--max-pdf-pages` and `--pdf-timeout` raise the
  limits.
- Text from the PDF itself (headings, paragraphs, page labels) is written as
  text: characters Markdown would read as links or HTML are escaped. Page
  labels are kept short and on one line.

A folder may list its documents, in order, in `pdfs.json`:

```json
{
  "title": "Workshop Manual",
  "description": "Brakes and torque settings.",
  "documents": [
    { "file": "ch7.pdf", "title": "Chapter 7: Brakes", "url": "https://example.com/ch7.pdf", "sha256": "…" }
  ]
}
```

Only `file` is required: a regular file inside the folder, not a symbolic
link. `title` falls back to the PDF's own title. `url` is the published copy
that `--sources link` cites: an `http` or `https` URL with no user name,
password or `#fragment`, parsed and written back in its normal form. A file whose SHA-256 is
not `sha256` is refused, so a conversion never silently uses a changed
document. Without `pdfs.json`, every PDF in the folder is converted in path
order. moca-spec's [`scripts/fetch-pdfs.mjs`](https://github.com/openmoca/moca-spec/blob/main/scripts/fetch-pdfs.mjs) downloads the
listed files and pins their digests.

See [`examples/pdf`](https://github.com/openmoca/moca-spec/blob/main/examples/pdf).

## YouTube

`moca-youtube` captures a video or a playlist with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), which must be installed, and then
runs `moca-convert --from youtube` on the capture:

```sh
moca-youtube <url> -o <dir> --id <uri> [--title text] [--version semver] [--type type]
             [--language bcp47] [--license spdx] [--capture-dir dir] [--no-convert]
             [--yt-dlp path] [--force] [--quiet]
```

- Each video becomes one node: its description, and a transcript from its
  captions grouped by chapter. The captions are written under `media/` as
  WebVTT and the description under `sources/`, and the node cites each
  chapter as a time range (`t=start,end`) and quotes the description, so the
  package is `self-contained-evidence`. The node describes the video in
  `moca.media`: its page's type (`text/html`), its length and its captions, so
  the last chapter can run past the last caption.
- A playlist also gets `content/index.md` and a `structure.ttl` that keeps the
  videos in playlist order.
- Captions the creator supplied in `--language` (default `en`) are preferred,
  then YouTube's automatic ones. A video without captions is kept, without a
  transcript, and reported.
- `--capture-dir` keeps the capture (`youtube-capture.json` and
  `videos/<id>/`); converting it again gives the same package. Without it the
  capture goes to a temporary directory.
- yt-dlp is run directly, without a shell, so this works on macOS, Linux and
  Windows. Point at it with `--yt-dlp` or `$YT_DLP` when it is not on `PATH`.
  It runs with `--ignore-config`, so your yt-dlp configuration files are not
  used, and each run is stopped after 5 minutes.
- The URL must be on `youtube.com` (with `www.`, `m.` or `music.`) or
  `youtu.be`. Video and playlist ids must be plain ids (letters, digits, `-`
  and `_`); an entry with any other id is skipped and reported.
- When a capture is converted, it is checked as it is read: video ids, URLs
  (parsed and rebuilt; `http` and `https` only), the upload date and the
  caption language. A value that fails is left out, or the capture is
  refused.

See [`examples/youtube`](https://github.com/openmoca/moca-spec/blob/main/examples/youtube).

## Develop

The tests read moca-spec's examples and fixtures. Check out moca-spec beside
this repository, or set `MOCA_SPEC_DIR`. CI uses the tags pinned at the top of `.github/workflows/test.yml`
(`MOCA_SPEC_REF` and the like); check out the same tags to match it.

```sh
npm install
npm test
```

## Release

1. Publish `@openmoca/moca-core` first if it changed.
2. Name its released range in `package.json` in place of the `file:` path,
   and run `npm install`.
3. Add a dated section to [CHANGELOG.md](CHANGELOG.md) and update the version.
4. Point the `MOCA_*_REF` pins in `.github/workflows/test.yml` at the release tags
   ([moca-spec docs/releasing.md](https://github.com/openmoca/moca-spec/blob/main/docs/releasing.md#moving-the-pins)).
5. `npm test` passes.
6. Tag `vX.Y.Z` on main and publish a GitHub release whose notes are the
   changelog section. The release workflow publishes to npm through trusted
   publishing, with provenance; it stops if the tag is not on main, the
   version does not match, or `@openmoca/moca-core` is not on npm.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenMOCA™ is a trade mark of PI & Mash Solutions Ltd. The licence covers the
code, not the name: see the
[trade mark policy](https://github.com/openmoca/moca-spec/blob/main/TRADEMARKS.md).
