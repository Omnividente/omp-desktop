#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['OMP_SCOPE_TEST_ROOT'])
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
mode = (root / 'mode').read_text()
path = root / 'config.yml'
state = json.loads(path.read_text()) if path.exists() else {}
project = json.loads((root / 'project.json').read_text())
def raw(key):
    value = state
    for part in key.split('.'):
        if not isinstance(value, dict) or part not in value: return None, False
        value = value[part]
    return value, True
def effective(key):
    value, present = raw(key)
    if key in project:
        inherited = project[key]
        if isinstance(value, dict) and isinstance(inherited, dict): return {**value, **inherited}
        return inherited
    return value if present else ([] if key == 'task.disabledAgents' else {} if key == 'task.agentModelOverrides' else False)
def listing(scoped):
    result = {}
    for key, kind in [('task.agentModelOverrides','record'), ('task.disabledAgents','array')]:
        value, present = raw(key)
        if not scoped or present:
            result[key] = {'type':kind, 'value':value if scoped else effective(key)}
    return result
def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)
if args[0:2] == ['config','path']:
    print(root)
elif '--scope' in args and mode == 'old-parser':
    fail('Unknown flag: --scope')
elif '--scope' in args and mode not in ['legacy-wrapper', 'legacy-new-help'] and args[1] != 'list':
    fail('--scope applies to `config list` only')
elif args[0:2] == ['config','list']:
    scoped = '--scope' in args and mode not in ['legacy-wrapper', 'legacy-new-help']
    result = json.loads(json.dumps(listing(scoped)))
    if scoped and mode == 'invalid-list': result = []
    if scoped and mode == 'hidden-race':
        counter = root / 'reads'
        n = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(n + 1))
        if n == 0:
            state['task']['agentModelOverrides']['hidden'] = 'synthetic/concurrent'
            path.write_text(json.dumps(state))
    print(json.dumps(result))
elif args[0:2] == ['config','get']:
    print(json.dumps({'key':args[2], 'value':effective(args[2])}))
elif args[0:2] == ['config','set']:
    key = args[2]
    if mode == 'fail-second' and key == 'task.disabledAgents': fail('synthetic second write failure')
    parent = state
    parts = key.split('.')
    for part in parts[:-1]: parent = parent.setdefault(part,{})
    parent[parts[-1]] = json.loads(args[3])
    if mode == 'foreign-during-write': state['unknown'] = 'external'
    path.write_text(json.dumps(state))
    if mode == 'fail-after-write': fail('synthetic failure after write')
    print(json.dumps({'key':key, 'value':parent[parts[-1]]}))
else:
    fail('Unsupported synthetic command')
