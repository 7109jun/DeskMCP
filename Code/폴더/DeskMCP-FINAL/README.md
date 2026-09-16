# DeskMCP 5.0.0 FINAL

DeskMCP is now distributed as JavaScript. The original TypeScript source is retained under `legacy/` for reference; runtime and build use JavaScript only.

## Run

```bash
npm run build
npm test
npm start
```

Web UI: `http://127.0.0.1:8787/`

MCP: `http://127.0.0.1:8787/mcp`

## Architecture

- JavaScript / Node.js server
- Browser virtual desktop
- MCP JSON-RPC sessions
- Persistent workspaces and snapshots
- Virtual filesystem, terminal, windows and editor
- AI memory and project settings
- WebAssembly execution
- HTTPS web navigation and browser automation
- Runtime diagnostics and audit logs
- LocalStorage browser persistence + server state backup/restore

The server is dependency-free at runtime.
