# Grok Web

Cliente ACP em browser para o **Grok Build**.

## Quick facts

| Item | Valor |
|------|--------|
| Agent | `grok agent serve` → WebSocket `ws://127.0.0.1:2419/ws?server-key=…` |
| UI | Next.js em `127.0.0.1:3847` |
| Launcher | `npm run web` → `bin/grok-web.mjs` |
| Docs | [README.md](./README.md) (setup, uso, APIs, troubleshooting) |

## Regras

- **Não confundir com grok.com.** Tools rodam no agent local, não no Next.js.
- Preferir mudanças mínimas e focadas; UI em `src/components`, domínio em `src/lib`, rotas em `src/app/api`.
- FS sandbox: leitura `$HOME` (+ `/tmp`); escrita só `$HOME`.
- Sessões/MCP/skills: dados em `~/.grok` (compartilhado com o TUI).

## Comandos úteis

```bash
npm install
npm run web          # agent + UI
npm run dev          # só UI (agent já up)
npx tsc --noEmit
```
