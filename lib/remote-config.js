'use strict';

// Send this program over SSH stdin (python3 -), never in process arguments or logs.
// Both initial provisioning and tunnel repair use exactly the same migration.
function buildRemoteConfigPy({ node, port, token, autoAllowHostExec = false }) {
  const payload = Buffer.from(JSON.stringify({
    workDir: node.remoteWorkDir || '/root/work',
    url: `http://127.0.0.1:${port}/mcp?node=${encodeURIComponent(node.id)}`,
    token, autoAllowHostExec,
  })).toString('base64');
  return `import base64, json, os, subprocess, tempfile
p = json.loads(base64.b64decode('${payload}'))

def load_object(filename):
    if not os.path.exists(filename):
        return {}
    with open(filename, encoding='utf-8') as f:
        obj = json.load(f)
    if not isinstance(obj, dict):
        raise ValueError('Expected JSON object: ' + filename)
    return obj

def save_private(filename, obj):
    directory = os.path.dirname(filename)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.takt-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write('\\n')
        os.replace(temp, filename)
    finally:
        if os.path.exists(temp): os.unlink(temp)

claude_file = os.path.expanduser('~/.claude.json')
settings_file = os.path.expanduser('~/.claude/settings.json')
config = load_object(claude_file)
settings = load_object(settings_file)
servers = config.setdefault('mcpServers', {})
permissions = settings.setdefault('permissions', {})
if not isinstance(servers, dict) or not isinstance(permissions, dict):
    raise ValueError('Invalid mcpServers or permissions; configuration left unchanged')
for key in ('allow', 'ask', 'deny'):
    if key in permissions and not isinstance(permissions[key], list):
        raise ValueError('Invalid permissions.' + key)

servers.pop('mac-industrial-mcp', None)
servers['mac-industrial'] = {'type': 'http', 'url': p['url'],
    'headers': {'Authorization': 'Bearer ' + p['token']}}
host_rule = 'mcp__mac-industrial__mac_host_exec'
legacy = {'mcp__mac-industrial', 'mcp__mac-industrial__*', host_rule,
          'mcp__mac-industrial-mcp', 'mcp__mac-industrial-mcp__*',
          'mcp__mac-industrial-mcp__mac_host_exec'}
permissions['allow'] = [r for r in permissions.get('allow', []) if r not in legacy]
permissions['ask'] = [r for r in permissions.get('ask', []) if r != host_rule]
permissions['allow' if p['autoAllowHostExec'] else 'ask'].append(host_rule)

work_dir = p['workDir']
try:
    os.makedirs(work_dir, exist_ok=True)
except OSError:
    work_dir = os.path.expanduser('~/work')
    os.makedirs(work_dir, exist_ok=True)
# Write the restrictive permissions before publishing the authenticated transport.
save_private(settings_file, settings)
save_private(claude_file, config)
auth_cache = os.path.expanduser('~/.claude/mcp-needs-auth-cache.json')
if os.path.exists(auth_cache):
    try:
        cache = load_object(auth_cache)
        cache.pop('mac-industrial', None)
        cache.pop('mac-industrial-mcp', None)
        save_private(auth_cache, cache)
    except (ValueError, OSError):
        pass
device_id = ''
try:
    result = subprocess.run(['syncthing', '--device-id'], capture_output=True, text=True, timeout=2)
    if result.returncode == 0 and result.stdout.strip(): device_id = result.stdout.strip().splitlines()[0]
except (OSError, subprocess.TimeoutExpired):
    pass
print(json.dumps({'ok': True, 'workDir': work_dir, 'mcpUrl': p['url'], 'syncthingDeviceId': device_id}))
`;
}

module.exports = { buildRemoteConfigPy };
