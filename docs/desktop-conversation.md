# Conversation belongs in your agent

Use your existing Codex session in the repository and the globally installed
`repo-chap-workflows` skill. Your usual model, login, repository instructions,
and tools apply. Electron has no conversation view or provider setup.

The agent edits files normally and steers Electron through `repo-chap desktop`.
The app displays workflow structure, simulation results, and temporary visual
explanations. See [the desktop guide](desktop.md).

Existing private app conversation files are left on disk and are not loaded by
the companion. The retained [conversation adapter library](conversation-adapters.md)
is separate from the current desktop application.
