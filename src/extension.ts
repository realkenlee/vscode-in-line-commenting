import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface InlineComment {
  id: string;
  filePath: string;      // relative to workspace root
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  selectedText: string;
  text: string;
  timestamp: string;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function getCommentsFilePath(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, '.vscode');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'inline-comments.json');
}

function loadComments(workspaceRoot: string): InlineComment[] {
  const filePath = getCommentsFilePath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as InlineComment[];
  } catch {
    return [];
  }
}

function saveComments(workspaceRoot: string, comments: InlineComment[]): void {
  const filePath = getCommentsFilePath(workspaceRoot);
  fs.writeFileSync(filePath, JSON.stringify(comments, null, 2), 'utf-8');
}

// ─── Decorations ──────────────────────────────────────────────────────────────

const commentDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
  borderRadius: '2px',
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  after: {
    contentText: ' 💬',
    margin: '0 0 0 2px',
  },
});

function applyDecorations(editor: vscode.TextEditor, comments: InlineComment[], workspaceRoot: string): void {
  const relPath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  const fileComments = comments.filter(c => c.filePath === relPath);

  const decorations: vscode.DecorationOptions[] = fileComments.map(c => {
    const range = new vscode.Range(c.startLine, c.startChar, c.endLine, c.endChar);
    return {
      range,
      hoverMessage: new vscode.MarkdownString(`**Comment:** ${c.text}\n\n*"${c.selectedText}"*\n\n_${new Date(c.timestamp).toLocaleString()}_`),
    };
  });

  editor.setDecorations(commentDecorationType, decorations);
}

function refreshDecorations(comments: InlineComment[], workspaceRoot: string): void {
  for (const editor of vscode.window.visibleTextEditors) {
    applyDecorations(editor, comments, workspaceRoot);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function addComment(workspaceRoot: string, comments: InlineComment[]): Promise<InlineComment[] | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor.');
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage('Please highlight some text first.');
    return;
  }

  const selectedText = editor.document.getText(selection);
  const commentText = await vscode.window.showInputBox({
    prompt: 'Add a comment for the selected text',
    placeHolder: 'Type your comment here...',
    ignoreFocusOut: true,
  });

  if (!commentText) {
    return;
  }

  const relPath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  const newComment: InlineComment = {
    id: crypto.randomUUID(),
    filePath: relPath,
    startLine: selection.start.line,
    startChar: selection.start.character,
    endLine: selection.end.line,
    endChar: selection.end.character,
    selectedText,
    text: commentText,
    timestamp: new Date().toISOString(),
  };

  const updated = [...comments, newComment];
  saveComments(workspaceRoot, updated);
  vscode.window.showInformationMessage(`Comment added: "${commentText}"`);
  return updated;
}

async function deleteComment(workspaceRoot: string, comments: InlineComment[]): Promise<InlineComment[] | undefined> {
  const editor = vscode.window.activeTextEditor;
  const relPath = editor ? path.relative(workspaceRoot, editor.document.uri.fsPath) : undefined;

  // Find comments in current file or all files
  const candidates = relPath
    ? comments.filter(c => c.filePath === relPath)
    : comments;

  if (candidates.length === 0) {
    vscode.window.showInformationMessage('No comments in this file.');
    return;
  }

  const items: vscode.QuickPickItem[] = candidates.map(c => ({
    label: `$(comment) ${c.text}`,
    description: `line ${c.startLine + 1}: "${c.selectedText.slice(0, 40)}${c.selectedText.length > 40 ? '…' : ''}"`,
    detail: c.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select comment to delete',
    matchOnDescription: true,
  });

  if (!picked || !picked.detail) {
    return;
  }

  const updated = comments.filter(c => c.id !== picked.detail);
  saveComments(workspaceRoot, updated);
  vscode.window.showInformationMessage('Comment deleted.');
  return updated;
}

function showAllComments(comments: InlineComment[]): void {
  if (comments.length === 0) {
    vscode.window.showInformationMessage('No comments yet. Highlight text and press Ctrl+Alt+M to add one.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'inlineComments',
    'Inline Comments',
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );

  const rows = comments
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
    .map(c => `
      <tr>
        <td class="file">${escapeHtml(c.filePath)}</td>
        <td class="line">${c.startLine + 1}</td>
        <td class="selected">"${escapeHtml(c.selectedText.slice(0, 60))}${c.selectedText.length > 60 ? '…' : ''}"</td>
        <td class="comment">${escapeHtml(c.text)}</td>
        <td class="time">${new Date(c.timestamp).toLocaleDateString()}</td>
      </tr>`)
    .join('');

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h2 { margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 6px 8px; background: var(--vscode-editor-lineHighlightBackground); border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  .file { color: var(--vscode-textLink-foreground); font-size: 11px; }
  .line { color: var(--vscode-editorLineNumber-foreground); font-size: 11px; white-space: nowrap; }
  .selected { color: var(--vscode-descriptionForeground); font-style: italic; }
  .comment { font-weight: 500; }
  .time { font-size: 11px; white-space: nowrap; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h2>💬 Inline Comments (${comments.length})</h2>
<table>
  <thead><tr><th>File</th><th>Line</th><th>Selected Text</th><th>Comment</th><th>Date</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  let comments = loadComments(workspaceRoot);

  // Initial decoration pass
  refreshDecorations(comments, workspaceRoot);

  // Re-apply decorations when switching editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        applyDecorations(editor, comments, workspaceRoot);
      }
    })
  );

  // Re-apply when a document is saved (content may have shifted)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      refreshDecorations(comments, workspaceRoot);
    })
  );

  // ── Add Comment ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.addComment', async () => {
      const updated = await addComment(workspaceRoot, comments);
      if (updated) {
        comments = updated;
        refreshDecorations(comments, workspaceRoot);
      }
    })
  );

  // ── Delete Comment ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.deleteComment', async () => {
      const updated = await deleteComment(workspaceRoot, comments);
      if (updated) {
        comments = updated;
        refreshDecorations(comments, workspaceRoot);
      }
    })
  );

  // ── Show All ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.showAll', () => {
      showAllComments(comments);
    })
  );

  // ── Clear All ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.clearAll', async () => {
      const confirm = await vscode.window.showWarningMessage(
        `Delete all ${comments.length} comment(s)?`,
        { modal: true },
        'Delete All'
      );
      if (confirm === 'Delete All') {
        comments = [];
        saveComments(workspaceRoot, comments);
        refreshDecorations(comments, workspaceRoot);
        vscode.window.showInformationMessage('All comments cleared.');
      }
    })
  );
}

export function deactivate(): void {}
