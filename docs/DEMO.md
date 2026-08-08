# Demo GIF / vídeo (15–30s)

Demo atual no repo:

```text
docs/images/grokweb.mp4   # vídeo principal (README)
docs/images/page.jpg      # poster / still
```

O README já embute o MP4 + link de download. Se preferir GIF (mais compatível em alguns feeds):

```bash
ffmpeg -i docs/images/grokweb.mp4 -vf "fps=12,scale=960:-1:flags=lanczos" -loop 0 docs/images/demo.gif
```

E no README use:

```markdown
![Grok Web demo](docs/images/demo.gif)
```

## Roteiro (shot list)

| # | Segundos | O que mostrar | Dica |
|---|----------|---------------|------|
| 1 | 0–4s | Terminal: `npm run web` + browser abrindo | Fonte legível, zoom 110% |
| 2 | 4–12s | Chat: enviar prompt, streaming de texto + thinking + 1–2 tool cards | CWD num projeto real |
| 3 | 12–20s | Inspector **Arquivos**: lista Changes + abrir um diff | Working tree com mudanças |
| 4 | 20–28s | Composer: trocar **modelo/nível** · Grok ocupado + mensagem na **fila** | Badge Ativo / busy |
| 5 | 28–30s | Freeze no layout completo (sidebar + chat + inspector) | Frame final = hero |

Total alvo: **15–30 segundos**. Sem áudio obrigatório; se tiver, voz baixa / legendas curtas.

## Ferramentas

- **Linux / WSL + Windows:** [Peek](https://github.com/phw/peek), OBS, ShareX, ou gravar a janela e cortar  
- **macOS:** `Cmd+Shift+5` ou Kap  
- **Browser:** DevTools → mais zoom se a UI ficar pequena  

### Converter MP4 → GIF (ffmpeg)

```bash
ffmpeg -i demo.mp4 -vf "fps=12,scale=960:-1:flags=lanczos" -loop 0 docs/images/demo.gif
```

Mantenha o GIF **&lt; ~8–12 MB** se possível (GitHub raw).

## Checklist pré-post

- [ ] GIF/vídeo no path do README  
- [ ] Frase de impacto EN + PT no topo  
- [ ] Badges ok  
- [ ] Topics do repo aplicados no GitHub  
- [ ] README sem secrets / paths pessoais desnecessários  
- [ ] `npm run web` funciona em máquina limpa (com `grok login`)  
