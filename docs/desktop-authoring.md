# Workflow authoring with your agent

Install `repo-chap-workflows` globally with `repo-chap skill install`. Run your
normal agent in the repository being configured. The skill teaches the workflow
format, validation, replay, and local desktop commands. Source files remain
ordinary JSON and Markdown, and edits go directly to disk.

The desktop refreshes those files and shows the current workflow. The agent can
navigate, simulate, highlight rules or actions, and display temporary arrows.
See [the companion guide](desktop.md) for installation and commands, and
[shared workflow contracts](workflow-api.md) for validation and test expectations.

The former staged editor operations and embedded conversation API have been
removed. Provider adapters used by CLI analysis and the daemon retain their
existing contracts. Workflow schemas and daemon activation are unchanged.
