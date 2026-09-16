import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const port = 9887;
const child = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: String(port), DESKMCP_STATE_FILE: '/tmp/deskmcp-final-smoke-state.json' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(path, opts = {}) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let x = {};
  try { x = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text}`);
  return { response: r, data: x };
}
async function mcp(method, params, sid) {
  const headers = { 'Content-Type': 'application/json' };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const { response, data } = await req('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  return { response, data };
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await req('/health')).data.ok === true; if (ready) break; } catch {}
    await sleep(50);
  }
  if (!ready) throw new Error('server did not start');

  const discovery = await mcp('server/discover', {});
  if (!Array.isArray(discovery.data.result?.supportedVersions) || discovery.data.result.supportedVersions.length === 0) throw new Error('discover failed');

  const init = await mcp('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'deskmcp-final-smoke', version: '1.0.0' }
  });
  const sid = init.response.headers.get('mcp-session-id');
  if (!sid) throw new Error('session id missing');

  const toolsList = await mcp('tools/list', {}, sid);
  const tools = toolsList.data.result?.tools || [];
  if (tools.length < 100) throw new Error(`expected >=100 tools, got ${tools.length}`);
  const names = new Set(tools.map(t => t.name));
  for (const required of ['file_write','file_read','memory_set','workspace_snapshot_create','wasm_run','web_open','browser_tab_open','project_build','runtime_report','state_persistence_backup']) {
    if (!names.has(required)) throw new Error(`missing tool: ${required}`);
  }

  const call = async (name, arguments_ = {}) => (await mcp('tools/call', { name, arguments: arguments_ }, sid)).data;
  await call('file_write', { path: '/home/user/final.txt', content: 'DeskMCP final' });
  const read = await call('file_read', { path: '/home/user/final.txt' });
  if (!JSON.stringify(read).includes('DeskMCP final')) throw new Error('filesystem failed');
  await call('memory_set', { key: 'final-check', value: 'ok', scope: 'project', tags: ['release'] });
  const mem = await call('memory_get', { key: 'final-check' });
  if (!JSON.stringify(mem).includes('ok')) throw new Error('memory failed');
  await call('project_task_set', { name: 'test', command: 'echo final' });
  const manifest = await call('workspace_manifest', {});
  if (!JSON.stringify(manifest).includes('fileCount')) throw new Error('manifest failed');
  const security = await call('security_policy', {});
  if (!JSON.stringify(security).includes('privateNetworkBlocked')) throw new Error('security policy failed');
  const badHttp = await call('web_open', { url: 'http://example.com' });
  if (!badHttp.result?.isError) throw new Error('HTTP should be rejected');
  const loopback = await call('web_open', { url: 'https://127.0.0.1/' });
  if (!loopback.result?.isError) throw new Error('loopback should be rejected');
  const tab = await call('browser_tab_open', { url: 'https://example.com', title: 'Example' });
  if (tab.result?.isError) throw new Error('tab open failed');
  const list = await call('browser_tab_list', {});
  if (!JSON.stringify(list).includes('activeTabId')) throw new Error('tab list failed');
  await call('state_persistence_backup', {});
  await call('state_persistence_status', {});

  console.log(`DeskMCP final smoke: PASS (${tools.length} tools)`);
} finally {
  child.kill('SIGTERM');
  await sleep(100);
}
