# Third-Party Licenses

This document lists notable third-party software redistributed inside
the Marginalia Docker image (or otherwise shipped as a binary
artifact). Source-only npm/cargo dependencies are covered by their
respective package metadata and aren't listed individually here.

## mmdr — `mermaid-rs-renderer`

- Crate: <https://crates.io/crates/mermaid-rs-renderer>
- Source: <https://github.com/1jehuang/mermaid-rs-renderer>
- Version pinned in `Dockerfile` via `MMDR_VERSION` build arg.
- License: **MIT**

Used by the DOCX exporter (`apps/server/src/export/mermaid-rust.ts`)
to rasterize mermaid diagrams to PNG inside the runtime container.

### Transitive dependencies

The mmdr binary statically links the following Rust crates (all MIT,
Apache-2.0, or MIT/Apache-2.0 dual-licensed). No copyleft licenses
(GPL, LGPL, MPL) are involved.

| Crate         | License             |
|---------------|---------------------|
| `resvg`       | MIT OR Apache-2.0   |
| `usvg`        | MIT OR Apache-2.0   |
| `clap`        | MIT OR Apache-2.0   |
| `anyhow`      | MIT OR Apache-2.0   |
| `fontdb`      | MIT OR Apache-2.0   |
| `ttf-parser`  | MIT OR Apache-2.0   |
| `regex`       | MIT OR Apache-2.0   |
| `serde`       | MIT OR Apache-2.0   |
| `serde_json`  | MIT OR Apache-2.0   |
| `thiserror`   | MIT OR Apache-2.0   |
| `once_cell`   | MIT OR Apache-2.0   |
| `json5`       | ISC                 |

### Attribution

Per the MIT terms, the upstream copyright notice and license text are
preserved. The full text of the MIT license is bundled with the
mermaid-rs-renderer source distribution on crates.io and at the
GitHub repository linked above. A copy is reproduced here for the
runtime image:

```
MIT License

Copyright (c) 2026 Jeremy Huang

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Verify against the upstream `LICENSE` file when bumping
`MMDR_VERSION`; the boilerplate above is reproduced from the project
README's license declaration as of v0.2.2.)
