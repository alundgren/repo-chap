# PR workflow investigation

Status: design proposal, revised 2026-09-16. The shared workflow validator and
offline CLI replay are now implemented; see [their contracts](../workflow-api.md).
No real-PR trial has been performed. Repo Chap targets a CLI, local Electron
visual companion, and private Linux daemon.

Start with the [product brief](../product-brief.md), [specification](specification.md),
[architecture](architecture.md), and [decisions](decisions.md). The
[contracts](contracts.md), [research](research.md), and [runtime notes](runtime-options.md)
explain the proposed file format and implementation evidence.

The [offline presentation](presentation.html) contains an interactive editor
concept and fictional simulation. Download it and open it in a browser. It
uses embedded fonts and requires no server or network. It illustrates part of
an earlier editor direction. The current [desktop companion](../desktop.md)
uses repository files edited by the user's normal agent.

`examples/team-pr/workflow.json` and its Markdown files are a candidate process.
`schemas/` and `examples/results/` document action payloads. These are Repo Chap
files, with no relationship to GitHub Actions workflow syntax.

`presentation.template.html` owns presentation copy and interaction code.
`build_presentation.py` embeds local fonts, their licence, examples, and five
architecture drawings. Mermaid architecture sources remain in architecture.md.
The TypeScript checker, `validate.ts`, validates the examples, local references
and generated presentation through `vp run docs:validate`. Only rebuilding
the presentation requires Python 3.
Run the [root validation commands](../../README.md#check-the-investigation)
after editing the packet. All build inputs and validation dependencies belong
to this repository. The document validator checks only the illustrated subset,
not a future runtime's complete semantics.
