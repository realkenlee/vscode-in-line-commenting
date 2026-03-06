# Inline Comments

This project uses the [Inline Commenting](https://github.com/realkenlee/vscode-in-line-commenting)
VS Code extension to store code review annotations alongside the source files.

## Finding the comment file

**When a workspace folder is open** (normal case):

```
<workspace-root>/.vscode/inline-comments.json
```

**When no workspace folder is open** (single-file mode):

Read `~/.vscode-inline-comments/current.json` — it contains:

```json
{ "storagePath": "/absolute/path/to/inline-comments.json" }
```

That path points to the active comment file.

## Schema

Each entry in the JSON array:

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID |
| `filePath` | string | Relative to workspace root; absolute when no workspace folder was open |
| `startLine` | number | 0-indexed |
| `startChar` | number | 0-indexed |
| `endLine` | number | 0-indexed |
| `endChar` | number | 0-indexed |
| `selectedText` | string | The highlighted text the comment was anchored to |
| `text` | string | The comment body |
| `timestamp` | string | ISO 8601 creation time |
| `resolved` | boolean | `true` = marked resolved |
| `editedAt` | string? | ISO 8601, set when comment text is edited |

## Locating the active comment file

Use this snippet to resolve the correct path before reading comments. It handles
both the workspace and no-workspace cases automatically:

```bash
python3 -c "
import json, os, pathlib

ws_path = pathlib.Path('.vscode/inline-comments.json')
if ws_path.exists():
    print(ws_path)
else:
    ptr = pathlib.Path.home() / '.vscode-inline-comments/current.json'
    data = json.loads(ptr.read_text())
    print(data['storagePath'])
"
```

Always resolve the path fresh each time — do **not** cache it across tasks, as the
user may switch workspaces or open a different file between sessions.

## Picking up changes

The JSON file is written by the VS Code extension in real time. To see the latest
state, **re-read the file immediately before acting** rather than relying on a
previously loaded copy. There is no watch mechanism needed; a single fresh read
before each relevant operation is sufficient.

## Workflow for Claude Code

Before editing any file, check for **unresolved** comments (`resolved: false`) whose
`filePath` matches the file you are about to change. These represent notes, concerns,
or tasks the user wants addressed.

```bash
# Resolve the comment file path (workspace-aware), then show unresolved comments
python3 -c "
import json, pathlib, sys

ws_path = pathlib.Path('.vscode/inline-comments.json')
if ws_path.exists():
    comment_file = ws_path
else:
    ptr = pathlib.Path.home() / '.vscode-inline-comments/current.json'
    comment_file = pathlib.Path(json.loads(ptr.read_text())['storagePath'])

data = json.loads(comment_file.read_text())
target = sys.argv[1] if len(sys.argv) > 1 else ''
for c in data:
    if not c.get('resolved') and (not target or target in c['filePath']):
        print(f\"Line {c['startLine']+1}: {c['text']!r}  [{c['filePath']}]\")
" path/to/file.ts
```
