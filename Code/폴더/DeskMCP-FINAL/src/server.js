import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(globalThis.process?.env?.PORT ?? 8787);
const MCP_VERSION = '2026-07-28';
const SERVER_VERSION = '5.0.0';
const WORKSPACE_SCHEMA_VERSION = 5;
const STATE_FILE = String(globalThis.process?.env?.DESKMCP_STATE_FILE || join(ROOT, '.deskmcp', 'state.json'));
let persistenceTimer = undefined;
const BACKUP_FILE = STATE_FILE + '.bak';
let persistRevision = 0;
const SESSION_TTL_MS = 30 * 60 * 1000;
const workspaceLocks = new Map();
const textEncoder = new TextEncoder();
const state = {
    workspaces: new Map(), active: '', browserConnected: false, browserSeenAt: 0, sessions: new Map(), apiToken: globalThis.process?.env?.DESKMCP_TOKEN || undefined
};
const tools = [
    t('workspace_list', 'List workspaces.', {}),
    t('workspace_create', 'Create and activate a workspace.', { name: s('string') }),
    t('workspace_activate', 'Activate a workspace by id.', { id: s('string') }),
    t('workspace_state', 'Read the active workspace.', { includeFileContent: b(false) }),
    t('workspace_reset', 'Reset the active workspace without changing its id.', {}),
    t('workspace_snapshot', 'Return a portable snapshot of the active workspace.', {}),
    t('workspace_snapshot_create', 'Create and retain a named snapshot of the active workspace.', { name: s('string', '') }),
    t('workspace_snapshot_list', 'List retained workspace snapshots.', {}),
    t('workspace_snapshot_restore', 'Restore the active workspace from a retained snapshot.', { id: s('string') }),
    t('workspace_snapshot_delete', 'Delete a retained workspace snapshot.', { id: s('string') }),
    t('workspace_snapshot_prune', 'Keep only the newest N snapshots.', { keep: n(20) }),
    t('workspace_validate', 'Validate the active workspace schema and basic invariants.', {}),
    t('file_list', 'List entries directly inside a virtual directory.', { path: s('string', '/') }),
    t('file_read', 'Read a UTF-8 virtual file.', { path: s('string') }),
    t('file_write', 'Create or overwrite a virtual UTF-8 text file. Parent directories are created automatically.', { path: s('string'), content: s('string'), mime: s('string', 'text/plain') }),
    t('file_write_base64', 'Create or overwrite a virtual binary file from base64.', { path: s('string'), content: s('string'), mime: s('string', 'application/octet-stream') }),
    t('file_stat', 'Read virtual file metadata.', { path: s('string') }),
    t('file_copy', 'Copy a virtual file or directory recursively.', { source: s('string'), destination: s('string') }),
    t('file_move', 'Move or rename a virtual file or directory recursively.', { source: s('string'), destination: s('string') }),
    t('file_delete', 'Delete a virtual file or directory recursively.', { path: s('string'), recursive: b(false) }),
    t('directory_create', 'Create a virtual directory recursively.', { path: s('string') }),
    t('file_search', 'Search virtual file paths and text content.', { query: s('string') }),
    t('file_tree', 'Return a recursive virtual directory tree.', { path: s('string', '/'), maxDepth: n(20) }),
    t('memory_set', 'Store AI memory in the workspace.', { key: s('string'), value: s('string'), scope: s('string', 'project'), tags: arrStr([]), importance: n(5), expiresAt: n(0) }),
    t('memory_get', 'Get AI memory by key.', { key: s('string') }),
    t('memory_search', 'Search AI memory by key, value, scope, or tags.', { query: s('string') }),
    t('memory_list', 'List all AI memory entries.', {}),
    t('memory_delete', 'Delete AI memory by key.', { key: s('string') }),
    t('project_settings_get', 'Read project settings.', {}),
    t('project_settings_set', 'Set one project setting.', { key: s('string'), value: {} }),
    t('screen_info', 'Read the virtual screen and browser bridge status.', {}),
    t('screen_screenshot', 'Capture the virtual desktop as a PNG data URL in the browser.', {}),
    t('screen_state', 'Read the current virtual desktop observation state from the connected browser.', {}),
    t('screen_windows', 'Return a compact screen-oriented view of visible virtual windows.', {}),
    t('mouse_move', 'Move the virtual mouse.', { x: n(), y: n() }),
    t('mouse_click', 'Click at virtual screen coordinates.', { x: n(), y: n(), button: e(['left', 'right', 'middle'], 'left') }),
    t('mouse_double_click', 'Double click at virtual screen coordinates.', { x: n(), y: n(), button: e(['left', 'right', 'middle'], 'left') }),
    t('mouse_drag', 'Drag from one virtual coordinate to another.', { x1: n(), y1: n(), x2: n(), y2: n(), durationMs: n(250) }),
    t('mouse_scroll', 'Scroll the virtual desktop.', { x: n(), y: n(), deltaY: n(600) }),
    t('keyboard_type', 'Type text into the focused virtual application.', { text: s('string') }),
    t('keyboard_press', 'Press one key.', { key: s('string') }),
    t('keyboard_hotkey', 'Press a key combination.', { keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }),
    t('window_list', 'List virtual application windows.', {}),
    t('window_open', 'Open a virtual application.', { app: s('string'), title: s('string', '') }),
    t('window_focus', 'Focus a virtual window.', { id: s('string') }),
    t('window_close', 'Close a virtual window.', { id: s('string') }),
    t('window_minimize', 'Minimize or restore a virtual window.', { id: s('string'), minimized: b(true) }),
    t('window_move', 'Move a virtual window.', { id: s('string'), x: n(), y: n() }),
    t('window_resize', 'Resize a virtual window.', { id: s('string'), width: n(), height: n() }),
    t('window_maximize', 'Maximize or restore a virtual window.', { id: s('string'), maximized: b(true) }),
    t('window_set_bounds', 'Set complete virtual window bounds and state.', { id: s('string'), x: n(), y: n(), width: n(), height: n(), minimized: b(false), maximized: b(false) }),
    t('window_active', 'Return the currently focused virtual window.', {}),
    t('terminal_exec', 'Run a command in the browser virtual shell.', { command: s('string') }),
    t('terminal_state', 'Read the virtual terminal cwd, history, and environment.', {}),
    t('terminal_cd', 'Change the virtual terminal working directory.', { path: s('string') }),
    t('terminal_history', 'Read recent virtual terminal commands.', { limit: n(100) }),
    t('terminal_env_set', 'Set a virtual terminal environment variable.', { key: s('string'), value: s('string') }),
    t('editor_open', 'Open a virtual file in the browser editor.', { path: s('string') }),
    t('editor_read', 'Read editor-ready UTF-8 text with line metadata.', { path: s('string') }),
    t('editor_write', 'Write UTF-8 text to a virtual file and update its editor state.', { path: s('string'), content: s('string'), mime: s('string', 'text/plain') }),
    t('editor_replace', 'Replace the first or all matching text occurrences in a virtual file.', { path: s('string'), search: s('string'), replace: s('string'), all: b(false) }),
    t('editor_search', 'Search UTF-8 file content and return line/column matches.', { path: s('string'), query: s('string'), maxResults: n(200) }),
    t('editor_lines', 'Read a contiguous 1-based line range from a UTF-8 file.', { path: s('string'), startLine: n(1), endLine: n(50) }),
    t('wasm_validate', 'Validate a virtual WebAssembly module without executing it.', { path: s('string') }),
    t('wasm_exports', 'List exports from a virtual WebAssembly module.', { path: s('string') }),
    t('wasm_run', 'Execute a base64 WebAssembly file in the browser. Numeric args are passed to the exported function.', { path: s('string'), args: { type: 'array', items: { type: 'number' } }, entry: s('string', '_start') }),
    t('job_status', 'Read a queued browser job.', { jobId: s('string') }),
    t('job_wait', 'Wait until a browser job finishes.', { jobId: s('string'), timeoutMs: n(30000) }),
    t('job_cancel', 'Cancel a queued browser job before execution.', { jobId: s('string') }),
    t('web_open', 'Open an HTTPS URL in the virtual browser.', { url: s('string') }),
    t('web_back', 'Navigate the virtual browser back.', {}),
    t('web_forward', 'Navigate the virtual browser forward.', {}),
    t('web_refresh', 'Refresh the current browser page.', {}),
    t('web_text', 'Extract visible text and metadata from the current browser page.', {}),
    t('web_links', 'List links from the current browser page.', { limit: n(100) }),
    t('web_elements', 'List interactive and semantic elements in the current browser page.', { limit: n(200) }),
    t('web_click', 'Click an element in the current browser page by CSS selector.', { selector: s('string') }),
    t('web_input', 'Set or append text in an input or textarea selected by CSS selector.', { selector: s('string'), text: s('string'), mode: e(['set', 'append'], 'set') }),
    t('web_key', 'Send a keyboard key to an element selected by CSS selector.', { selector: s('string'), key: s('string') }),
    t('web_close', 'Close the virtual browser window.', {}),
    t('web_find_text', 'Find text in the current HTTPS page.', { query: s('string') }),
    t('web_open_link', 'Open one of the extracted links by index.', { index: n(0) }),
    t('web_screenshot', 'Capture the current browser page as a screenshot when the browser bridge supports it.', {}),
    t('browser_status', 'Report whether a DeskMCP browser bridge is connected.', {}),
    t('browser_tab_list', 'List virtual browser tabs.', {}),
    t('browser_tab_open', 'Open a new HTTPS browser tab.', { url: s('string'), title: s('string', '') }),
    t('browser_tab_activate', 'Activate a browser tab by id.', { id: s('string') }),
    t('browser_tab_close', 'Close a browser tab by id.', { id: s('string') }),
    t('browser_tab_update', 'Update the URL or title of an existing browser tab.', { id: s('string'), url: s('string', ''), title: s('string', '') }),
    t('workspace_clone', 'Clone the active workspace into a new workspace.', { name: s('string') }),
    t('workspace_manifest', 'Return a compact manifest of the active workspace.', {}),
    t('file_download', 'Fetch an HTTPS resource and save it into the virtual filesystem.', { url: s('string'), path: s('string') }),
    t('file_upload_prepare', 'Prepare a browser upload target for a virtual file.', { path: s('string') }),
    t('file_permissions_get', 'Read virtual file permissions metadata.', { path: s('string') }),
    t('file_permissions_set', 'Set virtual file permissions.', { path: s('string'), permission: e(['read', 'write', 'execute'], 'read') }),
    t('memory_clear_scope', 'Delete AI memories in one scope.', { scope: s('string') }),
    t('memory_tag_add', 'Add a tag to an AI memory.', { key: s('string'), tag: s('string') }),
    t('memory_search_advanced', 'Search AI memory with scope, tag, importance and expiration filters.', { query: s('string', ''), scope: s('string', ''), tag: s('string', ''), minImportance: n(0), limit: n(50), includeExpired: b(false) }),
    t('memory_recent', 'List recently accessed or updated AI memories.', { limit: n(20), scope: s('string', '') }),
    t('memory_touch', 'Mark an AI memory as accessed without changing its value.', { key: s('string') }),
    t('memory_expire', 'Set or remove an expiration time for an AI memory.', { key: s('string'), expiresAt: n(0) }),
    t('memory_stats', 'Return AI memory statistics.', {}),
    t('memory_gc', 'Delete expired AI memories.', { scope: s('string', '') }),
    t('project_task_set', 'Create or replace a named project task.', { name: s('string'), command: s('string'), cwd: s('string', '/home/user'), description: s('string', '') }),
    t('project_task_list', 'List project tasks.', {}),
    t('project_task_run', 'Run a project task in the virtual terminal.', { name: s('string') }),
    t('task_result', 'Read the result of a task job.', { jobId: s('string') }),
    t('runtime_report', 'Read a normalized runtime execution report for a job.', { jobId: s('string') }),
    t('runtime_logs', 'Read structured runtime logs for a job.', { jobId: s('string'), level: s('string', '') }),
    t('runtime_diagnostics', 'Read structured diagnostics for a job.', { jobId: s('string') }),
    t('runtime_clear_logs', 'Clear stored runtime logs and diagnostics for a job.', { jobId: s('string') }),
    t('project_run', 'Run a named task and return its job id plus project context.', { name: s('string') }),
    t('project_test', 'Run the project test task, if configured, or the test command setting.', {}),
    t('project_build', 'Run the project build task, if configured, or the build command setting.', {}),
    t('project_run_command', 'Run the project run task, if configured, or the run command setting.', {}),
    t('terminal_env_delete', 'Delete a virtual terminal environment variable.', { key: s('string') }),
    t('process_signal', 'Send a virtual signal to a process.', { pid: n(0), signal: s('string', 'TERM') }),
    t('window_raise', 'Raise and focus a virtual window.', { id: s('string') }),
    t('editor_session', 'Read open editor files and the active editor file.', {}),
    t('audit_log', 'Read recent DeskMCP workspace audit entries.', { limit: n(100) }),
    t('audit_clear', 'Clear the workspace audit log.', {}),
    t('system_capabilities', 'Describe DeskMCP runtime capabilities.', {}),
    t('security_policy', 'Return the active network and runtime security policy.', {}),
    t('workspace_gc', 'Run workspace garbage collection for old jobs and audit entries.', { maxJobs: n(500), maxAudit: n(1000) }),
    t('state_persistence_status', 'Return server persistence and backup status.', {}),
    t('state_persistence_save', 'Force-save server persistence state.', {}),
    t('state_persistence_backup', 'Create an explicit state backup.', {}),
    t('state_persistence_restore_backup', 'Restore server state from the last backup.', {})
];
function t(name, description, properties) {
    const required = Object.entries(properties).filter(([, v]) => !('default' in v)).map(([k]) => k);
    return { name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}
function s(type, def) { return def === undefined ? { type } : { type, default: def }; }
function n(def) { return def === undefined ? { type: 'number' } : { type: 'number', default: def }; }
function b(def) { return { type: 'boolean', default: def }; }
function e(values, def) { return { type: 'string', enum: values, default: def }; }
function arrStr(def) { return { type: 'array', items: { type: 'string' }, default: def }; }
function now() { return Date.now(); }
function d(at = now()) { return { kind: 'dir', content: '', createdAt: at, updatedAt: at }; }
function f(content, at = now(), mime = 'text/plain', encoding = 'utf8') { return { kind: 'file', content, createdAt: at, updatedAt: at, mime, encoding }; }
function byteSize(v) { if (v.kind !== 'file')
    return 0; if (v.encoding === 'base64') {
    try {
        return Buffer.from(v.content, 'base64').byteLength;
    }
    catch {
        return 0;
    }
} return textEncoder.encode(v.content).byteLength; }
function isDescendant(path, dir) { const p = norm(path), d = norm(dir); return d === '/' ? p !== '/' : p.startsWith(d + '/'); }
function assertParentDirectory(x, p) { const par = parentPath(p); const q = x.files[par]; if (!q || q.kind !== 'dir')
    throw new Error('Parent directory does not exist'); }
function cloneFile(v, at = now()) { return { ...v, createdAt: at, updatedAt: at }; }
function norm(p) {
    let x = ('/' + String(p || '').replaceAll('\\', '/')).replace(/\/+/g, '/');
    const parts = [];
    for (const part of x.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..')
            parts.pop();
        else
            parts.push(part);
    }
    x = '/' + parts.join('/');
    return x === '' ? '/' : x;
}
function parentPath(p) { const q = norm(p); if (q === '/')
    return '/'; const i = q.lastIndexOf('/'); return i <= 0 ? '/' : q.slice(0, i); }
function ensureDir(x, path) {
    const q = norm(path);
    if (q === '/')
        return;
    let cur = '';
    for (const part of q.slice(1).split('/')) {
        cur += '/' + part;
        if (!x.files[cur])
            x.files[cur] = d();
    }
}
function mkWorkspace(name = 'Desk Workspace') {
    const at = now();
    const x = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION, id: randomUUID(), name, createdAt: at, updatedAt: at,
        files: { '/': d(at), '/home': d(at), '/home/user': d(at), '/home/user/README.txt': f('# DeskMCP\n\nThis is a persistent virtual workspace.\n', at) },
        memory: {}, settings: { language: 'wasm', entry: '/home/user/main.wasm', theme: 'desk', shell: 'desksh' },
        screen: { width: 1100, height: 700 }, windows: [], jobs: {}, terminal: { cwd: '/home/user', history: [], env: {} }, snapshots: {}
    };
    return x;
}
const first = mkWorkspace();
state.workspaces.set(first.id, first);
state.active = first.id;
function statePayload() {
    return { version: 2, revision: ++persistRevision, active: state.active, savedAt: now(), workspaces: [...state.workspaces.values()] };
}
function writeAtomic(path, text) {
    const tmp = path + '.tmp';
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}
function persistState() {
    const text = JSON.stringify(statePayload());
    const dir = join(STATE_FILE, '..');
    mkdirSync(dir, { recursive: true });
    if (existsSync(STATE_FILE)) {
        try {
            writeAtomic(BACKUP_FILE, readFileSync(STATE_FILE, 'utf8'));
        }
        catch { }
    }
    writeAtomic(STATE_FILE, text);
}
function parseStateFile(path) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (![1, 2].includes(raw?.version) || !Array.isArray(raw.workspaces))
        throw new Error('Invalid state file');
    const loaded = new Map();
    for (const item of raw.workspaces) {
        const q = sanitizeWorkspace(item);
        loaded.set(q.id, q);
    }
    if (!loaded.size)
        throw new Error('State contains no workspaces');
    return { loaded, active: loaded.has(raw.active) ? raw.active : loaded.keys().next().value, revision: Number(raw.revision || 0) };
}
function loadState() {
    for (const path of [STATE_FILE, BACKUP_FILE]) {
        if (!existsSync(path))
            continue;
        try {
            const parsed = parseStateFile(path);
            state.workspaces = parsed.loaded;
            state.active = parsed.active;
            persistRevision = parsed.revision;
            return path;
        }
        catch { }
    }
    return undefined;
}
const loadedStateFrom = loadState();
function schedulePersist() { clearTimeout(persistenceTimer); persistenceTimer = setTimeout(() => { try {
    persistState();
}
catch { } }, 150); }
function w(id = state.active) { const x = state.workspaces.get(id); if (!x)
    throw new Error('No active workspace'); return x; }
function sessionIdFor(sessionId) { if (!sessionId)
    return undefined; return state.sessions.has(sessionId) ? sessionId : undefined; }
function workspaceIdFor(sessionId) { const sid = sessionIdFor(sessionId); return sid ? state.sessions.get(sid).workspaceId : state.active; }
function wsFor(sessionId) { return w(workspaceIdFor(sessionId)); }
async function withWorkspaceLock(workspaceId, fn) {
    const previous = workspaceLocks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(r => { release = r; });
    const chain = previous.then(() => current);
    workspaceLocks.set(workspaceId, chain);
    await previous;
    try {
        return await fn();
    }
    finally {
        release();
        if (workspaceLocks.get(workspaceId) === chain)
            workspaceLocks.delete(workspaceId);
    }
}
function cleanupSessions() {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of state.sessions)
        if (session.lastSeenAt < cutoff)
            state.sessions.delete(id);
}
function touch(x = w()) { x.updatedAt = now(); schedulePersist(); }
function out(value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }; }
function fail(message) { return { content: [{ type: 'text', text: message }], isError: true }; }
function queue(type, payload, x = w()) {
    const at = now();
    const j = { id: randomUUID(), type, payload, status: 'queued', createdAt: at, updatedAt: at, logs: [{ at, level: 'info', phase: 'queue', message: `Queued ${type}` }], diagnostics: [] };
    x.jobs[j.id] = j;
    touch(x);
    return j;
}
function addJobLog(j, level, phase, message, data) {
    if (!j.logs)
        j.logs = [];
    j.logs.push({ at: now(), level, phase, message, ...(data === undefined ? {} : { data }) });
    if (j.logs.length > 500)
        j.logs = j.logs.slice(-500);
}
function normalizeDiagnostics(result, error) {
    const raw = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
    const out = raw.slice(0, 500).map((d) => ({ level: ['info', 'warning', 'error'].includes(d?.level) ? d.level : 'error', code: String(d?.code || 'RUNTIME'), message: String(d?.message || d || ''), ...(d?.phase ? { phase: String(d.phase) } : {}), ...(Number.isFinite(d?.line) ? { line: Number(d.line) } : {}), ...(Number.isFinite(d?.column) ? { column: Number(d.column) } : {}) }));
    if (error)
        out.push({ level: 'error', code: 'JOB_ERROR', message: String(error) });
    return out;
}
function finalizeJob(j, status, result, error) {
    const at = now();
    j.status = status;
    j.result = result;
    j.error = error;
    j.updatedAt = at;
    j.finishedAt = at;
    j.durationMs = Math.max(0, at - (j.startedAt ?? j.createdAt));
    if (!j.logs)
        j.logs = [];
    addJobLog(j, status === 'error' ? 'error' : 'info', 'finish', `Job ${status}`, { durationMs: j.durationMs, exitCode: result?.exitCode });
    j.diagnostics = normalizeDiagnostics(result, error);
    return j;
}
function visibleJobs(x) { return Object.values(x.jobs).filter(j => j.status === 'queued'); }
function sanitizeWorkspace(raw) {
    const x = raw;
    if (!x || typeof x !== 'object')
        throw new Error('Invalid workspace');
    if (x.schemaVersion !== WORKSPACE_SCHEMA_VERSION)
        throw new Error(`Unsupported workspace schema: ${x.schemaVersion}`);
    if (!x.files || typeof x.files !== 'object')
        throw new Error('Invalid workspace files');
    const t = now();
    for (const [path, value] of Object.entries(x.files)) {
        if (!value || (value.kind !== 'file' && value.kind !== 'dir'))
            throw new Error(`Invalid file entry: ${path}`);
        value.createdAt = Number(value.createdAt ?? value.updatedAt ?? t);
        value.updatedAt = Number(value.updatedAt ?? value.createdAt ?? t);
        if (value.kind === 'file') {
            value.content = String(value.content ?? '');
            value.encoding = value.encoding === 'base64' ? 'base64' : 'utf8';
            value.mime = String(value.mime ?? (value.encoding === 'utf8' ? 'text/plain' : 'application/octet-stream'));
        }
        else {
            value.content = '';
            delete value.encoding;
            delete value.mime;
        }
    }
    if (!x.files['/'])
        x.files['/'] = d(t);
    if (x.files['/'].kind !== 'dir')
        throw new Error('Root must be a directory');
    if (!x.snapshots || typeof x.snapshots !== 'object')
        x.snapshots = {};
    if (!Array.isArray(x.audit))
        x.audit = [];
    if (!x.editor || typeof x.editor !== 'object')
        x.editor = { openPaths: [] };
    if (!Array.isArray(x.editor.openPaths))
        x.editor.openPaths = [];
    if (!x.projectTasks || typeof x.projectTasks !== 'object')
        x.projectTasks = {};
    if (!x.permissions || typeof x.permissions !== 'object')
        x.permissions = {};
    return x;
}
function commandFs(x, command) {
    const trimmed = command.trim();
    const [raw, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');
    switch ((raw || '').toLowerCase()) {
        case 'help': return { exitCode: 0, stdout: 'help  pwd  ls  cat  write  mkdir  rm  clear  echo  mem  settings  open  date\n', stderr: '' };
        case 'pwd': return { exitCode: 0, stdout: '/home/user\n', stderr: '' };
        case 'ls': {
            const dir = norm(arg || '/home/user');
            const pre = dir === '/' ? '/' : dir + '/';
            const rows = Object.entries(x.files).filter(([p]) => p !== dir && p.startsWith(pre) && !p.slice(pre.length).includes('/')).map(([p, v]) => (v.kind === 'dir' ? p.slice(pre.length) + '/' : p.slice(pre.length)));
            return { exitCode: 0, stdout: rows.join('\n') + (rows.length ? '\n' : ''), stderr: '' };
        }
        case 'cat': {
            const p = norm(arg);
            const v = x.files[p];
            if (!v || v.kind !== 'file')
                return { exitCode: 1, stdout: '', stderr: 'cat: file not found\n' };
            if (v.encoding === 'base64')
                return { exitCode: 0, stdout: v.content + '\n', stderr: '' };
            return { exitCode: 0, stdout: v.content, stderr: '' };
        }
        case 'write': {
            const m = arg.match(/^(\S+)\s([\s\S]*)$/);
            if (!m)
                return { exitCode: 2, stdout: '', stderr: 'usage: write PATH CONTENT\n' };
            const p = norm(m[1]);
            if (p === '/')
                return { exitCode: 1, stdout: '', stderr: 'write: cannot write root\n' };
            ensureDir(x, parentPath(p));
            if (x.files[p]?.kind === 'dir')
                return { exitCode: 1, stdout: '', stderr: 'write: is a directory\n' };
            x.files[p] = f(m[2]);
            touch();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'mkdir': {
            const p = norm(arg);
            if (p === '/')
                return { exitCode: 0, stdout: '', stderr: '' };
            if (x.files[p]?.kind === 'file')
                return { exitCode: 1, stdout: '', stderr: 'mkdir: file exists\n' };
            ensureDir(x, p);
            if (!x.files[p])
                x.files[p] = d();
            touch();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'rm': {
            const p = norm(arg);
            const v = x.files[p];
            if (!v || p === '/')
                return { exitCode: 1, stdout: '', stderr: 'rm: path not found\n' };
            const children = Object.keys(x.files).filter(k => isDescendant(k, p));
            if (v.kind === 'dir' && children.length)
                return { exitCode: 1, stdout: '', stderr: 'rm: directory not empty\n' };
            delete x.files[p];
            touch();
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        case 'echo': return { exitCode: 0, stdout: arg + '\n', stderr: '' };
        case 'clear': return { exitCode: 0, stdout: '\u000c', stderr: '' };
        case 'date': return { exitCode: 0, stdout: new Date().toISOString() + '\n', stderr: '' };
        case 'mem': return { exitCode: 0, stdout: Object.entries(x.memory).map(([k, v]) => `${k}=${v.value}`).join('\n') + (Object.keys(x.memory).length ? '\n' : ''), stderr: '' };
        case 'settings': return { exitCode: 0, stdout: JSON.stringify(x.settings, null, 2) + '\n', stderr: '' };
        case 'open':
            queue('window.open', { app: arg || 'terminal', title: arg || 'terminal' });
            return { exitCode: 0, stdout: '', stderr: '' };
        default: return { exitCode: 127, stdout: '', stderr: `${raw || ''}: command not found\n` };
    }
}
function audit(x, action, detail, sessionId) {
    if (!Array.isArray(x.audit))
        x.audit = [];
    x.audit.push({ id: randomUUID(), at: now(), sessionId, action, detail });
    if (x.audit.length > 2000)
        x.audit.splice(0, x.audit.length - 2000);
}
function permissions(x, p) { return x.permissions?.[norm(p)] || 'read'; }
function setPermission(x, p, value) { if (!x.permissions)
    x.permissions = {}; x.permissions[norm(p)] = value; touch(x); }
function cloneWorkspace(src, name) { const q = JSON.parse(JSON.stringify(src)); q.id = randomUUID(); q.name = name; q.createdAt = now(); q.updatedAt = q.createdAt; q.snapshots = {}; q.audit = []; q.jobs = {}; return q; }
function isPrivateHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0')
        return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h))
        return true;
    const m = h.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31)
        return true;
    if (/^0\./.test(h) || /^fc/i.test(h) || /^fd/i.test(h) || /^fe80:/i.test(h))
        return true;
    return false;
}
function assertNetworkUrl(urlText) {
    const u = new URL(urlText);
    if (u.protocol !== 'https:')
        throw new Error('Only HTTPS URLs are allowed');
    if (u.username || u.password)
        throw new Error('Credentials in URLs are blocked');
    if (isPrivateHost(u.hostname))
        throw new Error('Private/local network hosts are blocked');
    return u;
}
async function assertResolvedPublic(u) {
    if (isPrivateHost(u.hostname))
        throw new Error('Private/local network hosts are blocked');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':'))
        return;
    const ips = [];
    try {
        ips.push(...await resolve4(host));
    }
    catch { }
    try {
        ips.push(...await resolve6(host));
    }
    catch { }
    if (!ips.length)
        throw new Error('Unable to resolve HTTPS host');
    if (ips.some(isPrivateHost))
        throw new Error('Resolved host points to a private/local network');
}
function manifest(x) { return { schemaVersion: x.schemaVersion, id: x.id, name: x.name, updatedAt: x.updatedAt, fileCount: Object.keys(x.files).length, totalBytes: Object.values(x.files).reduce((n, v) => n + byteSize(v), 0), memoryCount: Object.keys(x.memory).length, windowCount: x.windows.length, processCount: Object.values(x.windows).length, taskCount: Object.keys(x.projectTasks || {}).length, hasBrowser: x.windows.some(v => v.app === 'browser'), terminalCwd: x.terminal.cwd }; }
async function callTool(name, a = {}, sessionId) {
    const x = wsFor(sessionId);
    switch (name) {
        case 'workspace_list': {
            const activeId = workspaceIdFor(sessionId);
            return out([...state.workspaces.values()].map(q => ({ id: q.id, name: q.name, updatedAt: q.updatedAt, active: q.id === activeId })));
        }
        case 'workspace_create': {
            const q = mkWorkspace(String(a.name));
            state.workspaces.set(q.id, q);
            if (sessionId) {
                state.sessions.get(sessionId).workspaceId = q.id;
                state.sessions.get(sessionId).lastSeenAt = now();
            }
            else
                state.active = q.id;
            return out({ id: q.id, name: q.name });
        }
        case 'workspace_activate':
            if (!state.workspaces.has(a.id))
                return fail('Workspace not found');
            if (sessionId) {
                const se = state.sessions.get(sessionId);
                if (!se)
                    return fail('Invalid MCP session');
                se.workspaceId = a.id;
                se.lastSeenAt = now();
            }
            else
                state.active = a.id;
            touch(x);
            return out({ ok: true, id: a.id, name: w(a.id).name });
        case 'workspace_state': {
            const files = Object.fromEntries(Object.entries(x.files).map(([p, v]) => [p, a.includeFileContent ? v : { kind: v.kind, updatedAt: v.updatedAt }]));
            return out({ ...x, files });
        }
        case 'workspace_reset': {
            const q = mkWorkspace(x.name);
            q.id = x.id;
            q.createdAt = x.createdAt;
            state.workspaces.set(q.id, q);
            touch(x);
            return out({ ok: true, id: q.id });
        }
        case 'workspace_snapshot': return out({ workspace: x, snapshots: Object.values(x.snapshots).map(q => ({ id: q.id, name: q.name, createdAt: q.createdAt, workspaceUpdatedAt: q.workspaceUpdatedAt })) });
        case 'workspace_snapshot_create': {
            const id = randomUUID();
            const snapshotWorkspace = JSON.parse(JSON.stringify({ ...x, snapshots: undefined }));
            delete snapshotWorkspace.snapshots;
            const snap = { id, name: String(a.name || `Snapshot ${new Date().toISOString()}`), createdAt: now(), workspaceUpdatedAt: x.updatedAt, workspace: snapshotWorkspace };
            x.snapshots[id] = snap;
            touch(x);
            return out({ ok: true, id, name: snap.name, createdAt: snap.createdAt, total: Object.keys(x.snapshots).length });
        }
        case 'workspace_snapshot_list': return out(Object.values(x.snapshots).sort((a, b) => b.createdAt - a.createdAt).map(q => ({ id: q.id, name: q.name, createdAt: q.createdAt, workspaceUpdatedAt: q.workspaceUpdatedAt })));
        case 'workspace_snapshot_restore': {
            const snap = x.snapshots[String(a.id)];
            if (!snap)
                return fail('Snapshot not found');
            const restored = JSON.parse(JSON.stringify(snap.workspace));
            restored.id = x.id;
            restored.name = x.name;
            restored.createdAt = x.createdAt;
            restored.updatedAt = now();
            restored.schemaVersion = WORKSPACE_SCHEMA_VERSION;
            restored.snapshots = x.snapshots;
            state.workspaces.set(x.id, restored);
            return out({ ok: true, id: restored.id, restoredFrom: snap.id, name: restored.name });
        }
        case 'workspace_snapshot_delete': {
            const id = String(a.id);
            if (!x.snapshots[id])
                return fail('Snapshot not found');
            delete x.snapshots[id];
            touch(x);
            return out({ ok: true, id, remaining: Object.keys(x.snapshots).length });
        }
        case 'workspace_snapshot_prune': {
            const keep = Math.min(Math.max(Number(a.keep ?? 20), 0), 1000);
            const ordered = Object.values(x.snapshots).sort((a, b) => b.createdAt - a.createdAt);
            const removed = ordered.slice(keep);
            for (const q of removed)
                delete x.snapshots[q.id];
            touch(x);
            return out({ ok: true, keep, removed: removed.map(q => q.id), remaining: Object.keys(x.snapshots).length });
        }
        case 'workspace_validate': {
            const errors = [];
            if (x.schemaVersion !== WORKSPACE_SCHEMA_VERSION)
                errors.push(`schemaVersion must be ${WORKSPACE_SCHEMA_VERSION}`);
            if (!x.files['/'] || x.files['/'].kind !== 'dir')
                errors.push('root directory missing');
            if (!x.files['/home'] || x.files['/home'].kind !== 'dir')
                errors.push('/home directory missing');
            if (!x.files['/home/user'] || x.files['/home/user'].kind !== 'dir')
                errors.push('/home/user directory missing');
            if (!x.settings || typeof x.settings !== 'object')
                errors.push('settings must be an object');
            if (!x.memory || typeof x.memory !== 'object')
                errors.push('memory must be an object');
            if (!x.terminal || typeof x.terminal !== 'object')
                errors.push('terminal must be an object');
            else {
                if (typeof x.terminal.cwd !== 'string')
                    errors.push('terminal.cwd must be a string');
                if (!Array.isArray(x.terminal.history))
                    errors.push('terminal.history must be an array');
                if (!x.terminal.env || typeof x.terminal.env !== 'object')
                    errors.push('terminal.env must be an object');
            }
            if (!x.jobs || typeof x.jobs !== 'object')
                errors.push('jobs must be an object');
            if (!x.snapshots || typeof x.snapshots !== 'object')
                errors.push('snapshots must be an object');
            return out({ valid: errors.length === 0, schemaVersion: x.schemaVersion, expectedSchemaVersion: WORKSPACE_SCHEMA_VERSION, errors });
        }
        case 'file_list': {
            const dir = norm(a.path ?? '/'), base = x.files[dir];
            if (!base || base.kind !== 'dir')
                return fail('Directory not found');
            const pre = dir === '/' ? '/' : dir + '/';
            return out(Object.entries(x.files).filter(([p]) => p !== dir && p.startsWith(pre) && !p.slice(pre.length).includes('/')).map(([p, v]) => ({ path: p, kind: v.kind, updatedAt: v.updatedAt, createdAt: v.createdAt, size: byteSize(v), mime: v.mime, encoding: v.encoding })));
        }
        case 'file_read': {
            const p = norm(a.path), q = x.files[p];
            if (!q || q.kind !== 'file')
                return fail('File not found');
            return out({ path: p, content: q.content, encoding: q.encoding ?? 'utf8', mime: q.mime ?? 'application/octet-stream', size: byteSize(q) });
        }
        case 'file_write': {
            const p = norm(a.path);
            if (p === '/')
                return fail('Cannot write root');
            const existing = x.files[p];
            if (existing?.kind === 'dir')
                return fail('Path is a directory');
            ensureDir(x, parentPath(p));
            x.files[p] = f(String(a.content), now(), String(a.mime || 'text/plain'), 'utf8');
            touch(x);
            return out({ ok: true, path: p, size: byteSize(x.files[p]), encoding: 'utf8', mime: x.files[p].mime });
        }
        case 'file_write_base64': {
            const p = norm(a.path);
            if (p === '/')
                return fail('Cannot write root');
            const existing = x.files[p];
            if (existing?.kind === 'dir')
                return fail('Path is a directory');
            const raw = String(a.content || '');
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0)
                return fail('Invalid base64');
            ensureDir(x, parentPath(p));
            x.files[p] = f(raw, now(), String(a.mime || 'application/octet-stream'), 'base64');
            touch(x);
            return out({ ok: true, path: p, size: byteSize(x.files[p]), encoding: 'base64', mime: x.files[p].mime });
        }
        case 'file_stat': {
            const p = norm(a.path), q = x.files[p];
            if (!q)
                return fail('Path not found');
            return out({ path: p, kind: q.kind, size: byteSize(q), createdAt: q.createdAt, updatedAt: q.updatedAt, mime: q.mime, encoding: q.encoding });
        }
        case 'file_copy': {
            const src = norm(a.source), dst = norm(a.destination), q = x.files[src];
            if (!q)
                return fail('Source not found');
            if (src === '/' || dst === '/' || isDescendant(dst, src))
                return fail('Invalid destination');
            if (x.files[dst])
                return fail('Destination already exists');
            assertParentDirectory(x, dst);
            const entries = Object.entries(x.files).filter(([p]) => p === src || isDescendant(p, src));
            for (const [p, v] of entries) {
                const rel = p === src ? '' : p.slice(src.length);
                x.files[dst + rel] = cloneFile(v);
            }
            touch(x);
            return out({ ok: true, source: src, destination: dst, count: entries.length });
        }
        case 'file_move': {
            const src = norm(a.source), dst = norm(a.destination), q = x.files[src];
            if (!q)
                return fail('Source not found');
            if (src === '/' || dst === '/' || isDescendant(dst, src))
                return fail('Invalid destination');
            if (x.files[dst])
                return fail('Destination already exists');
            assertParentDirectory(x, dst);
            const entries = Object.entries(x.files).filter(([p]) => p === src || isDescendant(p, src));
            for (const [p, v] of entries) {
                const rel = p === src ? '' : p.slice(src.length);
                x.files[dst + rel] = { ...v, updatedAt: now() };
            }
            for (const [p] of entries)
                delete x.files[p];
            touch(x);
            return out({ ok: true, source: src, destination: dst, count: entries.length });
        }
        case 'file_delete': {
            const p = norm(a.path), q = x.files[p];
            if (!q)
                return fail('Path not found');
            if (p === '/')
                return fail('Cannot delete root');
            const descendants = Object.keys(x.files).filter(k => isDescendant(k, p));
            if (q.kind === 'dir' && descendants.length && !Boolean(a.recursive))
                return fail('Directory not empty; set recursive=true');
            for (const k of [p, ...descendants])
                delete x.files[k];
            touch(x);
            return out({ ok: true, path: p, recursive: Boolean(a.recursive), count: 1 + descendants.length });
        }
        case 'directory_create': {
            const p = norm(a.path);
            if (p === '/')
                return out({ ok: true, path: p, created: false });
            const existing = x.files[p];
            if (existing?.kind === 'file')
                return fail('Path is a file');
            ensureDir(x, p);
            if (!x.files[p])
                x.files[p] = d();
            touch(x);
            return out({ ok: true, path: p, created: !existing });
        }
        case 'file_search': {
            const q = String(a.query).toLowerCase();
            const hits = Object.entries(x.files).filter(([p, v]) => p.toLowerCase().includes(q) || (v.kind === 'file' && ((v.encoding ?? 'utf8') === 'utf8') && v.content.toLowerCase().includes(q))).map(([path, v]) => ({ path, kind: v.kind, size: byteSize(v) }));
            return out(hits);
        }
        case 'file_tree': {
            const root = norm(a.path ?? '/'), max = Math.min(Math.max(Number(a.maxDepth ?? 20), 0), 100);
            const base = x.files[root];
            if (!base || base.kind !== 'dir')
                return fail('Directory not found');
            const nodes = [];
            for (const [p, v] of Object.entries(x.files).sort(([a], [b]) => a.localeCompare(b))) {
                if (p === root || !isDescendant(p, root))
                    continue;
                const rel = p.slice(root === '/' ? 1 : root.length + 1);
                const depth = rel ? rel.split('/').length : 0;
                if (depth <= max)
                    nodes.push({ path: p, kind: v.kind, size: byteSize(v), depth });
            }
            return out({ root, maxDepth: max, nodes });
        }
        case 'memory_set': {
            const key = String(a.key), old = x.memory[key];
            const rawTags = Array.isArray(a.tags) ? a.tags : [];
            const tags = Array.from(new Set(rawTags.map((v) => String(v)).filter((v) => Boolean(v))));
            const stamp = now();
            x.memory[key] = { value: String(a.value), scope: String(a.scope ?? 'project'), tags, updatedAt: stamp, createdAt: old?.createdAt ?? stamp, importance: Math.min(10, Math.max(0, Number(a.importance ?? old?.importance ?? 5))), expiresAt: a.expiresAt ? Number(a.expiresAt) : old?.expiresAt, accessCount: old?.accessCount ?? 0, lastAccessedAt: old?.lastAccessedAt };
            touch(x);
            audit(x, 'memory_set', { key }, sessionId);
            return out({ ok: true, key, entry: x.memory[key] });
        }
        case 'memory_get': {
            const m = x.memory[a.key];
            if (!m)
                return fail('Memory key not found');
            if (m.expiresAt && m.expiresAt <= now())
                return fail('Memory expired');
            m.accessCount++;
            m.lastAccessedAt = now();
            return out(m);
        }
        case 'memory_search': {
            const q = String(a.query || '').toLowerCase();
            const entries = Object.entries(x.memory).filter(([, v]) => !v.expiresAt || v.expiresAt > now()).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.value.toLowerCase().includes(q) || v.scope.toLowerCase().includes(q) || v.tags.some(t => t.toLowerCase().includes(q)));
            return out(Object.fromEntries(entries));
        }
        case 'memory_search_advanced': {
            const q = String(a.query || '').toLowerCase(), scope = String(a.scope || ''), tag = String(a.tag || '').toLowerCase(), minI = Math.max(0, Number(a.minImportance ?? 0)), lim = Math.min(Math.max(Number(a.limit ?? 50), 1), 500), includeExpired = Boolean(a.includeExpired), at = now();
            const rows = Object.entries(x.memory).filter(([k, v]) => (includeExpired || !v.expiresAt || v.expiresAt > at) && (!q || k.toLowerCase().includes(q) || v.value.toLowerCase().includes(q) || v.tags.some(t => t.toLowerCase().includes(q))) && (!scope || v.scope === scope) && (!tag || v.tags.some(t => t.toLowerCase() === tag)) && v.importance >= minI).sort((a, b) => (b[1].importance - a[1].importance) || (b[1].updatedAt - a[1].updatedAt)).slice(0, lim);
            return out(rows.map(([key, entry]) => ({ key, entry })));
        }
        case 'memory_recent': {
            const lim = Math.min(Math.max(Number(a.limit ?? 20), 1), 200), scope = String(a.scope || '');
            return out(Object.entries(x.memory).filter(([, v]) => !v.expiresAt || v.expiresAt > now()).filter(([, v]) => !scope || v.scope === scope).sort((a, b) => ((b[1].lastAccessedAt ?? b[1].updatedAt) - (a[1].lastAccessedAt ?? a[1].updatedAt))).slice(0, lim).map(([key, entry]) => ({ key, entry })));
        }
        case 'memory_touch': {
            const m = x.memory[a.key];
            if (!m)
                return fail('Memory key not found');
            if (m.expiresAt && m.expiresAt <= now())
                return fail('Memory expired');
            m.accessCount++;
            m.lastAccessedAt = now();
            return out({ ok: true, key: a.key, accessCount: m.accessCount, lastAccessedAt: m.lastAccessedAt });
        }
        case 'memory_expire': {
            const m = x.memory[a.key];
            if (!m)
                return fail('Memory key not found');
            const ex = Number(a.expiresAt ?? 0);
            m.expiresAt = ex > 0 ? ex : undefined;
            m.updatedAt = now();
            touch(x);
            return out({ ok: true, key: a.key, expiresAt: m.expiresAt ?? null });
        }
        case 'memory_stats': {
            const at = now(), vals = Object.values(x.memory), scopes = {};
            for (const m of vals)
                scopes[m.scope] = (scopes[m.scope] || 0) + 1;
            return out({ total: vals.length, active: vals.filter(m => !m.expiresAt || m.expiresAt > at).length, expired: vals.filter(m => m.expiresAt && m.expiresAt <= at).length, tagged: vals.filter(m => m.tags.length).length, averageImportance: vals.length ? vals.reduce((n, m) => n + m.importance, 0) / vals.length : 0, scopes });
        }
        case 'memory_gc': {
            const scope = String(a.scope || ''), at = now(), deleted = [];
            for (const [key, m] of Object.entries(x.memory)) {
                if ((!scope || m.scope === scope) && m.expiresAt && m.expiresAt <= at) {
                    delete x.memory[key];
                    deleted.push(key);
                }
            }
            if (deleted.length)
                touch(x);
            return out({ ok: true, deleted, count: deleted.length });
        }
        case 'memory_list': return out(Object.fromEntries(Object.entries(x.memory).filter(([, v]) => !v.expiresAt || v.expiresAt > now())));
        case 'memory_delete':
            delete x.memory[a.key];
            touch(x);
            return out({ ok: true, key: a.key });
        case 'project_settings_get': return out(x.settings);
        case 'project_settings_set':
            x.settings[String(a.key)] = a.value;
            touch(x);
            return out({ ok: true, key: a.key, value: a.value });
        case 'screen_info': return out({ screen: x.screen, browserConnected: state.browserConnected, lastSeenAt: state.browserSeenAt });
        case 'screen_state': return out(queue('screen.state', {}, x));
        case 'screen_windows': return out(x.windows.filter(q => !q.minimized).sort((a, b) => b.z - a.z).map(q => ({ id: q.id, title: q.title, app: q.app, x: q.x, y: q.y, width: q.width, height: q.height, focused: q.focused, maximized: Boolean(q.maximized), url: q.url, path: q.path })));
        case 'screen_screenshot': return out(queue('screenshot', {}, x));
        case 'mouse_move': return out(queue('mouse.move', a, x));
        case 'mouse_click': return out(queue('mouse.click', a, x));
        case 'mouse_double_click': return out(queue('mouse.double.click', a, x));
        case 'mouse_drag': return out(queue('mouse.drag', a, x));
        case 'mouse_scroll': return out(queue('mouse.scroll', a, x));
        case 'keyboard_type': return out(queue('keyboard.type', a, x));
        case 'keyboard_press': return out(queue('keyboard.press', a, x));
        case 'keyboard_hotkey': return out(queue('keyboard.hotkey', a, x));
        case 'window_list': return out(x.windows);
        case 'window_open': return out(queue('window.open', { ...a, title: a.title || a.app }, x));
        case 'window_focus': return out(queue('window.focus', a, x));
        case 'window_close': return out(queue('window.close', a, x));
        case 'window_minimize': return out(queue('window.minimize', a, x));
        case 'window_move': return out(queue('window.move', a, x));
        case 'window_resize': return out(queue('window.resize', a, x));
        case 'window_maximize': return out(queue('window.maximize', a, x));
        case 'window_set_bounds': return out(queue('window.set_bounds', a, x));
        case 'window_active': {
            const win = [...x.windows].filter(w => w.focused && !w.minimized).sort((a, b) => b.z - a.z)[0];
            return out(win || null);
        }
        case 'terminal_exec': {
            const command = String(a.command);
            x.terminal.history.push(command);
            if (x.terminal.history.length > 500)
                x.terminal.history = x.terminal.history.slice(-500);
            touch(x);
            return out(queue('terminal.exec', { command }, x));
        }
        case 'terminal_state': return out(x.terminal);
        case 'terminal_history': {
            const limit = Math.min(Math.max(Number(a.limit ?? 100), 1), 500);
            return out(x.terminal.history.slice(-limit));
        }
        case 'terminal_cd': {
            const p = norm(a.path || x.terminal.cwd);
            const q = x.files[p];
            if (!q || q.kind !== 'dir')
                return fail('Directory not found');
            x.terminal.cwd = p;
            touch(x);
            return out({ ok: true, cwd: p });
        }
        case 'terminal_env_set': {
            const key = String(a.key);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
                return fail('Invalid environment variable name');
            x.terminal.env[key] = String(a.value);
            touch(x);
            return out({ ok: true, key, value: x.terminal.env[key] });
        }
        case 'editor_open': return out(queue('editor.open', { path: norm(a.path) }, x));
        case 'editor_read': {
            const p = norm(a.path), q = x.files[p];
            if (!q || q.kind !== 'file')
                return fail('File not found');
            if ((q.encoding ?? 'utf8') !== 'utf8')
                return fail('Editor supports UTF-8 text files only');
            const lines = q.content.split('\n');
            return out({ path: p, content: q.content, lines: lines.length, encoding: 'utf8', mime: q.mime ?? 'text/plain', size: byteSize(q) });
        }
        case 'editor_write': {
            const p = norm(a.path);
            if (p === '/')
                return fail('Cannot write root');
            const existing = x.files[p];
            if (existing?.kind === 'dir')
                return fail('Path is a directory');
            ensureDir(x, parentPath(p));
            const content = String(a.content ?? '');
            x.files[p] = f(content, now(), String(a.mime || existing?.mime || 'text/plain'), 'utf8');
            touch(x);
            return out({ ok: true, path: p, lines: content.split('\n').length, size: byteSize(x.files[p]), updatedAt: x.files[p].updatedAt });
        }
        case 'editor_replace': {
            const p = norm(a.path), q = x.files[p];
            if (!q || q.kind !== 'file')
                return fail('File not found');
            if ((q.encoding ?? 'utf8') !== 'utf8')
                return fail('Editor supports UTF-8 text files only');
            const search = String(a.search ?? '');
            if (!search)
                return fail('Search text must not be empty');
            const replacement = String(a.replace ?? '');
            const all = Boolean(a.all);
            let count = 0;
            let content = q.content;
            if (all) {
                const parts = content.split(search);
                count = Math.max(0, parts.length - 1);
                content = parts.join(replacement);
            }
            else {
                const i = content.indexOf(search);
                if (i >= 0) {
                    content = content.slice(0, i) + replacement + content.slice(i + search.length);
                    count = 1;
                }
            }
            if (count) {
                q.content = content;
                q.updatedAt = now();
                touch(x);
            }
            return out({ ok: true, path: p, replacements: count, changed: count > 0, lines: content.split('\n').length });
        }
        case 'editor_search': {
            const p = norm(a.path), q = x.files[p];
            if (!q || q.kind !== 'file')
                return fail('File not found');
            if ((q.encoding ?? 'utf8') !== 'utf8')
                return fail('Editor supports UTF-8 text files only');
            const query = String(a.query ?? '');
            if (!query)
                return fail('Query must not be empty');
            const max = Math.min(Math.max(Number(a.maxResults ?? 200), 1), 2000);
            const hits = [];
            const lines = q.content.split('\n');
            for (let i = 0; i < lines.length && hits.length < max; i++) {
                let from = 0;
                while (from <= lines[i].length) {
                    const col = lines[i].indexOf(query, from);
                    if (col < 0)
                        break;
                    hits.push({ line: i + 1, column: col + 1, text: lines[i].slice(Math.max(0, col - 60), Math.min(lines[i].length, col + query.length + 60)) });
                    from = col + Math.max(query.length, 1);
                    if (!query.length)
                        break;
                }
            }
            return out({ path: p, query, count: hits.length, truncated: hits.length >= max, matches: hits });
        }
        case 'editor_lines': {
            const p = norm(a.path), q = x.files[p];
            if (!q || q.kind !== 'file')
                return fail('File not found');
            if ((q.encoding ?? 'utf8') !== 'utf8')
                return fail('Editor supports UTF-8 text files only');
            const lines = q.content.split('\n');
            const start = Math.max(1, Number(a.startLine ?? 1));
            const end = Math.min(lines.length, Math.max(start, Number(a.endLine ?? 50)));
            return out({ path: p, startLine: start, endLine: end, totalLines: lines.length, lines: lines.slice(start - 1, end).map((text, i) => ({ line: start + i, text })) });
        }
        case 'wasm_validate': {
            const p = norm(a.path), file = x.files[p];
            if (!file || file.kind !== 'file')
                return fail('WASM file not found');
            if (file.encoding !== 'base64')
                return fail('WASM file must use base64 encoding');
            try {
                const bytes = Buffer.from(file.content, 'base64');
                await WebAssembly.compile(bytes);
                return out({ ok: true, path: p, bytes: bytes.byteLength, valid: true });
            }
            catch (e) {
                return fail(`Invalid WebAssembly: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        case 'wasm_exports': {
            const p = norm(a.path), file = x.files[p];
            if (!file || file.kind !== 'file')
                return fail('WASM file not found');
            if (file.encoding !== 'base64')
                return fail('WASM file must use base64 encoding');
            try {
                const bytes = Buffer.from(file.content, 'base64');
                const mod = await WebAssembly.compile(bytes);
                return out({ ok: true, path: p, exports: WebAssembly.Module.exports(mod) });
            }
            catch (e) {
                return fail(`Invalid WebAssembly: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        case 'wasm_run': {
            const p = norm(a.path), file = x.files[p];
            if (!file || file.kind !== 'file')
                return fail('WASM file not found');
            if (file.encoding !== 'base64')
                return fail('WASM file must use base64 encoding');
            return out(queue('wasm.run', { path: p, args: Array.isArray(a.args) ? a.args.map(Number) : [], entry: String(a.entry ?? '_start') }, x));
        }
        case 'job_status': return x.jobs[a.jobId] ? out(x.jobs[a.jobId]) : fail('Job not found');
        case 'job_cancel': {
            const q = x.jobs[a.jobId];
            if (!q)
                return fail('Job not found');
            if (q.status !== 'queued')
                return out({ ok: false, jobId: q.id, status: q.status, reason: 'Job is no longer queued' });
            q.status = 'cancelled';
            q.updatedAt = now();
            touch(x);
            return out({ ok: true, jobId: q.id, status: q.status });
        }
        case 'job_wait': {
            const timeout = Math.min(Math.max(Number(a.timeoutMs ?? 30000), 100), 120000), start = now();
            while (now() - start < timeout) {
                const q = x.jobs[a.jobId];
                if (!q)
                    return fail('Job not found');
                if (q.status === 'done' || q.status === 'error' || q.status === 'cancelled')
                    return out(q);
                await new Promise(r => setTimeout(r, 100));
            }
            return out({ timeout: true, jobId: a.jobId, status: x.jobs[a.jobId]?.status });
        }
        case 'browser_status': return out({ connected: state.browserConnected, lastSeenAt: state.browserSeenAt, pendingJobs: visibleJobs(x).length });
        case 'browser_tab_list': {
            const b = x.browser || { tabs: [], activeTabId: undefined };
            return out({ activeTabId: b.activeTabId || null, tabs: b.tabs });
        }
        case 'browser_tab_open': {
            const url = String(a.url || '').trim();
            try {
                assertNetworkUrl(url);
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
            if (!x.browser)
                x.browser = { tabs: [] };
            x.browser.tabs.forEach(q => q.active = false);
            const tab = { id: randomUUID(), title: String(a.title || ''), url, history: [url], historyIndex: 0, active: true, createdAt: now(), updatedAt: now() };
            x.browser.tabs.push(tab);
            x.browser.activeTabId = tab.id;
            touch(x);
            const browser = x.windows.find(v => v.app === 'browser');
            if (browser) {
                browser.url = url;
                browser.title = tab.title || 'Browser';
                browser.history = tab.history;
                browser.historyIndex = 0;
            }
            return out({ ok: true, tab });
        }
        case 'browser_tab_activate': {
            const b = x.browser || { tabs: [], activeTabId: undefined };
            const tab = b.tabs.find(q => q.id === String(a.id));
            if (!tab)
                return fail('Browser tab not found');
            b.tabs.forEach(q => q.active = q.id === tab.id);
            b.activeTabId = tab.id;
            x.browser = b;
            const browser = x.windows.find(v => v.app === 'browser');
            if (browser) {
                browser.url = tab.url;
                browser.title = tab.title || 'Browser';
                browser.history = tab.history;
                browser.historyIndex = tab.historyIndex;
            }
            touch(x);
            return out({ ok: true, tab });
        }
        case 'browser_tab_close': {
            if (!x.browser)
                return fail('No browser tabs');
            const id = String(a.id);
            const index = x.browser.tabs.findIndex(q => q.id === id);
            if (index < 0)
                return fail('Browser tab not found');
            const wasActive = x.browser.tabs[index].active;
            x.browser.tabs.splice(index, 1);
            if (wasActive && x.browser.tabs.length) {
                const next = x.browser.tabs[Math.max(0, index - 1)];
                x.browser.tabs.forEach(q => q.active = q.id === next.id);
                x.browser.activeTabId = next.id;
            }
            else if (!x.browser.tabs.length) {
                x.browser.activeTabId = undefined;
            }
            const tab = x.browser.tabs.find(q => q.active);
            const browser = x.windows.find(v => v.app === 'browser');
            if (browser && tab) {
                browser.url = tab.url;
                browser.title = tab.title || 'Browser';
                browser.history = tab.history;
                browser.historyIndex = tab.historyIndex;
            }
            touch(x);
            return out({ ok: true, closed: id, activeTabId: x.browser.activeTabId || null });
        }
        case 'browser_tab_update': {
            if (!x.browser)
                return fail('No browser tabs');
            const tab = x.browser.tabs.find(q => q.id === String(a.id));
            if (!tab)
                return fail('Browser tab not found');
            const url = String(a.url || '').trim();
            if (url) {
                try {
                    assertNetworkUrl(url);
                }
                catch (e) {
                    return fail(String(e instanceof Error ? e.message : e));
                }
                tab.url = url;
                if (tab.historyIndex < 0)
                    tab.historyIndex = 0;
                tab.history = tab.history.slice(0, tab.historyIndex + 1);
                if (tab.history[tab.history.length - 1] !== url) {
                    tab.history.push(url);
                    tab.historyIndex = tab.history.length - 1;
                }
            }
            if (String(a.title || ''))
                tab.title = String(a.title);
            tab.updatedAt = now();
            const browser = x.windows.find(v => v.app === 'browser');
            if (browser && tab.active) {
                browser.url = tab.url;
                browser.title = tab.title || 'Browser';
                browser.history = tab.history;
                browser.historyIndex = tab.historyIndex;
            }
            touch(x);
            return out({ ok: true, tab });
        }
        case 'web_open': {
            const url = String(a.url || '').trim();
            try {
                assertNetworkUrl(url);
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
            return out(queue('web.open', { url }, x));
        }
        case 'web_back': return out(queue('web.back', {}, x));
        case 'web_forward': return out(queue('web.forward', {}, x));
        case 'web_refresh': return out(queue('web.refresh', {}, x));
        case 'web_text': {
            const win = x.windows.find(v => v.app === 'browser');
            const u = String(win?.url || '');
            if (!u)
                return fail('Browser window not open');
            try {
                const page = await fetchWeb(u);
                const html = page.contentType.includes('text/html') ? page.body.toString('utf8') : '';
                return out({ ok: true, url: page.finalUrl, status: page.status, contentType: page.contentType, title: (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim(), text: stripHtml(html).slice(0, 50000) });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'web_links': {
            const win = x.windows.find(v => v.app === 'browser');
            const u = String(win?.url || '');
            if (!u)
                return fail('Browser window not open');
            try {
                const page = await fetchWeb(u);
                const html = page.contentType.includes('text/html') ? page.body.toString('utf8') : '';
                return out({ ok: true, url: page.finalUrl, status: page.status, links: extractLinks(html, page.finalUrl, Math.min(Math.max(Number(a.limit ?? 100), 1), 500)) });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'web_elements': return out(queue('web.elements', { limit: Math.min(Math.max(Number(a.limit ?? 200), 1), 1000) }, x));
        case 'web_click': return out(queue('web.click', { selector: String(a.selector) }, x));
        case 'web_input': return out(queue('web.input', { selector: String(a.selector), text: String(a.text ?? ''), mode: String(a.mode ?? 'set') }, x));
        case 'web_key': return out(queue('web.key', { selector: String(a.selector), key: String(a.key) }, x));
        case 'web_close': return out(queue('web.close', {}, x));
        case 'web_find_text': {
            const win = x.windows.find(v => v.app === 'browser');
            const u = String(win?.url || '');
            if (!u)
                return fail('Browser window not open');
            try {
                const page = await fetchWeb(u);
                const html = page.contentType.includes('text/html') ? page.body.toString('utf8') : '';
                const text = stripHtml(html);
                const q = String(a.query || '');
                const idx = text.toLowerCase().indexOf(q.toLowerCase());
                return out({ ok: true, found: idx >= 0, index: idx, context: idx >= 0 ? text.slice(Math.max(0, idx - 250), idx + q.length + 250) : '' });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'web_open_link': {
            const win = x.windows.find(v => v.app === 'browser');
            const u = String(win?.url || '');
            if (!u)
                return fail('Browser window not open');
            try {
                const page = await fetchWeb(u);
                const html = page.contentType.includes('text/html') ? page.body.toString('utf8') : '';
                const links = extractLinks(html, page.finalUrl, Math.min(Math.max(Number(a.index ?? 0) + 1, 1), 500));
                const item = links[Number(a.index ?? 0)];
                if (!item)
                    return fail('Link index not found');
                try {
                    assertNetworkUrl(item.href);
                }
                catch (e) {
                    return fail(String(e instanceof Error ? e.message : e));
                }
                audit(x, 'web_open_link', { from: u, to: item.href }, sessionId);
                return out(queue('web.open', { url: item.href }, x));
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'web_screenshot': return out(queue('screen.screenshot', {}, x));
        case 'workspace_clone': {
            const q = cloneWorkspace(x, String(a.name));
            state.workspaces.set(q.id, q);
            audit(q, 'workspace_clone', { source: x.id }, sessionId);
            return out({ ok: true, id: q.id, name: q.name, manifest: manifest(q) });
        }
        case 'workspace_manifest': return out(manifest(x));
        case 'file_download': {
            try {
                const r = await fetchWeb(String(a.url || ''));
                const bytes = r.body;
                const p = norm(a.path);
                ensureDir(x, parentPath(p));
                x.files[p] = f(bytes.toString('base64'), now(), r.contentType.split(';')[0] || 'application/octet-stream', 'base64');
                touch(x);
                audit(x, 'file_download', { url: r.finalUrl, path: p, size: bytes.byteLength }, sessionId);
                return out({ ok: true, url: r.finalUrl, path: p, size: bytes.byteLength, mime: x.files[p].mime });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'file_upload_prepare': {
            const p = norm(a.path);
            if (!x.files[p])
                return fail('File not found');
            audit(x, 'file_upload_prepare', { path: p }, sessionId);
            return out({ ok: true, path: p, uploadUrl: `/api/upload?path=${encodeURIComponent(p)}` });
        }
        case 'file_permissions_get': {
            const p = norm(a.path);
            if (!x.files[p])
                return fail('Path not found');
            return out({ path: p, permission: permissions(x, p) });
        }
        case 'file_permissions_set': {
            const p = norm(a.path);
            if (!x.files[p])
                return fail('Path not found');
            const perm = String(a.permission);
            if (!['read', 'write', 'execute'].includes(perm))
                return fail('Invalid permission');
            setPermission(x, p, perm);
            audit(x, 'file_permissions_set', { path: p, permission: perm }, sessionId);
            return out({ ok: true, path: p, permission: perm });
        }
        case 'memory_clear_scope': {
            const scope = String(a.scope);
            const keys = Object.entries(x.memory).filter(([, v]) => v.scope === scope).map(([k]) => k);
            keys.forEach(k => delete x.memory[k]);
            touch(x);
            audit(x, 'memory_clear_scope', { scope, count: keys.length }, sessionId);
            return out({ ok: true, scope, deleted: keys });
        }
        case 'memory_tag_add': {
            const key = String(a.key), tag = String(a.tag || '').trim();
            const m = x.memory[key];
            if (!m)
                return fail('Memory not found');
            if (!tag)
                return fail('Tag required');
            if (!m.tags.includes(tag))
                m.tags.push(tag);
            m.updatedAt = now();
            touch(x);
            return out({ ok: true, key, tags: m.tags });
        }
        case 'project_task_set': {
            const name = String(a.name);
            if (!name)
                return fail('Task name required');
            if (!x.projectTasks)
                x.projectTasks = {};
            x.projectTasks[name] = { command: String(a.command), cwd: norm(a.cwd || '/home/user'), description: String(a.description || '') };
            touch(x);
            audit(x, 'project_task_set', { name }, sessionId);
            return out({ ok: true, name, task: x.projectTasks[name] });
        }
        case 'project_task_list': return out(Object.entries(x.projectTasks || {}).map(([name, task]) => ({ name, ...task })));
        case 'project_task_run': {
            const task = x.projectTasks?.[String(a.name)];
            if (!task)
                return fail('Task not found');
            const j = queue('terminal.exec', { command: task.command, cwd: task.cwd }, x);
            audit(x, 'project_task_run', { name: a.name, jobId: j.id }, sessionId);
            return out(j);
        }
        case 'task_result': {
            const id = String(a.jobId);
            const j = x.jobs[id];
            if (!j)
                return fail('Job not found');
            return out({ id: j.id, type: j.type, status: j.status, result: j.result ?? null, error: j.error ?? null, createdAt: j.createdAt, updatedAt: j.updatedAt, startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null, durationMs: j.durationMs ?? null });
        }
        case 'runtime_report': {
            const id = String(a.jobId);
            const j = x.jobs[id];
            if (!j)
                return fail('Job not found');
            return out({ id: j.id, type: j.type, status: j.status, exitCode: j.result?.exitCode ?? null, stdout: j.result?.stdout ?? '', stderr: j.result?.stderr ?? '', durationMs: j.durationMs ?? null, phases: (j.logs || []).map(v => v.phase).filter((v, i, a) => a.indexOf(v) === i), diagnosticCount: (j.diagnostics || []).length, diagnostics: j.diagnostics || [], error: j.error ?? null });
        }
        case 'runtime_logs': {
            const id = String(a.jobId);
            const j = x.jobs[id];
            if (!j)
                return fail('Job not found');
            const level = String(a.level || '');
            return out((j.logs || []).filter(v => !level || v.level === level));
        }
        case 'runtime_diagnostics': {
            const id = String(a.jobId);
            const j = x.jobs[id];
            if (!j)
                return fail('Job not found');
            return out(j.diagnostics || []);
        }
        case 'runtime_clear_logs': {
            const id = String(a.jobId);
            const j = x.jobs[id];
            if (!j)
                return fail('Job not found');
            j.logs = [];
            j.diagnostics = [];
            touch(x);
            return out({ ok: true, id });
        }
        case 'project_run': {
            const name = String(a.name);
            const task = x.projectTasks?.[name];
            if (!task)
                return fail('Task not found');
            const j = queue('terminal.exec', { command: task.command, cwd: task.cwd }, x);
            audit(x, 'project_run', { name, jobId: j.id }, sessionId);
            return out({ ok: true, name, jobId: j.id, command: task.command, cwd: task.cwd });
        }
        case 'project_test': {
            const task = x.projectTasks?.test;
            const command = task?.command || String(x.settings['testCommand'] || '');
            if (!command)
                return fail('No test task configured');
            const cwd = task?.cwd || '/home/user';
            const j = queue('terminal.exec', { command, cwd }, x);
            audit(x, 'project_test', { jobId: j.id, command }, sessionId);
            return out({ ok: true, jobId: j.id, command, cwd });
        }
        case 'project_build': {
            const task = x.projectTasks?.build;
            const command = task?.command || String(x.settings['buildCommand'] || '');
            if (!command)
                return fail('No build task configured');
            const cwd = task?.cwd || '/home/user';
            const j = queue('terminal.exec', { command, cwd }, x);
            audit(x, 'project_build', { jobId: j.id, command }, sessionId);
            return out({ ok: true, jobId: j.id, command, cwd });
        }
        case 'project_run_command': {
            const task = x.projectTasks?.run;
            const command = task?.command || String(x.settings['runCommand'] || '');
            if (!command)
                return fail('No run task configured');
            const cwd = task?.cwd || '/home/user';
            const j = queue('terminal.exec', { command, cwd }, x);
            audit(x, 'project_run_command', { jobId: j.id, command }, sessionId);
            return out({ ok: true, jobId: j.id, command, cwd });
        }
        case 'terminal_env_delete': {
            const key = String(a.key);
            if (!(key in x.terminal.env))
                return out({ ok: false, key, reason: 'Not set' });
            delete x.terminal.env[key];
            touch(x);
            return out({ ok: true, key });
        }
        case 'process_signal': {
            const pid = Number(a.pid);
            const win = x.windows.find(v => v.id === String(pid));
            const j = Object.values(x.jobs).find(q => q.id === String(pid));
            if (j && (a.signal === 'TERM' || a.signal === 'KILL')) {
                finalizeJob(j, 'cancelled', j.result, `Cancelled by ${a.signal}`);
                touch(x);
                return out({ ok: true, pid, signal: a.signal, status: j.status });
            }
            return out({ ok: false, pid, signal: a.signal, reason: 'No signalable virtual process' });
        }
        case 'window_raise': {
            const win = x.windows.find(v => v.id === a.id);
            if (!win)
                return fail('Window not found');
            const z = Math.max(0, ...x.windows.map(v => v.z)) + 1;
            x.windows.forEach(v => v.focused = false);
            win.focused = true;
            win.minimized = false;
            win.z = z;
            touch(x);
            return out({ ok: true, id: win.id, z });
        }
        case 'editor_session': return out(x.editor || { openPaths: [] });
        case 'audit_log': {
            const limit = Math.min(Math.max(Number(a.limit ?? 100), 1), 2000);
            return out((x.audit || []).slice(-limit).reverse());
        }
        case 'audit_clear': {
            x.audit = [];
            touch(x);
            return out({ ok: true });
        }
        case 'state_persistence_status': return out({ enabled: true, file: STATE_FILE, backupFile: BACKUP_FILE, workspaceCount: state.workspaces.size, active: state.active, revision: persistRevision, recoveredFrom: loadedStateFrom || null, backupAvailable: existsSync(BACKUP_FILE) });
        case 'state_persistence_save': {
            try {
                persistState();
                return out({ ok: true, file: STATE_FILE, backupFile: BACKUP_FILE, savedAt: now(), workspaceCount: state.workspaces.size, revision: persistRevision });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'state_persistence_backup': {
            try {
                mkdirSync(join(BACKUP_FILE, '..'), { recursive: true });
                writeAtomic(BACKUP_FILE, JSON.stringify(statePayload()));
                return out({ ok: true, file: BACKUP_FILE, createdAt: now(), revision: persistRevision });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'state_persistence_restore_backup': {
            try {
                if (!existsSync(BACKUP_FILE))
                    return fail('No state backup available');
                const parsed = parseStateFile(BACKUP_FILE);
                state.workspaces = parsed.loaded;
                state.active = parsed.active;
                persistRevision = parsed.revision;
                persistState();
                return out({ ok: true, restoredFrom: BACKUP_FILE, active: state.active, workspaceCount: state.workspaces.size, revision: persistRevision });
            }
            catch (e) {
                return fail(String(e instanceof Error ? e.message : e));
            }
        }
        case 'system_capabilities': return out({ server: 'DeskMCP', version: SERVER_VERSION, mcp: MCP_VERSION, browser: true, wasm: true, virtualFilesystem: true, memory: true, workspaceSnapshots: true, httpsProxy: true, localStorageBrowser: true, sessionIsolation: true, serverPersistence: true });
        case 'security_policy': return out({ bindAddress: '127.0.0.1', httpsOnlyWeb: true, privateNetworkBlocked: true, wasmNoSystemCalls: true, browserSandbox: true, requestBodyLimitBytes: 25000000 });
        case 'workspace_gc': {
            const maxJobs = Math.min(Math.max(Number(a.maxJobs ?? 500), 10), 5000), maxAudit = Math.min(Math.max(Number(a.maxAudit ?? 1000), 10), 5000);
            const jobs = Object.values(x.jobs).sort((a, b) => b.updatedAt - a.updatedAt);
            const oldJobs = jobs.slice(maxJobs);
            oldJobs.forEach(q => delete x.jobs[q.id]);
            if ((x.audit || []).length > maxAudit)
                x.audit = (x.audit || []).slice(-maxAudit);
            touch(x);
            return out({ ok: true, removedJobs: oldJobs.length, auditEntries: (x.audit || []).length });
        }
        default: return fail(`Unknown tool: ${name}`);
    }
}
async function rpc(body, req, sessionId) {
    const method = body?.method;
    const id = body?.id ?? null;
    if (method === 'server/discover')
        return { jsonrpc: '2.0', id, result: { supportedVersions: [MCP_VERSION, '2025-11-25'], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DeskMCP', version: SERVER_VERSION } } };
    if (method === 'initialize') {
        cleanupSessions();
        const sid = randomUUID();
        state.sessions.set(sid, { workspaceId: state.active, createdAt: now(), lastSeenAt: now() });
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DeskMCP', version: SERVER_VERSION }, instructions: 'DeskMCP exposes a persistent browser virtual desktop. Desktop input and WASM jobs execute in the connected DeskMCP browser tab.' }, _sessionId: sid };
    }
    if (method === 'ping')
        return { jsonrpc: '2.0', id, result: {} };
    if (method === 'initialized' || method?.startsWith('notifications/'))
        return null;
    if (method === 'tools/list')
        return { jsonrpc: '2.0', id, result: { tools } };
    if (method === 'tools/call') {
        cleanupSessions();
        const sid = sessionIdFor(sessionId);
        const workspaceId = workspaceIdFor(sid);
        return { jsonrpc: '2.0', id, result: await withWorkspaceLock(workspaceId, () => callTool(body.params?.name, body.params?.arguments ?? {}, sid)) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
function send(res, status, data, type = 'application/json', extraHeaders = {}) { const text = JSON.stringify(data); res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Mcp-Method,MCP-Protocol-Version,Accept', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', ...extraHeaders }); res.end(text); }
async function readBody(req) { let s = ''; for await (const c of req) {
    s += c;
    if (s.length > 25_000_000)
        throw new Error('Body too large');
} return s ? JSON.parse(s) : {}; }
function rewriteWebHtml(html, baseUrl) {
    const base = new URL(baseUrl);
    const proxy = (u) => `/api/web/proxy?url=${encodeURIComponent(new URL(u, base).href)}`;
    return html
        .replace(/<base\s+[^>]*href=["'][^"']*["'][^>]*>/ig, '')
        .replace(/(<(?:a|link|form)\b[^>]*\b(?:href|action)=\s*["'])(https?:\/\/[^"']+)(["'])/ig, (_, a, u, c) => a + proxy(u) + c)
        .replace(/(<(?:img|script|iframe|audio|video|source|track|object)\b[^>]*\bsrc=\s*["'])(https?:\/\/[^"']+)(["'])/ig, (_, a, u, c) => a + proxy(u) + c)
        .replace(/(<(?:a|link|form)\b[^>]*\b(?:href|action)=\s*["'])(?!https?:\/\/)([^"'#]+)(["'])/ig, (_, a, u, c) => a + proxy(new URL(u, base).href) + c)
        .replace(/(<(?:img|script|iframe|audio|video|source|track|object)\b[^>]*\bsrc=\s*["'])(?!https?:\/\/)([^"']+)(["'])/ig, (_, a, u, c) => a + proxy(new URL(u, base).href) + c)
        .replace(/(<meta\s+http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=)([^"']+)/ig, (_, a, u) => a + proxy(new URL(u, base).href));
}
function stripHtml(input) { return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '\"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim(); }
function extractLinks(html, baseUrl, limit = 100) { const out = []; const re = /<a\b[^>]*\bhref\s*=\s*[\"']([^\"'#]+)[\"'][^>]*>([\s\S]*?)<\/a>/gi; let m; while ((m = re.exec(html)) && out.length < limit) {
    try {
        const href = new URL(m[1], baseUrl);
        if (href.protocol !== 'https:')
            continue;
        out.push({ index: out.length, text: stripHtml(m[2]).slice(0, 300), href: href.href });
    }
    catch { }
} return out; }
async function fetchWeb(urlText) {
    let u = assertNetworkUrl(urlText);
    for (let hop = 0; hop < 8; hop++) {
        await assertResolvedPublic(u);
        const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'DeskMCP/4.1' } });
        if ([301, 302, 303, 307, 308].includes(r.status)) {
            const location = r.headers.get('location');
            if (!location)
                throw new Error('Redirect without Location header');
            u = assertNetworkUrl(new URL(location, u).href);
            continue;
        }
        const finalUrl = u.href;
        const type = r.headers.get('content-type') || 'application/octet-stream';
        const body = Buffer.from(await r.arrayBuffer());
        if (body.byteLength > 20_000_000)
            throw new Error('Web response exceeds 20 MB limit');
        return { body, contentType: type, finalUrl, status: r.status };
    }
    throw new Error('Too many HTTPS redirects');
}
async function serveWebProxy(req, res, url) {
    if (req.method !== 'GET')
        return false;
    const target = url.searchParams.get('url');
    if (!target) {
        send(res, 400, { error: 'url required' });
        return true;
    }
    let u;
    try {
        u = assertNetworkUrl(target);
    }
    catch (e) {
        send(res, 400, { error: String(e instanceof Error ? e.message : e) });
        return true;
    }
    try {
        const r = await fetchWeb(u.href);
        let body = r.body;
        let type = r.contentType.split(';')[0] || 'application/octet-stream';
        if (type === 'text/html' || /<html[\s>]/i.test(body.toString('utf8', 0, 2048))) {
            const text = body.toString('utf8');
            const rewritten = rewriteWebHtml(text, r.finalUrl);
            body = Buffer.from(rewritten, 'utf8');
            type = 'text/html';
        }
        res.writeHead(r.status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-DeskMCP-URL': r.finalUrl, 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "frame-ancestors *" });
        res.end(body);
        return true;
    }
    catch (e) {
        send(res, 502, { error: String(e?.message || e) });
        return true;
    }
}
function serveStatic(req, res, url) { if (req.method !== 'GET')
    return false; let p = url.pathname === '/' ? '/index.html' : url.pathname; try {
    p = decodeURIComponent(p);
}
catch { } ; if (p.includes('..')) {
    send(res, 400, { error: 'invalid path' });
    return true;
} const file = join(PUBLIC, p.replace(/^\//, '')); if (!existsSync(file))
    return false; const ext = extname(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' }; res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(readFileSync(file)); return true; }
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        if (req.method === 'OPTIONS') {
            send(res, 204, {});
            return;
        }
        if (url.pathname === '/mcp' && req.method === 'POST') {
            const b = await readBody(req);
            let sid = String(req.headers['mcp-session-id'] || '') || undefined;
            if (sid && !state.sessions.has(sid)) {
                send(res, 400, { error: 'invalid or expired MCP session' });
                return;
            }
            const r = await rpc(b, req, sid);
            if (r === null) {
                res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
                res.end();
            }
            else {
                const sessionHeader = r._sessionId ? { 'Mcp-Session-Id': String(r._sessionId) } : {};
                if (r._sessionId)
                    delete r._sessionId;
                send(res, 200, r, 'application/json', sessionHeader);
                if (sid && state.sessions.has(sid))
                    state.sessions.get(sid).lastSeenAt = now();
            }
            return;
        }
        if (url.pathname === '/health') {
            send(res, 200, { ok: true, name: 'DeskMCP', version: SERVER_VERSION, mcpVersion: MCP_VERSION, browserConnected: state.browserConnected });
            return;
        }
        if (url.pathname === '/api/bootstrap') {
            state.browserConnected = true;
            state.browserSeenAt = now();
            send(res, 200, { workspace: w(), workspaces: [...state.workspaces.values()].map(q => ({ id: q.id, name: q.name, updatedAt: q.updatedAt })), server: { name: 'DeskMCP', version: SERVER_VERSION } });
            return;
        }
        if (url.pathname === '/api/poll') {
            state.browserConnected = true;
            state.browserSeenAt = now();
            const x = w();
            send(res, 200, { workspaceId: x.id, workspace: x, jobs: visibleJobs(x) });
            return;
        }
        if (url.pathname.startsWith('/api/job/') && req.method === 'POST') {
            const id = url.pathname.split('/').pop();
            const q = w().jobs[id];
            if (!q) {
                send(res, 404, { error: 'job not found' });
                return;
            }
            const b = await readBody(req);
            q.status = b?.error ? 'error' : 'done';
            q.result = b?.result;
            q.error = b?.error;
            q.updatedAt = now();
            audit(w(), 'job.complete', { jobId: id, status: q.status });
            touch();
            send(res, 200, q);
            return;
        }
        if (url.pathname === '/api/sync' && req.method === 'POST') {
            const b = await readBody(req);
            let incoming;
            try {
                incoming = sanitizeWorkspace(b.workspace);
            }
            catch (e) {
                send(res, 400, { error: String(e instanceof Error ? e.message : e) });
                return;
            }
            if (incoming.id !== state.active) {
                send(res, 400, { error: 'invalid workspace' });
                return;
            }
            const current = w();
            if (Number(incoming.updatedAt) < Number(current.updatedAt)) {
                send(res, 409, { ok: false, conflict: true, serverUpdatedAt: current.updatedAt, workspace: current });
                return;
            }
            state.workspaces.set(incoming.id, incoming);
            state.browserConnected = true;
            state.browserSeenAt = now();
            schedulePersist();
            send(res, 200, { ok: true, updatedAt: incoming.updatedAt });
            return;
        }
        if (url.pathname === '/api/web/proxy') {
            if (await serveWebProxy(req, res, url))
                return;
        }
        if (url.pathname === '/api/create' && req.method === 'POST') {
            const b = await readBody(req), q = mkWorkspace(String(b?.name || 'Desk Workspace'));
            state.workspaces.set(q.id, q);
            state.active = q.id;
            schedulePersist();
            send(res, 200, q);
            return;
        }
        if (url.pathname === '/api/activate' && req.method === 'POST') {
            const b = await readBody(req);
            if (!state.workspaces.has(b?.id)) {
                send(res, 404, { error: 'not found' });
                return;
            }
            state.active = b.id;
            schedulePersist();
            send(res, 200, w());
            return;
        }
        if (serveStatic(req, res, url))
            return;
        send(res, 404, { error: 'not found' });
    }
    catch (e) {
        send(res, 500, { error: String(e instanceof Error ? e.message : e) });
    }
});
server.listen(PORT, '127.0.0.1', () => console.log(`DeskMCP ${SERVER_VERSION}\nWeb: http://127.0.0.1:${PORT}/\nMCP: http://127.0.0.1:${PORT}/mcp`));
