import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

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
  resolved: boolean;
  editedAt?: string;     // ISO string, set on inline edit
}

type Draft = {
  filePath: string;
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  selectedText: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Storage ──────────────────────────────────────────────────────────────────

// When workspaceRoot is defined, comments live in <workspaceRoot>/.vscode/inline-comments.json
// and filePaths inside are relative to workspaceRoot.
// When workspaceRoot is undefined (no folder open), storageRoot is globalStorageUri.fsPath,
// comments live at <storageRoot>/inline-comments.json, and filePaths are absolute.

function getCommentsFilePath(storageRoot: string, workspaceRoot: string | undefined): string {
  if (workspaceRoot) {
    const dir = path.join(workspaceRoot, '.vscode');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'inline-comments.json');
  }
  if (!fs.existsSync(storageRoot)) {
    fs.mkdirSync(storageRoot, { recursive: true });
  }
  return path.join(storageRoot, 'inline-comments.json');
}

// Write a pointer file so Claude Code (and other tools) can find the active
// storage when no workspace folder is open and .vscode/inline-comments.json
// doesn't exist.
function writePointerFile(commentsFilePath: string): void {
  try {
    const dir = path.join(os.homedir(), '.vscode-inline-comments');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dir, 'current.json'),
      JSON.stringify({ storagePath: commentsFilePath }, null, 2),
      'utf-8'
    );
  } catch {
    // non-fatal — pointer file is a convenience for external tools
  }
}

function loadComments(storageRoot: string, workspaceRoot: string | undefined): InlineComment[] {
  const filePath = getCommentsFilePath(storageRoot, workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<InlineComment>[];
    return raw.map(c => ({
      ...c,
      resolved: c.resolved ?? false,
    })) as InlineComment[];
  } catch {
    return [];
  }
}

function saveComments(storageRoot: string, workspaceRoot: string | undefined, comments: InlineComment[]): void {
  const filePath = getCommentsFilePath(storageRoot, workspaceRoot);
  fs.writeFileSync(filePath, JSON.stringify(comments, null, 2), 'utf-8');
}

// Resolve a stored filePath to an absolute path on disk.
function resolveFilePath(filePath: string, workspaceRoot: string | undefined): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(workspaceRoot!, filePath);
}

// Convert an absolute file path to the form stored in the JSON.
function makeStoredPath(absPath: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) {
    return absPath; // store absolute when no workspace
  }
  return path.relative(workspaceRoot, absPath);
}

// ─── Decorations ──────────────────────────────────────────────────────────────

// Active comment — highlight + ● glyph
const commentDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  borderRadius: '2px',
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  after: {
    contentText: ' \u25cf',
    color: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
    margin: '0 0 0 2px',
  },
});

// Resolved — dimmed + ✓ glyph
const resolvedDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
  opacity: '0.5',
  borderRadius: '2px',
  after: {
    contentText: ' \u2713',
    color: '#4CAF50',
    margin: '0 0 0 2px',
  },
});

function applyDecorations(editor: vscode.TextEditor, comments: InlineComment[], workspaceRoot: string | undefined): void {
  const absPath = editor.document.uri.fsPath;
  const fileComments = comments.filter(c => resolveFilePath(c.filePath, workspaceRoot) === absPath);

  const activeDecos: vscode.DecorationOptions[] = [];
  const resolvedDecos: vscode.DecorationOptions[] = [];

  for (const c of fileComments) {
    const range = new vscode.Range(c.startLine, c.startChar, c.endLine, c.endChar);
    const resolveLabel = c.resolved ? 'Unresolve' : 'Resolve';
    const args = encodeURIComponent(JSON.stringify([{ id: c.id }]));
    const hover = new vscode.MarkdownString(
      `**Comment:** ${c.text}\n\n*"${c.selectedText}"*\n\n_${new Date(c.timestamp).toLocaleString()}_` +
      `\n\n[$(check) ${resolveLabel}](command:inlineComment.resolveById?${args})` +
      `\u00a0\u00a0[$(trash) Delete](command:inlineComment.deleteById?${args})`,
      true
    );
    hover.isTrusted = true;
    const deco: vscode.DecorationOptions = { range, hoverMessage: hover };

    if (c.resolved) {
      resolvedDecos.push(deco);
    } else {
      activeDecos.push(deco);
    }
  }

  editor.setDecorations(commentDecorationType, activeDecos);
  editor.setDecorations(resolvedDecorationType, resolvedDecos);
}

function refreshDecorations(comments: InlineComment[], workspaceRoot: string | undefined): void {
  for (const editor of vscode.window.visibleTextEditors) {
    applyDecorations(editor, comments, workspaceRoot);
  }
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────

let commentsPanel: vscode.WebviewPanel | undefined;

function getOrCreatePanel(): vscode.WebviewPanel {
  if (commentsPanel) {
    commentsPanel.reveal(vscode.ViewColumn.Beside);
    return commentsPanel;
  }
  commentsPanel = vscode.window.createWebviewPanel(
    'inlineComments',
    'Inline Comments',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  commentsPanel.onDidDispose(() => { commentsPanel = undefined; });
  return commentsPanel;
}

function buildDraftCard(draft: Draft): string {
  return `
  <div class="card draft-card" id="draft-card">
    <div class="card-header">
      <span class="draft-badge">NEW</span>
      <span class="location">Line ${draft.startLine + 1} &middot; <span class="filename">${escapeHtml(path.basename(draft.filePath))}</span></span>
    </div>
    <div class="selected-text">&ldquo;${escapeHtml(draft.selectedText.slice(0, 120))}${draft.selectedText.length > 120 ? '&hellip;' : ''}&rdquo;</div>
    <textarea id="draft-text" class="draft-input" placeholder="Write a comment..." rows="3"></textarea>
    <div class="draft-actions">
      <button id="draft-submit" class="btn-primary">Submit</button>
      <button id="draft-cancel" class="btn-secondary">Cancel</button>
    </div>
  </div>`;
}

function buildCommentCard(c: InlineComment): string {
  const borderColor = c.resolved ? '#4CAF50' : 'var(--vscode-textLink-activeForeground, #007acc)';
  const cardOpacity = c.resolved ? 'opacity: 0.55;' : '';
  const commentTextStyle = c.resolved ? 'text-decoration: line-through; opacity: 0.7;' : '';
  const checked = c.resolved ? 'checked' : '';
  const resolveTitle = c.resolved ? 'Mark unresolved' : 'Mark resolved';
  const editedMark = c.editedAt ? ` &middot; <span class="edited-badge">edited</span>` : '';
  const id = escapeHtml(c.id);
  const file = escapeHtml(path.basename(c.filePath));
  const sel = escapeHtml(c.selectedText.slice(0, 80)) + (c.selectedText.length > 80 ? '&hellip;' : '');
  const text = escapeHtml(c.text);
  const date = formatDate(c.timestamp);

  return `<div class="card" data-id="${id}" style="border-left-color:${borderColor}; ${cardOpacity}">
  <div class="card-header">
    <input type="checkbox" class="resolve-cb" data-id="${id}" ${checked} title="${resolveTitle}">
    <span class="location">Line ${c.startLine + 1} &middot; <span class="filename">${file}</span></span>
    <div class="card-actions">
      <button class="btn-icon edit-btn" data-id="${id}" title="Edit">&#10002;</button>
      <button class="btn-icon delete-btn" data-id="${id}" title="Delete">&#10005;</button>
    </div>
  </div>
  <div class="comment-body" data-id="${id}">
    <span class="sel-text">&ldquo;${sel}&rdquo;</span>
    <span class="comment-text" style="${commentTextStyle}">${text}</span>
    <span class="card-meta">${date}${editedMark}</span>
  </div>
  <div class="edit-area" id="edit-${id}" style="display:none;">
    <textarea class="draft-input edit-textarea" data-id="${id}" rows="3">${escapeHtml(c.text)}</textarea>
    <div class="draft-actions">
      <button class="btn-primary edit-save" data-id="${id}">Save</button>
      <button class="btn-secondary edit-cancel" data-id="${id}">Cancel</button>
    </div>
  </div>
</div>`;
}

function buildPanelHtml(comments: InlineComment[], draft?: Draft): string {
  const sorted = [...comments].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine
  );

  const draftHtml = draft ? buildDraftCard(draft) : '';
  const cardsHtml = sorted.length === 0 && !draft
    ? `<div class="empty">No comments yet.<br>Highlight text and press <kbd>Cmd+Alt+M</kbd> to add one.</div>`
    : sorted.map(c => buildCommentCard(c)).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    padding: 12px 10px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    min-height: 100vh;
  }
  h2 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 10px;
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .empty {
    color: var(--vscode-descriptionForeground);
    text-align: center;
    margin-top: 48px;
    line-height: 1.8;
    font-size: 12px;
  }
  .empty kbd {
    background: var(--vscode-keybindingLabel-background);
    border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-panel-border));
    border-radius: 3px;
    padding: 1px 5px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .card {
    background: var(--vscode-editor-background);
    border-left: 3px solid var(--vscode-textLink-activeForeground, #007acc);
    border-radius: 4px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    margin-bottom: 5px;
    padding: 5px 8px 4px;
  }
  .draft-card {
    border-left-color: var(--vscode-textLink-foreground, #3794ff);
    border-left-width: 4px;
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 2px;
  }
  .resolve-cb { cursor: pointer; flex-shrink: 0; }
  .location {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .filename { color: var(--vscode-textLink-foreground); }
  .card-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .card:hover .card-actions { opacity: 1; }
  .comment-body {
    padding-left: 18px;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 5px;
    flex-wrap: wrap;
    line-height: 1.5;
  }
  .sel-text {
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100px;
    flex-shrink: 0;
  }
  .comment-text {
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
    color: var(--vscode-foreground);
    flex: 1;
    min-width: 40px;
  }
  .card-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    margin-left: auto;
    flex-shrink: 0;
  }
  .edited-badge {
    font-style: italic;
    opacity: 0.8;
  }
  .draft-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(55, 148, 255, 0.2);
    color: var(--vscode-textLink-foreground, #3794ff);
    border: 1px solid rgba(55, 148, 255, 0.4);
    flex-shrink: 0;
  }
  .selected-text {
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-top: 4px;
    margin-bottom: 6px;
    line-height: 1.4;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    padding: 1px 3px;
    border-radius: 3px;
    line-height: 1;
  }
  .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .edit-area { padding-top: 4px; }
  .draft-input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    resize: vertical;
    margin-bottom: 6px;
    outline: none;
  }
  .draft-input:focus { border-color: var(--vscode-focusBorder); }
  .draft-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, var(--vscode-editor-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
  }
  .btn-secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
</style>
</head>
<body>
<h2>Comments (${comments.length})</h2>
${draftHtml}
${cardsHtml}
<script>
  const vscodeApi = acquireVsCodeApi();

  // ── Resolve state helper (optimistic DOM update) ──
  function applyResolvedState(card, resolved) {
    card.style.opacity = resolved ? '0.55' : '';
    card.style.borderLeftColor = resolved
      ? '#4CAF50'
      : 'var(--vscode-textLink-activeForeground, #007acc)';
    const ct = card.querySelector('.comment-text');
    if (ct) {
      ct.style.textDecoration = resolved ? 'line-through' : '';
      ct.style.opacity = resolved ? '0.7' : '';
    }
  }

  // ── Draft card ──
  document.getElementById('draft-submit')?.addEventListener('click', () => {
    const textEl = document.getElementById('draft-text');
    const text = textEl?.value?.trim();
    if (!text) return;
    vscodeApi.postMessage({ action: 'submitDraft', text });
  });

  document.getElementById('draft-cancel')?.addEventListener('click', () => {
    vscodeApi.postMessage({ action: 'cancelDraft' });
  });

  // ── Navigate on comment body click ──
  document.querySelectorAll('.comment-body').forEach(el => {
    el.addEventListener('click', () => {
      vscodeApi.postMessage({ action: 'navigate', commentId: el.dataset.id });
    });
  });

  // ── Resolve checkboxes (optimistic) ──
  document.querySelectorAll('.resolve-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const card = cb.closest('.card');
      if (card) { applyResolvedState(card, cb.checked); }
      vscodeApi.postMessage({ action: 'resolve', commentId: cb.dataset.id, resolved: cb.checked });
    });
  });

  // ── Delete button (optimistic) ──
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const card = btn.closest('.card');
      card?.remove();
      const count = document.querySelectorAll('.card:not(.draft-card)').length;
      const h2 = document.querySelector('h2');
      if (h2) { h2.textContent = 'Comments (' + count + ')'; }
      if (count === 0 && !document.getElementById('draft-card')) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = 'No comments yet.<br>Highlight text and press <kbd>Cmd+Alt+M</kbd> to add one.';
        h2?.after(empty);
      }
      vscodeApi.postMessage({ action: 'delete', commentId: btn.dataset.id });
    });
  });

  // ── Edit button ──
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const editArea = document.getElementById('edit-' + id);
      const commentBody = document.querySelector('.comment-body[data-id="' + id + '"]');
      if (editArea && commentBody) {
        commentBody.style.display = 'none';
        editArea.style.display = 'block';
        editArea.querySelector('.edit-textarea')?.focus();
      }
    });
  });

  // ── Edit cancel ──
  document.querySelectorAll('.edit-cancel').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const editArea = document.getElementById('edit-' + id);
      const commentBody = document.querySelector('.comment-body[data-id="' + id + '"]');
      if (editArea && commentBody) {
        editArea.style.display = 'none';
        commentBody.style.display = 'flex';
      }
    });
  });

  // ── Edit save (optimistic) ──
  document.querySelectorAll('.edit-save').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const textarea = document.querySelector('.edit-textarea[data-id="' + id + '"]');
      const newText = textarea?.value?.trim();
      if (!newText) return;
      const commentBody = document.querySelector('.comment-body[data-id="' + id + '"]');
      const commentText = commentBody?.querySelector('.comment-text');
      if (commentText) { commentText.textContent = newText; }
      const meta = commentBody?.querySelector('.card-meta');
      if (meta && !meta.querySelector('.edited-badge')) {
        const sep = document.createTextNode(' \u00b7 ');
        const badge = document.createElement('span');
        badge.className = 'edited-badge';
        badge.textContent = 'edited';
        meta.appendChild(sep);
        meta.appendChild(badge);
      }
      const editArea = document.getElementById('edit-' + id);
      if (editArea && commentBody) {
        editArea.style.display = 'none';
        commentBody.style.display = 'flex';
      }
      vscodeApi.postMessage({ action: 'edit', commentId: id, text: newText });
    });
  });
</script>
</body>
</html>`;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigateTo(comment: InlineComment, workspaceRoot: string | undefined): Promise<void> {
  const absPath = resolveFilePath(comment.filePath, workspaceRoot);
  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const range = new vscode.Range(comment.startLine, comment.startChar, comment.endLine, comment.endChar);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ─── Delete Comment (QuickPick) ───────────────────────────────────────────────

async function deleteComment(storageRoot: string, workspaceRoot: string | undefined, comments: InlineComment[]): Promise<InlineComment[] | undefined> {
  const editor = vscode.window.activeTextEditor;
  const storedPath = editor ? makeStoredPath(editor.document.uri.fsPath, workspaceRoot) : undefined;
  const candidates = storedPath ? comments.filter(c => c.filePath === storedPath) : comments;

  if (candidates.length === 0) {
    vscode.window.showInformationMessage('No comments in this file.');
    return;
  }

  const items: vscode.QuickPickItem[] = candidates.map(c => ({
    label: `$(comment) ${c.text}`,
    description: `line ${c.startLine + 1}: "${c.selectedText.slice(0, 40)}${c.selectedText.length > 40 ? '\u2026' : ''}"`,
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
  saveComments(storageRoot, workspaceRoot, updated);
  vscode.window.showInformationMessage('Comment deleted.');
  return updated;
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot: string | undefined = workspaceFolders?.[0]?.uri.fsPath;
  const storageRoot = context.globalStorageUri.fsPath;

  const commentsFilePath = getCommentsFilePath(storageRoot, workspaceRoot);
  writePointerFile(commentsFilePath);

  let comments = loadComments(storageRoot, workspaceRoot);
  let currentDraft: Draft | undefined;
  let panelHandlerRegistered = false;

  refreshDecorations(comments, workspaceRoot);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      if (editor) {
        applyDecorations(editor, comments, workspaceRoot);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      refreshDecorations(comments, workspaceRoot);
    })
  );

  function openOrRefreshPanel(draft?: Draft): void {
    currentDraft = draft;

    const panel = getOrCreatePanel();
    panel.webview.html = buildPanelHtml(comments, currentDraft);

    if (!panelHandlerRegistered) {
      panelHandlerRegistered = true;

      panel.onDidDispose(() => {
        panelHandlerRegistered = false;
        currentDraft = undefined;
      });

      panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
        switch (msg.action) {
          case 'navigate': {
            const comment = comments.find(c => c.id === msg.commentId);
            if (comment) {
              await navigateTo(comment, workspaceRoot);
            }
            break;
          }

          case 'submitDraft': {
            if (!currentDraft) { break; }
            const newComment: InlineComment = {
              id: crypto.randomUUID(),
              filePath: currentDraft.filePath,
              startLine: currentDraft.startLine,
              startChar: currentDraft.startChar,
              endLine: currentDraft.endLine,
              endChar: currentDraft.endChar,
              selectedText: currentDraft.selectedText,
              text: msg.text as string,
              timestamp: new Date().toISOString(),
              resolved: false,
            };
            comments = [...comments, newComment];
            saveComments(storageRoot, workspaceRoot, comments);
            refreshDecorations(comments, workspaceRoot);
            openOrRefreshPanel(); // clears draft
            break;
          }

          case 'cancelDraft': {
            openOrRefreshPanel(); // clears draft
            break;
          }

          case 'resolve': {
            comments = comments.map(c =>
              c.id === msg.commentId ? { ...c, resolved: msg.resolved as boolean } : c
            );
            saveComments(storageRoot, workspaceRoot, comments);
            refreshDecorations(comments, workspaceRoot);
            // No openOrRefreshPanel() — webview updates in place
            break;
          }

          case 'edit': {
            comments = comments.map(c =>
              c.id === msg.commentId ? { ...c, text: msg.text as string, editedAt: new Date().toISOString() } : c
            );
            saveComments(storageRoot, workspaceRoot, comments);
            refreshDecorations(comments, workspaceRoot);
            // No openOrRefreshPanel() — webview updates in place
            break;
          }

          case 'delete': {
            comments = comments.filter(c => c.id !== msg.commentId);
            saveComments(storageRoot, workspaceRoot, comments);
            refreshDecorations(comments, workspaceRoot);
            // No openOrRefreshPanel() — webview updates in place
            break;
          }
        }
      });
    }
  }

  // ── Internal hover commands (not in package.json) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.resolveById', ({ id }: { id: string }) => {
      comments = comments.map(c => c.id === id ? { ...c, resolved: !c.resolved } : c);
      saveComments(storageRoot, workspaceRoot, comments);
      refreshDecorations(comments, workspaceRoot);
      if (commentsPanel) { openOrRefreshPanel(); }
    }),
    vscode.commands.registerCommand('inlineComment.deleteById', ({ id }: { id: string }) => {
      comments = comments.filter(c => c.id !== id);
      saveComments(storageRoot, workspaceRoot, comments);
      refreshDecorations(comments, workspaceRoot);
      if (commentsPanel) { openOrRefreshPanel(); }
    })
  );

  // ── Add Comment ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.addComment', () => {
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
      const draft: Draft = {
        filePath: makeStoredPath(editor.document.uri.fsPath, workspaceRoot),
        startLine: selection.start.line,
        startChar: selection.start.character,
        endLine: selection.end.line,
        endChar: selection.end.character,
        selectedText: editor.document.getText(selection),
      };
      // Collapse selection so keypresses don't accidentally modify the editor
      editor.selection = new vscode.Selection(selection.start, selection.start);
      openOrRefreshPanel(draft);
    })
  );

  // ── Delete Comment (QuickPick) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.deleteComment', async () => {
      const updated = await deleteComment(storageRoot, workspaceRoot, comments);
      if (updated) {
        comments = updated;
        refreshDecorations(comments, workspaceRoot);
        if (commentsPanel) {
          openOrRefreshPanel();
        }
      }
    })
  );

  // ── Show All ──
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineComment.showAll', () => {
      openOrRefreshPanel();
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
        saveComments(storageRoot, workspaceRoot, comments);
        refreshDecorations(comments, workspaceRoot);
        vscode.window.showInformationMessage('All comments cleared.');
        if (commentsPanel) {
          openOrRefreshPanel();
        }
      }
    })
  );
}

export function deactivate(): void {}
