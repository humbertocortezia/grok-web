
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type DiffFileRow = { code: string; path: string };

export type DiffLine = {
  type: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
};

export type FileDiff = {
  path: string;
  lines: DiffLine[];
};

type TreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
};

type ViewMode = "diff" | "edit";
type SideTab = "changed" | "tree";

type Props = {
  cwd: string;
  /** Optional seed from parent poll — light status list */
  seedFiles?: DiffFileRow[];
  branchHint?: string;
  onSaved?: () => void;
};

function relPath(cwd: string, abs: string): string {
  if (abs === cwd) return ".";
  if (abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
  return abs.replace(/\/home\/[^/]+/, "~");
}

function statusColor(code: string) {
  if (code.includes("A") || code === "??") return "text-[var(--ok)]";
  if (code.includes("D")) return "text-[var(--danger,#f87171)]";
  return "text-[var(--accent-2,#a78bfa)]";
}

export function FileWorkbench({ cwd, seedFiles, branchHint, onSaved }: Props) {
  const [side, setSide] = useState<SideTab>("changed");
  const [mode, setMode] = useState<ViewMode>("diff");
  const [files, setFiles] = useState<DiffFileRow[]>(seedFiles || []);
  const [branch, setBranch] = useState(branchHint || "");
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [selectedRel, setSelectedRel] = useState<string | null>(null);
  const [selectedAbs, setSelectedAbs] = useState<string | null>(null);

  // Diff cache per relative path
  const [diffCache, setDiffCache] = useState<Record<string, FileDiff | null>>({});
  const [diffLoading, setDiffLoading] = useState(false);

  // Editor
  const [editContent, setEditContent] = useState("");
  const [editOriginal, setEditOriginal] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // Tree
  const [treeRoot, setTreeRoot] = useState<TreeEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TreeEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [treeLoading, setTreeLoading] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState("");

  const dirty = editContent !== editOriginal;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshStatus = useCallback(async () => {
    if (!cwd) return;
    setLoadingStatus(true);
    try {
      const res = await fetch(
        `/api/diffs?cwd=${encodeURIComponent(cwd)}&light=1`
      );
      const data = await res.json();
      if (data.ok) {
        setFiles(data.files || []);
        setBranch(data.branchLine || "");
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingStatus(false);
    }
  }, [cwd]);

  useEffect(() => {
    setFiles(seedFiles || []);
  }, [seedFiles]);

  useEffect(() => {
    void refreshStatus();
    setDiffCache({});
    setSelectedRel(null);
    setSelectedAbs(null);
    setEditContent("");
    setEditOriginal("");
    setExpanded({});
    setOpenDirs(new Set());
    setTreeRoot([]);
  }, [cwd, refreshStatus]);

  const loadTree = useCallback(
    async (dirPath: string) => {
      setTreeLoading(dirPath);
      try {
        const res = await fetch(
          `/api/fs/tree?path=${encodeURIComponent(dirPath)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "tree failed");
        const entries = (data.entries || []) as TreeEntry[];
        if (dirPath === cwd) setTreeRoot(entries);
        else setExpanded((prev) => ({ ...prev, [dirPath]: entries }));
      } catch {
        if (dirPath === cwd) setTreeRoot([]);
      } finally {
        setTreeLoading(null);
      }
    },
    [cwd]
  );

  useEffect(() => {
    if (side === "tree" && treeRoot.length === 0 && cwd) {
      void loadTree(cwd);
    }
  }, [side, treeRoot.length, cwd, loadTree]);

  async function toggleDir(dirPath: string) {
    const willOpen = !openDirs.has(dirPath);
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(dirPath);
      else next.delete(dirPath);
      return next;
    });
    if (willOpen && !expanded[dirPath]) {
      await loadTree(dirPath);
    }
  }

  async function openFile(rel: string, abs?: string) {
    setSelectedRel(rel);
    const absolute = abs || `${cwd}/${rel}`.replace(/\/+/g, "/");
    setSelectedAbs(absolute);
    setEditError(null);

    // Prefer diff when file is in changed list
    const inChanged = files.some((f) => f.path === rel);
    if (inChanged && mode === "diff") {
      await loadDiff(rel);
    }
    if (mode === "edit" || !inChanged) {
      if (!inChanged) setMode("edit");
      await loadEdit(absolute);
    }
  }

  async function loadDiff(rel: string) {
    if (diffCache[rel]) return;
    setDiffLoading(true);
    try {
      const res = await fetch(
        `/api/diffs?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`
      );
      const data = await res.json();
      if (data.ok && data.fileDiffs?.length) {
        // match path
        const hit =
          (data.fileDiffs as FileDiff[]).find(
            (f) => f.path === rel || f.path.endsWith("/" + rel)
          ) || data.fileDiffs[0];
        setDiffCache((prev) => ({ ...prev, [rel]: hit }));
      } else {
        setDiffCache((prev) => ({ ...prev, [rel]: null }));
      }
    } catch {
      setDiffCache((prev) => ({ ...prev, [rel]: null }));
    } finally {
      setDiffLoading(false);
    }
  }

  async function loadEdit(absolute: string) {
    setEditLoading(true);
    setEditError(null);
    try {
      const res = await fetch("/api/fs/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: absolute, raw: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "read failed");
      }
      setEditContent(data.content || "");
      setEditOriginal(data.content || "");
      setTruncated(Boolean(data.truncated));
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "read failed");
      setEditContent("");
      setEditOriginal("");
    } finally {
      setEditLoading(false);
    }
  }

  async function saveFile() {
    if (!selectedAbs || !dirty || truncated) return;
    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch("/api/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedAbs, content: editContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "save failed");
      setEditOriginal(editContent);
      // invalidate diff for this file
      if (selectedRel) {
        setDiffCache((prev) => {
          const next = { ...prev };
          delete next[selectedRel];
          return next;
        });
      }
      await refreshStatus();
      onSaved?.();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (mode === "diff" && selectedRel) {
      void loadDiff(selectedRel);
    }
    if (mode === "edit" && selectedAbs) {
      void loadEdit(selectedAbs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function onEditorKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void saveFile();
    }
  }

  const activeDiff = selectedRel ? diffCache[selectedRel] : null;
  const activeCode =
    files.find((f) => f.path === selectedRel)?.code ||
    (selectedRel ? "·" : "");

  const filteredChanged = useMemo(() => {
    const q = treeFilter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, treeFilter]);

  function renderTree(entries: TreeEntry[], depth: number) {
    const q = treeFilter.trim().toLowerCase();
    return entries
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.type === "dir")
      .map((ent) => {
        if (ent.type === "dir") {
          const open = openDirs.has(ent.path);
          const kids = expanded[ent.path];
          return (
            <div key={ent.path}>
              <button
                type="button"
                className="fw-tree-row"
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => void toggleDir(ent.path)}
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
                )}
                {open ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                )}
                <span className="truncate">{ent.name}</span>
                {treeLoading === ent.path ? (
                  <Loader2 className="ml-auto h-3 w-3 animate-spin opacity-50" />
                ) : null}
              </button>
              {open && kids ? renderTree(kids, depth + 1) : null}
            </div>
          );
        }
        const rel = relPath(cwd, ent.path);
        const on = selectedAbs === ent.path;
        return (
          <button
            key={ent.path}
            type="button"
            className={cn("fw-tree-row", on && "is-active")}
            style={{ paddingLeft: 8 + depth * 12 + 16 }}
            onClick={() => void openFile(rel, ent.path)}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-45" />
            <span className="truncate">{ent.name}</span>
          </button>
        );
      });
  }

  return (
    <div className="fw-root">
      {/* Toolbar */}
      <div className="fw-toolbar">
        <div className="fw-toolbar-left min-w-0">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
          <span className="truncate font-mono text-[10px] text-[var(--muted)]" title={cwd}>
            {branch || relPath("/home", cwd)}
          </span>
        </div>
        <div className="fw-toolbar-right">
          <div className="fw-seg">
            <button
              type="button"
              className={cn(mode === "diff" && "is-on")}
              onClick={() => setMode("diff")}
            >
              Diff
            </button>
            <button
              type="button"
              className={cn(mode === "edit" && "is-on")}
              onClick={() => setMode("edit")}
              disabled={!selectedAbs && !selectedRel}
            >
              Edit
            </button>
          </div>
          <button
            type="button"
            className="fw-icon-btn"
            title="Atualizar status"
            onClick={() => void refreshStatus()}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loadingStatus && "animate-spin")}
            />
          </button>
          {mode === "edit" ? (
            <button
              type="button"
              className={cn("fw-save", dirty && "is-dirty")}
              disabled={!dirty || saving || truncated || !selectedAbs}
              onClick={() => void saveFile()}
              title="Salvar (Ctrl/Cmd+S)"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Salvar
            </button>
          ) : null}
        </div>
      </div>

      <div className="fw-body">
        {/* Side rail */}
        <div className="fw-side">
          <div className="fw-side-tabs">
            <button
              type="button"
              className={cn(side === "changed" && "is-on")}
              onClick={() => setSide("changed")}
            >
              Changes
              <span className="fw-count">{files.length}</span>
            </button>
            <button
              type="button"
              className={cn(side === "tree" && "is-on")}
              onClick={() => setSide("tree")}
            >
              Tree
            </button>
          </div>
          <div className="fw-filter">
            <Search className="h-3 w-3 shrink-0 opacity-50" />
            <input
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              placeholder={side === "changed" ? "Filtrar…" : "Arquivo…"}
            />
            {treeFilter ? (
              <button type="button" onClick={() => setTreeFilter("")}>
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <div className="fw-side-list">
            {side === "changed" ? (
              filteredChanged.length ? (
                filteredChanged.map((f) => (
                  <button
                    key={f.path + f.code}
                    type="button"
                    className={cn(
                      "fw-file-row",
                      selectedRel === f.path && "is-active"
                    )}
                    onClick={() => void openFile(f.path)}
                  >
                    <span className={cn("fw-code", statusColor(f.code))}>
                      {f.code || "M"}
                    </span>
                    <span className="truncate">{f.path}</span>
                  </button>
                ))
              ) : (
                <p className="fw-empty">Sem mudanças no working tree.</p>
              )
            ) : treeRoot.length ? (
              renderTree(treeRoot, 0)
            ) : (
              <p className="fw-empty">
                {treeLoading === cwd ? "Carregando…" : "Árvore vazia."}
              </p>
            )}
          </div>
        </div>

        {/* Main pane */}
        <div className="fw-main">
          <div className="fw-main-head">
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            {selectedRel ? (
              <>
                <span className={cn("fw-code", statusColor(activeCode))}>
                  {activeCode}
                </span>
                <span className="truncate font-mono text-[12px]">
                  {selectedRel}
                </span>
                {dirty ? (
                  <span className="fw-dirty-dot" title="Não salvo" />
                ) : null}
              </>
            ) : (
              <span className="text-[12px] text-[var(--muted)]">
                Selecione um arquivo
              </span>
            )}
          </div>

          <div className="fw-main-body">
            {!selectedRel ? (
              <p className="fw-empty-center">
                Escolha um arquivo em <strong>Changes</strong> ou{" "}
                <strong>Tree</strong> para ver diff ou editar.
              </p>
            ) : mode === "diff" ? (
              diffLoading && !activeDiff ? (
                <div className="fw-empty-center">
                  <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                  Carregando diff…
                </div>
              ) : activeDiff && activeDiff.lines.length > 0 ? (
                <DiffPane lines={activeDiff.lines} />
              ) : (
                <div className="fw-empty-center space-y-2">
                  <p>Sem patch unificado para este arquivo.</p>
                  <button
                    type="button"
                    className="fw-linkish"
                    onClick={() => {
                      setMode("edit");
                      if (selectedAbs) void loadEdit(selectedAbs);
                    }}
                  >
                    Abrir no editor →
                  </button>
                </div>
              )
            ) : editLoading ? (
              <div className="fw-empty-center">
                <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                Lendo arquivo…
              </div>
            ) : editError ? (
              <p className="fw-empty-center text-[var(--danger,#f87171)]">
                {editError}
              </p>
            ) : (
              <div className="fw-editor-wrap">
                {truncated ? (
                  <div className="fw-banner">
                    Arquivo grande — conteúdo truncado (somente leitura parcial).
                  </div>
                ) : null}
                <div className="fw-editor-grid">
                  <div className="fw-gutter" aria-hidden>
                    {editContent.split("\n").map((_, i) => (
                      <div key={i}>{i + 1}</div>
                    ))}
                  </div>
                  <textarea
                    ref={textareaRef}
                    className="fw-editor"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={onEditorKey}
                    spellCheck={false}
                    disabled={truncated}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Memo-friendly diff lines — only render visible window via simple CSS containment */
function DiffPane({ lines }: { lines: DiffLine[] }) {
  // Cap render for huge patches — keep first N + note
  const MAX = 4000;
  const slice = lines.length > MAX ? lines.slice(0, MAX) : lines;
  return (
    <div className="fw-diff">
      {slice.map((line, i) => {
        const num =
          line.type === "add"
            ? line.newNo
            : line.type === "del"
              ? line.oldNo
              : line.newNo ?? line.oldNo;
        return (
          <div
            key={i}
            className={cn(
              "code-line",
              line.type === "add" && "add",
              line.type === "del" && "del",
              line.type === "hunk" && "hunk",
              line.type === "meta" && "meta"
            )}
          >
            <span className="code-line-num">
              {line.type === "hunk" || line.type === "meta" ? "" : num ?? ""}
            </span>
            <span className="code-line-body">
              {line.type === "add"
                ? `+ ${line.text}`
                : line.type === "del"
                  ? `− ${line.text}`
                  : line.text}
            </span>
          </div>
        );
      })}
      {lines.length > MAX ? (
        <p className="p-2 text-center text-[11px] text-[var(--muted)]">
          … +{lines.length - MAX} linhas (abra no Edit para o arquivo completo)
        </p>
      ) : null}
    </div>
  );
}

/** @deprecated alias — prefer FileWorkbench */
export function DiffViewer(props: {
  files: DiffFileRow[];
  fileDiffs: FileDiff[];
  patchFallback?: string;
  emptyHint?: string;
}) {
  return (
    <p className="p-4 text-[12px] text-[var(--muted)]">
      {props.emptyHint || "Use FileWorkbench."}
    </p>
  );
}
