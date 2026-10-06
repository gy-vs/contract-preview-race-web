import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Braces} from 'lucide-react';
import {
  BreakingDialog,
  ConflictDialog,
  ContractList,
  EditorPane,
  NewContractDialog,
  PreviewPane,
  Toast,
} from './components';
import {
  getContract,
  listContracts,
  previewContract,
  saveContract,
  type BreakingDTO,
  type ContractDTO,
  type IssueDTO,
  type PreviewDTO,
  type SaveError,
  type SummaryDTO,
} from './api';
import type {SchemaNode} from '../shared/types';

interface Draft {
  name: string;
  /** 作者编辑所基于的 revision；新建契约为 0。 */
  revision: number;
  text: string;
}

const NEW_SCHEMA_TEMPLATE = [
  '{',
  '  "type": "object",',
  '  "properties": {',
  '    "id": {"type": "string"}',
  '  },',
  '  "required": ["id"]',
  '}',
].join('\n');

function readRouteId(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  const match = hash.match(/^\/contracts\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function writeRouteId(id: string) {
  const next = `#/contracts/${encodeURIComponent(id)}`;
  if (window.location.hash !== next) window.location.hash = next;
}

function canonical(schema: SchemaNode): string {
  return JSON.stringify(schema, null, 2);
}

export default function App() {
  const [summaries, setSummaries] = useState<SummaryDTO[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(() => readRouteId());
  const [contract, setContract] = useState<ContractDTO | null>(null);
  const [contractMissing, setContractMissing] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const draftsRef = useRef(new Map<string, Draft>());
  const [sample, setSample] = useState('');

  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saveIssues, setSaveIssues] = useState<IssueDTO[]>([]);
  const [saving, setSaving] = useState(false);

  const [breaking, setBreaking] = useState<BreakingDTO[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<{current: ContractDTO; base: number} | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);

  /** 单调递增的预览序号 + 当前契约，用于丢弃过期与错契约的响应。 */
  const previewSeq = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const refreshSummaries = useCallback(async () => {
    try {
      setSummaries(await listContracts());
    } catch (error) {
      setToast({kind: 'error', text: error instanceof Error ? error.message : String(error)});
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSummaries();
  }, [refreshSummaries]);

  // 浏览器前进/后退
  useEffect(() => {
    const onHashChange = () => setSelectedId(readRouteId());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleSelect = useCallback((id: string) => {
    writeRouteId(id);
    setSelectedId(id);
  }, []);

  // 切换契约：载入内容并恢复本地未保存草稿；右侧结果立即清空，杜绝串台
  useEffect(() => {
    const id = selectedId;
    setContract(null);
    setDraft(null);
    setPreview(null);
    setSaveIssues([]);
    setConflict(null);
    setBreaking(null);
    setContractMissing(false);
    setPreviewLoading(false);
    if (!id) return;

    let cancelled = false;
    const storedDraft = draftsRef.current.get(id);
    const storedSample = window.localStorage.getItem(`sample:${id}`) ?? '';
    setSample(storedSample);

    getContract(id)
      .then(data => {
        if (cancelled || selectedIdRef.current !== id) return;
        setContract(data);
        if (storedDraft) {
          setDraft(storedDraft);
        } else {
          setDraft({name: data.name, revision: data.revision, text: canonical(data.latest.schema)});
        }
      })
      .catch(() => {
        // 新建但尚未保存的契约，服务端还不存在
        if (cancelled || selectedIdRef.current !== id) return;
        if (storedDraft) {
          setDraft(storedDraft);
          setContractMissing(true);
        } else {
          setToast({kind: 'error', text: `契约 "${id}" 不存在`});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const persistDraft = useCallback((id: string, next: Draft) => {
    draftsRef.current.set(id, next);
    window.localStorage.setItem(`draft:${id}`, JSON.stringify(next));
  }, []);

  // 刷新页面后恢复本地草稿
  useEffect(() => {
    for (const [id, value] of Object.entries(window.localStorage)) {
      if (!id.startsWith('draft:')) continue;
      try {
        const draft = JSON.parse(value) as Draft;
        if (draft && typeof draft.text === 'string') draftsRef.current.set(id.slice(6), draft);
      } catch {
        // 损坏的草稿忽略
      }
    }
  }, []);

  const dirty = useMemo(() => {
    if (!draft || !contract) {
      // 新建契约：有非模板内容或已输入名称就算脏（这里简化：只要是新契约保存按钮始终可用）
      return Boolean(draft);
    }
    return draft.name !== contract.name || draft.text !== canonical(contract.latest.schema);
  }, [draft, contract]);

  const parsed = useMemo<{schema: SchemaNode | null; error: string | null}>(() => {
    if (!draft) return {schema: null, error: null};
    try {
      return {schema: JSON.parse(draft.text) as SchemaNode, error: null};
    } catch (error) {
      return {schema: null, error: error instanceof Error ? error.message : String(error)};
    }
  }, [draft]);

  // 右侧预览：防抖 + 竞态令牌。快响应/慢响应乱序返回时，只接受最新一次、且仍选中该契约的结果。
  const draftText = draft?.text ?? '';
  const draftReady = draft !== null;
  useEffect(() => {
    const id = selectedId;
    const schema = parsed.schema;
    if (!draftReady || !schema) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const seq = ++previewSeq.current;
    const timer = window.setTimeout(() => {
      previewContract(id, schema, sample)
        .then(result => {
          if (seq !== previewSeq.current || selectedIdRef.current !== id) return;
          setPreview(result);
        })
        .catch(error => {
          if (seq !== previewSeq.current || selectedIdRef.current !== id) return;
          setPreview({parseError: null, valid: false, truncated: false, issues: [{
            scope: 'sample', path: '$', code: 'network',
            message: `预览请求失败：${error instanceof Error ? error.message : String(error)}`,
          }]});
        })
        .finally(() => {
          if (seq === previewSeq.current && selectedIdRef.current === id) setPreviewLoading(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      // 切换契约 / 再次编辑：旧令牌立即失效，且立刻为新的一次校验占位
      if (previewSeq.current === seq) setPreviewLoading(true);
    };
  }, [selectedId, parsed.schema, draftReady, draftText, sample]);

  // 样例按契约记住
  useEffect(() => {
    if (selectedId) window.localStorage.setItem(`sample:${selectedId}`, sample);
  }, [selectedId, sample]);

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    setDraft(current => {
      if (!current || !selectedId) return current;
      const next = {...current, ...patch};
      persistDraft(selectedId, next);
      return next;
    });
  }, [selectedId, persistDraft]);

  const applySaved = useCallback((id: string, name: string, revision: number, schemaText: string) => {
    const next: Draft = {name, revision, text: schemaText};
    draftsRef.current.set(id, next);
    window.localStorage.setItem(`draft:${id}`, JSON.stringify(next));
    setDraft(next);
    setContractMissing(false);
    void refreshSummaries();
  }, [refreshSummaries]);

  const doSave = useCallback(async (confirmBreaking: boolean) => {
    if (!selectedId || !draft || !parsed.schema) return;
    setSaving(true);
    if (confirmBreaking) setConfirming(true);
    const result = await saveContract(selectedId, {
      name: draft.name,
      expectedRevision: draft.revision,
      schema: parsed.schema,
      confirmBreaking,
    });
    setSaving(false);
    setConfirming(false);
    if (result.ok) {
      setBreaking(null);
      // 以服务端刚发布的 revision 为新基线，文本规范化
      const fresh = await getContract(selectedId).catch(() => null);
      if (fresh) setContract(fresh);
      applySaved(selectedId, draft.name, result.revision, canonical(parsed.schema));
      setSaveIssues([]);
      setToast({kind: 'ok', text: `已保存为 rev ${result.revision}`});
      return;
    }
    handleSaveError(result.error, draft.revision, draft.name, parsed.schema);
  }, [selectedId, draft, parsed.schema, applySaved]);

  const handleSaveError = useCallback((error: SaveError, _baseRevision: number, _name: string, _schema: SchemaNode) => {
    switch (error.kind) {
      case 'breaking':
        setBreaking(error.breaking);
        break;
      case 'version_conflict':
        // 文本原封不动留在编辑框；对话框里展示别人改了什么
        setConflict({current: error.current, base: draft?.revision ?? 0});
        break;
      case 'invalid_schema':
        setSaveIssues(error.issues);
        setToast({kind: 'error', text: '契约结构不合法，见编辑区提示'});
        break;
      default:
        setToast({kind: 'error', text: error.message});
    }
  }, [draft?.revision]);

  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    const {current} = conflict;
    const next: Draft = {name: current.name, revision: current.revision, text: canonical(current.latest.schema)};
    draftsRef.current.set(current.id, next);
    window.localStorage.setItem(`draft:${current.id}`, JSON.stringify(next));
    setDraft(next);
    setContract(current);
    setConflict(null);
    setSaveIssues([]);
    setToast({kind: 'ok', text: '已切换到别人发布的最新版，你的草稿被覆盖'});
  }, [conflict]);

  // 手动合并：文本一个字不动，只把保存基线推进到最新 revision
  const rebaseKeepMine = useCallback(() => {
    if (!conflict || !draft) return;
    const {current} = conflict;
    const next: Draft = {...draft, revision: current.revision, name: draft.name};
    draftsRef.current.set(current.id, next);
    window.localStorage.setItem(`draft:${current.id}`, JSON.stringify(next));
    setDraft(next);
    setContract(current);
    setConflict(null);
    setToast({kind: 'ok', text: `基线已更新到 rev ${current.revision}，合并后可再次保存`});
  }, [conflict, draft]);

  const createContract = useCallback((id: string, name: string) => {
    const draft: Draft = {name, revision: 0, text: NEW_SCHEMA_TEMPLATE};
    draftsRef.current.set(id, draft);
    window.localStorage.setItem(`draft:${id}`, JSON.stringify(draft));
    setCreating(false);
    handleSelect(id);
  }, [handleSelect]);

  const schemaIssues = useMemo(
    () => (preview?.issues.filter(issue => issue.scope === 'schema') ?? []).concat(saveIssues),
    [preview, saveIssues],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <Braces size={20} />
        <span className="brand">契约工作台</span>
        <small>JSON Schema 子集 · revision 化 · 破坏性改动把关</small>
      </header>
      <section className="workspace">
        <ContractList
          summaries={summaries}
          selectedId={selectedId}
          loading={listLoading}
          onSelect={handleSelect}
          onCreate={() => setCreating(true)}
        />
        {draft ? (
          <EditorPane
            contractId={selectedId}
            name={draft.name}
            revision={draft.revision}
            dirty={dirty || contractMissing}
            text={draft.text}
            parseError={parsed.error}
            schemaIssues={schemaIssues}
            saving={saving}
            onNameChange={name => updateDraft({name})}
            onTextChange={text => updateDraft({text})}
            onSave={() => void doSave(false)}
          />
        ) : (
          <section className="pane editor-pane empty-hint">
            {selectedId ? '加载中…' : '从左侧选择一份契约，或新建一份。'}
          </section>
        )}
        <PreviewPane
          sample={sample}
          loading={previewLoading}
          preview={preview}
          onSampleChange={setSample}
        />
      </section>

      {breaking && (
        <BreakingDialog
          changes={breaking}
          confirming={confirming}
          onCancel={() => setBreaking(null)}
          onConfirm={() => void doSave(true)}
        />
      )}
      {conflict && (
        <ConflictDialog
          current={conflict.current}
          baseRevision={conflict.base}
          onClose={() => setConflict(null)}
          onRebase={rebaseKeepMine}
          onTakeTheirs={takeTheirs}
        />
      )}
      {creating && (
        <NewContractDialog onClose={() => setCreating(false)} onSubmit={createContract} />
      )}
      {toast && <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} />}
    </main>
  );
}
