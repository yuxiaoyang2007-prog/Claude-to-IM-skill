/**
 * Patch V2: Enhanced /sessions + /switch commands for claude-to-im bridge.
 *
 * This patches node_modules/claude-to-im/dist/lib/bridge/bridge-manager.js
 *
 * Features:
 * - /sessions: Shows ALL Claude Code sessions (IM-bound + terminal-created)
 * - Sorted by last activity time (most recent first), up to 15 sessions
 * - Marks current session with ◀, shows last user message preview
 * - /switch <n>: Switch to any session by number (IM or CLI)
 *   - IM sessions: rebinds the current chat to the target session
 *   - CLI sessions: creates a new bridge binding with the CLI session's sdkSessionId
 *
 * Run automatically via postinstall, or manually: node scripts/patch-sessions-preview.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = join(__dirname, '..', 'node_modules', 'claude-to-im', 'dist', 'lib', 'bridge', 'bridge-manager.js');

if (!existsSync(TARGET)) {
  console.log('[patch] Target not found, skipping (not yet installed?)');
  process.exit(0);
}

let code = readFileSync(TARGET, 'utf-8');

// ── Guard: skip if already patched with V2 ──
if (code.includes('PATCH_SESSIONS_V2')) {
  console.log('[patch] Already at V2, skipping.');
  process.exit(0);
}

// ── Strip V1 patch if present ──
if (code.includes('_scanAllSessions') && !code.includes('PATCH_SESSIONS_V2')) {
  console.log('[patch] V1 detected — stripping to re-apply as V2...');
  // V1 is in-place, we need a clean copy. Just re-download.
  console.error('[patch] Cannot auto-strip V1. Please run: rm -rf node_modules/claude-to-im && npm install');
  process.exit(1);
}

// ── 1. Inject helper functions after the last existing import ──
const HELPERS = `
// PATCH_SESSIONS_V2
import { readFileSync as _readFileSync, existsSync as _existsSync, readdirSync as _readdirSync, statSync as _statSync } from 'node:fs';
import { join as _join, basename as _basename } from 'node:path';
import { homedir as _homedir } from 'node:os';

function _cleanPreview(raw, maxLen) {
    let t = raw;
    t = t.replace(/^\\[sender:\\s*[^\\]]*\\]\\s*/, '');
    t = t.replace(/<[^>]*>/g, '');
    t = t.replace(/\\*\\*([^*]*)\\*\\*/g, '$1');
    t = t.replace(/\\*([^*]*)\\*/g, '$1');
    const BT = String.fromCharCode(96);
    t = t.replace(new RegExp(BT + '{1,3}[^' + BT + ']*' + BT + '{1,3}', 'g'), '');
    t = t.replace(/^#{1,6}\\s+/gm, '');
    t = t.replace(/\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1');
    t = t.replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '');
    t = t.replace(/^\\s*[-*+]\\s+/gm, '');
    t = t.replace(/^\\s*\\d+\\.\\s+/gm, '');
    t = t.replace(/\\|/g, ' ');
    t = t.replace(/\\n+/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length > maxLen) t = t.slice(0, maxLen) + '\\u2026';
    return t;
}

function _extractLastText(jsonLines, maxLen) {
    for (let i = jsonLines.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(jsonLines[i]);
            if ((obj.type === 'user' || obj.type === 'assistant') && obj.message?.role) {
                const content = obj.message.content;
                let raw = '';
                if (typeof content === 'string') { raw = content; }
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block?.type === 'text' && block.text) { raw = block.text; break; }
                    }
                }
                if (!raw) continue;
                const firstLine = raw.split('\\n')[0].trim();
                if (/^\\/(clear|compact|help|init|sessions|switch)/.test(firstLine)) continue;
                if (/^\\[.*\\d{4}-\\d{2}-\\d{2}/.test(firstLine) || /^\\[.*GMT/.test(firstLine)) continue;
                if (/^Caveat:|^<system-reminder>|^<command-|^<local-command/.test(firstLine)) continue;
                const cleaned = _cleanPreview(raw, maxLen);
                if (!cleaned) continue;
                return cleaned;
            }
        } catch { continue; }
    }
    return '';
}

function _getSessionPreviewFromFile(jsonlPath, maxLen = 45) {
    try {
        if (!_existsSync(jsonlPath)) return '';
        const fs = require('node:fs');
        const fd = fs.openSync(jsonlPath, 'r');
        const size = fs.fstatSync(fd).size;
        const tailSize = Math.min(size, 65536);
        const tailBuf = Buffer.alloc(tailSize);
        fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, size - tailSize));
        const tailLines = tailBuf.toString('utf-8').trimEnd().split('\\n');
        let result = _extractLastText(tailLines, maxLen);
        if (!result && size > tailSize) {
            const headSize = Math.min(size, 16384);
            const headBuf = Buffer.alloc(headSize);
            fs.readSync(fd, headBuf, 0, headSize, 0);
            const headLines = headBuf.toString('utf-8').trimEnd().split('\\n');
            result = _extractLastText(headLines.reverse(), maxLen);
        }
        fs.closeSync(fd);
        return result;
    } catch { }
    return '';
}

function _scanAllSessions(boundSdkIds, limit = 20) {
    const projectsRoot = _join(_homedir(), '.claude', 'projects');
    if (!_existsSync(projectsRoot)) return [];
    const results = [];
    try {
        const projectDirs = _readdirSync(projectsRoot, { withFileTypes: true })
            .filter(d => d.isDirectory());
        for (const pd of projectDirs) {
            const pdPath = _join(projectsRoot, pd.name);
            let entries;
            try { entries = _readdirSync(pdPath, { withFileTypes: true }); } catch { continue; }
            for (const f of entries) {
                if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
                const sessionId = f.name.replace('.jsonl', '');
                if (boundSdkIds.has(sessionId)) continue;
                const fullPath = _join(pdPath, f.name);
                try {
                    const st = _statSync(fullPath);
                    results.push({
                        sdkSessionId: sessionId,
                        projectDir: pd.name,
                        filePath: fullPath,
                        mtime: st.mtimeMs,
                        source: 'terminal'
                    });
                } catch { continue; }
            }
        }
    } catch { }
    results.sort((a, b) => b.mtime - a.mtime);
    return results.slice(0, limit);
}

function _getCwdFromSession(filePath) {
    try {
        const fs = require('node:fs');
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const head = buf.toString('utf-8', 0, bytesRead);
        for (const line of head.split('\\n').slice(0, 10)) {
            try {
                const obj = JSON.parse(line);
                if (obj.cwd) return obj.cwd;
            } catch {}
        }
    } catch {}
    return null;
}

function _buildAllEntries(bindings) {
    const boundSdkIds = new Set();
    const allEntries = [];
    for (const b of bindings) {
        if (b.sdkSessionId) boundSdkIds.add(b.sdkSessionId);
        let mtime = 0;
        if (b.sdkSessionId) {
            try {
                const pDir = (b.workingDirectory || '~').replace(/[^a-zA-Z0-9.]/g, '-');
                const jp = _join(_homedir(), '.claude', 'projects', pDir, b.sdkSessionId + '.jsonl');
                mtime = _statSync(jp).mtimeMs;
            } catch {}
        }
        if (!mtime && b.updatedAt) mtime = new Date(b.updatedAt).getTime();
        if (!mtime && b.createdAt) mtime = new Date(b.createdAt).getTime();
        allEntries.push({ type: 'im', binding: b, mtime });
    }
    const termSessions = _scanAllSessions(boundSdkIds, 20);
    for (const ts of termSessions) {
        allEntries.push({ type: 'terminal', ...ts });
    }
    allEntries.sort((a, b) => b.mtime - a.mtime);
    return allEntries.slice(0, 15);
}
`;

const ANCHOR_IMPORT = "from './security/validators.js';";
const importIdx = code.indexOf(ANCHOR_IMPORT);
if (importIdx === -1) {
  console.error('[patch] Could not find anchor import. Bridge manager format may have changed.');
  process.exit(1);
}
const insertPos = importIdx + ANCHOR_IMPORT.length;
code = code.slice(0, insertPos) + '\n' + HELPERS + code.slice(insertPos);

// ── 2. Replace the /sessions case ──
const OLD_SESSIONS = `case '/sessions': {
            const bindings = router.listBindings(adapter.channelType);
            if (bindings.length === 0) {
                response = 'No sessions found.';
            }
            else {
                const lines = ['<b>Sessions:</b>', ''];
                for (const b of bindings.slice(0, 10)) {
                    const active = b.active ? 'active' : 'inactive';
                    lines.push(\`<code>\${b.codepilotSessionId.slice(0, 8)}...</code> [\${active}] \${escapeHtml(b.workingDirectory || '~')}\`);
                }
                response = lines.join('\\n');
            }
            break;
        }`;

const NEW_SESSIONS = `case '/sessions': {
            const bindings = router.listBindings(adapter.channelType);
            const currentBinding = router.resolve(msg.address);
            const allEntries = _buildAllEntries(bindings);

            if (allEntries.length === 0) {
                response = 'No sessions found.';
            } else {
                const lines = ['<b>Sessions:</b>', ''];
                for (let i = 0; i < allEntries.length; i++) {
                    const e = allEntries[i];
                    if (e.type === 'im') {
                        const b = e.binding;
                        const isCurrent = currentBinding && b.codepilotSessionId === currentBinding.codepilotSessionId;
                        const marker = isCurrent ? ' \\u25C0' : '';
                        const id = (b.sdkSessionId || b.codepilotSessionId).slice(0, 8);
                        const pDir = (b.workingDirectory || '~').replace(/[^a-zA-Z0-9.]/g, '-');
                        const jp = require('node:path').join(require('node:os').homedir(), '.claude', 'projects', pDir, (b.sdkSessionId || '') + '.jsonl');
                        const preview = _getSessionPreviewFromFile(jp);
                        const previewLine = preview ? \`\\n    \\uD83D\\uDCAC \${escapeHtml(preview)}\` : '';
                        lines.push(\`<b>\${i + 1}.</b> <code>\${id}</code> [IM]\${marker}\${previewLine}\`);
                    } else {
                        const id = e.sdkSessionId.slice(0, 8);
                        const label = _getCwdFromSession(e.filePath) || e.projectDir;
                        const preview = _getSessionPreviewFromFile(e.filePath);
                        const previewLine = preview ? \`\\n    \\uD83D\\uDCAC \${escapeHtml(preview)}\` : '';
                        lines.push(\`<b>\${i + 1}.</b> <code>\${id}</code> [CLI] \${escapeHtml(label)}\${previewLine}\`);
                    }
                }
                lines.push('');
                lines.push('/switch &lt;n&gt; to switch session');
                response = lines.join('\\n');
            }
            break;
        }`;

if (!code.includes(OLD_SESSIONS)) {
  console.error('[patch] Could not find original /sessions handler. Was V1 partially applied?');
  process.exit(1);
}
code = code.replace(OLD_SESSIONS, NEW_SESSIONS);

// ── 3. Inject /switch case before default ──
const OLD_DEFAULT = `        default:
            response = \`Unknown command: \${escapeHtml(command)}\\nType /help for available commands.\`;`;

const NEW_SWITCH_AND_DEFAULT = `        case '/switch': {
            const n = parseInt(args, 10);
            if (!n || n < 1) {
                response = 'Usage: /switch &lt;n&gt; (use /sessions to see the list)';
                break;
            }
            const swBindings = router.listBindings(adapter.channelType);
            const swEntries = _buildAllEntries(swBindings);
            if (n > swEntries.length) {
                response = \`Session #\${n} not found. Only \${swEntries.length} session(s) available.\`;
                break;
            }
            const target = swEntries[n - 1];
            // Abort running task on old session
            const oldBinding = router.resolve(msg.address);
            const st = getState();
            const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
            if (oldTask) {
                oldTask.abort();
                st.activeTasks.delete(oldBinding.codepilotSessionId);
            }
            if (target.type === 'im') {
                const result = router.bindToSession(msg.address, target.binding.codepilotSessionId);
                if (result) {
                    const id = (target.binding.sdkSessionId || target.binding.codepilotSessionId).slice(0, 8);
                    response = \`Switched to session <code>\${id}</code> [IM]\`;
                } else {
                    response = 'Failed to switch — session not found in store.';
                }
            } else {
                // CLI session: create new bridge binding, then set sdkSessionId to resume
                const cwd = _getCwdFromSession(target.filePath) || undefined;
                const newBinding = router.createBinding(msg.address, cwd);
                router.updateBinding(newBinding.id, { sdkSessionId: target.sdkSessionId });
                const id = target.sdkSessionId.slice(0, 8);
                response = \`Switched to session <code>\${id}</code> [CLI]\\nCWD: <code>\${escapeHtml(cwd || '~')}</code>\\n\\n<i>Next message will resume this CLI session.</i>\`;
            }
            break;
        }
        default:
            response = \`Unknown command: \${escapeHtml(command)}\\nType /help for available commands.\`;`;

if (!code.includes(OLD_DEFAULT)) {
  console.error('[patch] Could not find default case to inject /switch.');
  process.exit(1);
}
code = code.replace(OLD_DEFAULT, NEW_SWITCH_AND_DEFAULT);

// ── 4. Patch /start and /help to include /switch ──
// Use unique surrounding context to avoid double-replace
const OLD_START_SESSIONS = `'/sessions - List recent sessions',
                '/stop - Stop current session',
                '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',`;
const NEW_START_SESSIONS = `'/sessions - List recent sessions',
                '/switch &lt;n&gt; - Switch to session by number',
                '/stop - Stop current session',
                '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',`;
code = code.replace(OLD_START_SESSIONS, NEW_START_SESSIONS);

const OLD_HELP_SESSIONS = `'/sessions - List recent sessions',
                '/stop - Stop current session',
                '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',`;
const NEW_HELP_SESSIONS = `'/sessions - List recent sessions',
                '/switch &lt;n&gt; - Switch to session by number',
                '/stop - Stop current session',
                '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',`;
code = code.replace(OLD_HELP_SESSIONS, NEW_HELP_SESSIONS);

writeFileSync(TARGET, code, 'utf-8');
console.log('[patch] V2 patched successfully (/sessions + /switch).');
