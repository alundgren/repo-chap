# UX notes for Repo Chap

The current UI is an offline investigation presentation with an editor concept.
There is no production Electron UI yet. Its task is to explain PR automation
and let an engineer try a bounded edit and fictional simulation on a laptop.

The presentation uses warm paper, IBM Plex Sans for reading, and IBM Plex Mono
for source and identifiers. Font assets and their licence are local. Body text
is 16px, supporting text 13.5px, and headings scale with viewport size. Regular
and semibold are the only reading weights.

| Existing presentation role | Value |
| --- | --- |
| Background | #F2EADE |
| Surface | #EADFCD |
| Raised selection | #E0D2BD |
| Text | #604939 |
| Accent | #784F26 |
| Links and focus | #3D5D71 |

Components are slide navigation, reading view, action inspector, JSON editor,
staged-change status, scenario controls, decision trace, reset, and export.
The narrow layout places the inspector below the process. Architecture drawings
scroll within their region. This is intentional so diagram labels stay readable.
Semantic tokens in presentation.template.html bind the current roles.

Implementation should record its actual desktop UI choices here as components
ship. The existing browser check verifies navigation, editing, invalid input,
reset, export, offline operation, and laptop/narrow layouts. Generated browser
evidence stays outside Git.
