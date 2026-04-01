#!/usr/bin/env bash
# Patch bridge-manager to inject sender display name into prompt text.
# Run after npm install/update, then rebuild: npm run build
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$SKILL_DIR/node_modules/claude-to-im/dist/lib/bridge/bridge-manager.js"

if grep -q 'CTI_USER_DISPLAY_NAMES' "$TARGET" 2>/dev/null; then
  echo "Already patched: $TARGET"
  exit 0
fi

# Replace the promptText line with sender identity injection
python3 -c "
import re, sys
with open('$TARGET', 'r') as f:
    content = f.read()
old = '''        const promptText = text || (hasAttachments ? 'Describe this image.' : '');
        const result = await engine.processMessage(binding, promptText, async (perm) => {'''
new = '''        let promptText = text || (hasAttachments ? 'Describe this image.' : '');
        // Inject sender identity into prompt if user display name mapping is configured
        if (msg.address.userId && promptText) {
            const nameMap = process.env.CTI_USER_DISPLAY_NAMES || '';
            if (nameMap) {
                const entry = nameMap.split(',').find((e) => e.startsWith(msg.address.userId + '='));
                if (entry) {
                    const displayName = entry.split('=').slice(1).join('=');
                    promptText = \\\`[sender: \\\${displayName}] \\\${promptText}\\\`;
                }
            }
        }
        const result = await engine.processMessage(binding, promptText, async (perm) => {'''
if old not in content:
    print('ERROR: Could not find target code block. bridge-manager.js may have changed.', file=sys.stderr)
    sys.exit(1)
content = content.replace(old, new, 1)
with open('$TARGET', 'w') as f:
    f.write(content)
print('Patched successfully.')
"

echo "Now rebuild: cd '$SKILL_DIR' && npm run build"
