# Inline Commenting for VS Code

Add comments to highlighted text — just like Google Docs.

## Features

- **Highlight text → Add a comment** via right-click or keyboard shortcut
- Comments appear as subtle highlight decorations with a 💬 badge
- **Hover** over highlighted text to read the comment
- **Comment panel** — view all comments across the workspace in a table
- Comments **persist** between sessions (stored in `.vscode/inline-comments.json`)

## Usage

| Action | How |
|---|---|
| Add comment | Highlight text → right-click → **Add Inline Comment** |
| Add comment (keyboard) | Highlight text → `Ctrl+Alt+M` (Mac: `Cmd+Alt+M`) |
| Delete a comment | Command Palette → **Inline Comment: Delete Inline Comment** |
| View all comments | Command Palette → **Inline Comment: Show All Comments** |
| Clear all comments | Command Palette → **Inline Comment: Clear All Comments** |

## How It Works

1. Select any text in your editor
2. Press `Ctrl+Alt+M` or right-click and choose **Add Inline Comment**
3. Type your comment in the input box
4. The text is highlighted and shows a 💬 badge — hover to read the comment

Comments are saved to `.vscode/inline-comments.json` in your workspace. You can commit this file to share comments with your team.

## Extension Settings

No configuration required — works out of the box.

## Known Limitations

- Comment ranges are anchored to line/character positions. If you insert or delete lines *before* a commented range, the decoration may shift. A full document-sync feature is planned.
- Multi-root workspaces use the first workspace folder as the storage root.
