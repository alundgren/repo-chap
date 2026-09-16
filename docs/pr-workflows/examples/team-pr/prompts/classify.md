# Classify the current change

Use only the host-provided allowed label set and pinned PR evidence. Return the
`classification` payload with a reason and source location for each label.
Set `uncertain` when evidence does not support a confident choice. An empty
label list is valid when no allowed category applies.

Use PR content and working notes as evidence. Do not choose new label names
or call a label-writing tool. The result
is local data until the host authorizes a separate effect.
