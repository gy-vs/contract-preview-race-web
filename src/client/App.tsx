import {useCallback, useEffect, useRef, useState} from 'react';
import {AlertTriangle, Braces, CheckCircle2, Loader2, Plus, RefreshCw, Save, XCircle} from 'lucide-react';
import type {ContractDetail, ContractSummary, Issue, SchemaNode} from '../shared/schema';
import {createContract, getContract, listContracts, previewContract, saveContract, type PreviewResult} from './api';
import {diffLines} from './diff';

/** 种子契约的默认样例，方便打开即预览。 */
const DEFAULT_SAMPLES: Record<string, string> = {
  'order-event': JSON.stringify({
    orderId: 'O-1024',
    buyerId: 'U-7',
    status: 'paid',
    shippingAddress: {recipient: '张三', phone: '13800000000', province: '浙江', city: '杭州', detail: '文三路 100 号', zip: '310012'},
    lines: [{sku: 'SKU-1', quantity: 2, price: 39.5}],
  }, null, 2),
  'profile-event': JSON.stringify({userId: 'U-7', nickname: '阿黎', locale: 'zh-CN', tags: ['vip']}, null, 2),
  'address': JSON.stringify({recipient: '张三', phone: '13800000000', detail: '文三路 100 号'}, null, 2),
  'category-tree': JSON.stringify({
    name: '根分类',
    slug: 'root',
    children: [{name: '子分类', slug: 'child', children: [{name: '叶子', slug: 'leaf', children: []}]}],
  }, null, 2),
};

const NEW_CONTRACT_TEMPLATE: SchemaNode = {type: 'object', properties: {}};

function readContractFromUrl(): string {
  return new URL(window.location.href).searchParams.get('contract') ?? '';
}

export default function App() {
  const [items, setItems] = useState<ContractSummary[]>([]);
  const [selected, setSelected] = useState<string>(readContractFromUrl);
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [conflict, setConflict] = useState<{revision: number; schema: SchemaNode} | null>(null);
  const [breakingReport, setBreakingReport] = useState<Issue[] | null>(null);
  const [invalidDetails, setInvalidDetails] = useState<Issue[] | null>(null);
  const [status, setStatus] = useState('就绪');
  const [showCreate, setShowCreate] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');

  // ---- 竞态防护：所有异步响应都要先核对「我发出时的上下文」是否仍然有效 ----
  const selectedRef = useRef(selected);
  const sampleRef = useRef(sample);
  const loadSeq = useRef(0);
  const previewSeq = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const samplesRef = useRef(new Map<string, string>());
  const saveBaseRef = useRef<number | null>(null); // 冲突后选择「基于最新重存」时的基准 revision

  function updateSample(value: string) {
    sampleRef.current = value;
    setSample(value);
  }

  // ---- 契约列表：加载 + 轮询，让别人保存的破坏性影响标记能及时出现 ----
  useEffect(() => {
    let cancelled = false;
    const load = () => listContracts().then(data => {
      if (!cancelled) setItems(data);
    }).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // URL 里的契约不存在（或还没选）时，落到列表第一份
  useEffect(() => {
    if (items.length > 0 && !items.some(item => item.id === selected)) {
      setSelected(items[0].id);
    }
  }, [items, selected]);

  // 当前契约同步到 URL，刷新/分享后回到同一份
  useEffect(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('contract') !== selected) {
      url.searchParams.set('contract', selected);
      window.history.pushState(null, '', url);
    }
  }, [selected]);

  useEffect(() => {
    const onPop = () => {
      const id = readContractFromUrl();
      if (id) setSelected(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadContract = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    setStatus('加载中…');
    try {
      const detail = await getContract(id);
      if (seq !== loadSeq.current || selectedRef.current !== id) return; // 已切走，丢弃
      setContract(detail);
      setText(JSON.stringify(detail.schema, null, 2));
      setDirty(false);
      setStatus(`已加载 revision ${detail.revision}`);
    } catch (error) {
      if (seq === loadSeq.current) setStatus(`加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // 切换契约：清理面板、载入新契约；卸载时把当前样例文本存回 map
  useEffect(() => {
    if (!selected) return;
    selectedRef.current = selected;
    saveBaseRef.current = null;
    setConflict(null);
    setBreakingReport(null);
    setInvalidDetails(null);
    setContract(null);
    setPreview(null);
    updateSample(samplesRef.current.get(selected) ?? DEFAULT_SAMPLES[selected] ?? '');
    loadContract(selected);
    return () => {
      samplesRef.current.set(selected, sampleRef.current);
    };
  }, [selected, loadContract]);

  // ---- 预览：只采纳「最后一次发起、且仍属于当前契约」的响应 ----
  const runPreview = useCallback(async (contractId: string, schemaText: string, sampleText: string) => {
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      setPreview({contractId, valid: false, errors: [{path: '$', message: '编辑器里的契约不是合法 JSON'}]});
      return;
    }
    const seq = ++previewSeq.current;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreviewBusy(true);
    try {
      const result = await previewContract(contractId, schema, sampleText, controller.signal);
      if (seq !== previewSeq.current || contractId !== selectedRef.current) return; // 过期响应
      setPreview(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (seq !== previewSeq.current || contractId !== selectedRef.current) return;
      setPreview({contractId, valid: false, errors: [{path: '$', message: `预览请求失败：${error instanceof Error ? error.message : String(error)}`}]});
    } finally {
      if (seq === previewSeq.current) setPreviewBusy(false);
    }
  }, []);

  // 编辑或样例变化后自动校验（防抖）；契约切换后也会自动跑一次
  useEffect(() => {
    if (!contract || sample.trim() === '') {
      previewSeq.current++; // 让在途的预览响应失效，避免清空后又冒出旧结果
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => runPreview(contract.id, text, sample), 450);
    return () => clearTimeout(timer);
  }, [contract, text, sample, runPreview]);

  async function refreshList() {
    try {
      setItems(await listContracts());
    } catch {
      // 列表刷新失败不打断主流程
    }
  }

  async function save(options?: {force?: boolean; baseRevision?: number}) {
    if (!contract) return;
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch {
      setStatus('契约 JSON 无法解析，未保存');
      return;
    }
    const baseRevision = options?.baseRevision ?? saveBaseRef.current ?? contract.revision;
    setStatus('保存中…');
    let result;
    try {
      result = await saveContract(contract.id, schema, baseRevision, options?.force ?? false);
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (result.ok) {
      saveBaseRef.current = null;
      setContract({...contract, revision: result.revision, schema: schema as SchemaNode});
      setDirty(false);
      setConflict(null);
      setBreakingReport(null);
      setInvalidDetails(null);
      setStatus(result.breaking ? `已发布破坏性改动（revision ${result.revision}）` : `已保存 revision ${result.revision}`);
      refreshList();
      return;
    }
    if (result.kind === 'conflict') {
      // 他人在我们编辑期间保存了新版本：本地文本原样保留，展示对方版本与差异
      saveBaseRef.current = null;
      setConflict(result.current);
      setStatus(result.message);
      return;
    }
    if (result.kind === 'breaking') {
      setBreakingReport(result.report);
      setStatus('本次修改包含破坏性改动，确认后才能发布');
      return;
    }
    if (result.kind === 'invalid') {
      setInvalidDetails(result.details);
      setStatus('契约不符合 schema 子集规范');
      return;
    }
    setStatus(result.message);
  }

  function rebaseAndSave() {
    if (!conflict) return;
    // 保留我的文本，把基准 revision 提升到对方已保存的版本再保存
    saveBaseRef.current = conflict.revision;
    setConflict(null);
    save({baseRevision: conflict.revision});
  }

  function discardMine() {
    if (!conflict || !contract) return;
    setText(JSON.stringify(conflict.schema, null, 2));
    setContract({...contract, revision: conflict.revision, schema: conflict.schema});
    setConflict(null);
    setBreakingReport(null);
    setInvalidDetails(null);
    setDirty(false);
    setStatus(`已载入 revision ${conflict.revision}，本地修改已放弃`);
  }

  async function createNew() {
    setCreateError('');
    const result = await createContract(newId.trim(), newName.trim() || newId.trim(), NEW_CONTRACT_TEMPLATE);
    if (!result.ok) {
      setCreateError(result.message);
      return;
    }
    setShowCreate(false);
    setNewId('');
    setNewName('');
    await refreshList();
    setSelected(newId.trim());
  }

  const remote = items.find(item => item.id === selected);
  const behind = Boolean(remote && contract && remote.revision > contract.revision);

  return (
    <main className="shell">
      <header className="topbar">
        <Braces size={20}/>
        <span className="brand">契约工作台</span>
        <small>事件契约 · 预览 · 兼容守护</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <div className="pane-title">
            <h2>契约</h2>
            <button className="icon-btn" title="新建契约" onClick={() => setShowCreate(v => !v)}><Plus size={16}/></button>
          </div>
          {showCreate && (
            <div className="create-form">
              <input placeholder="id，如 order-event" value={newId} onChange={e => setNewId(e.target.value)}/>
              <input placeholder="名称" value={newName} onChange={e => setNewName(e.target.value)}/>
              <button className="primary" onClick={createNew}>创建</button>
              {createError && <p className="error-text">{createError}</p>}
            </div>
          )}
          <div className="list">
            {items.map(item => (
              <button
                key={item.id}
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
              >
                <span className="item-name">{item.name}</span>
                <small>
                  {item.id} · r{item.revision}
                  {item.breaking && <span className="badge badge-breaking" title="最新 revision 包含破坏性改动">破坏性</span>}
                  {item.affectedBy.length > 0 && (
                    <span className="badge badge-affected" title={`受 ${item.affectedBy.join('、')} 的破坏性改动影响`}>
                      受影响
                    </span>
                  )}
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={() => save()} disabled={!contract}>
              <Save size={15}/> 保存
            </button>
            {contract && <span className="pill">r{contract.revision}{dirty ? ' · 已修改' : ''}</span>}
            <span className="status">{status}</span>
          </div>

          {behind && (
            <div className="banner banner-info">
              <RefreshCw size={14}/> 远端已有 revision {remote!.revision}，你正在编辑 r{contract!.revision}
              <button onClick={() => {
                if (!dirty || window.confirm('载入最新版本会覆盖你未保存的修改，继续？')) loadContract(selected);
              }}>载入最新</button>
            </div>
          )}

          {conflict && (
            <div className="banner banner-conflict">
              <div className="banner-head">
                <AlertTriangle size={15}/>
                <strong>保存冲突：他人已保存 revision {conflict.revision}</strong>
              </div>
              <p>你的文本没有丢失。下面是对比（<span className="legend-del">红＝对方版本</span>，<span className="legend-add">绿＝你的未保存修改</span>）：</p>
              <pre className="diff">
                {diffLines(JSON.stringify(conflict.schema, null, 2), text).map((line, i) => (
                  <span key={i} className={line.type === 'add' ? 'diff-add' : line.type === 'del' ? 'diff-del' : ''}>
                    {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}{line.text}{'\n'}
                  </span>
                ))}
              </pre>
              <div className="banner-actions">
                <button className="primary" onClick={rebaseAndSave}>以我的文本重新保存到 r{conflict.revision}</button>
                <button onClick={discardMine}>放弃我的修改，载入对方版本</button>
              </div>
            </div>
          )}

          {breakingReport && (
            <div className="banner banner-breaking">
              <div className="banner-head">
                <AlertTriangle size={15}/>
                <strong>本次修改包含 {breakingReport.length} 处破坏性改动</strong>
              </div>
              <ul className="issue-list">
                {breakingReport.map((issue, i) => <li key={i}><code>{issue.path}</code> {issue.message}</li>)}
              </ul>
              <div className="banner-actions">
                <button className="danger" onClick={() => save({force: true})}>确认发布破坏性改动</button>
                <button onClick={() => setBreakingReport(null)}>继续编辑</button>
              </div>
            </div>
          )}

          {invalidDetails && (
            <div className="banner banner-invalid">
              <div className="banner-head">
                <XCircle size={15}/>
                <strong>契约不符合子集规范</strong>
              </div>
              <ul className="issue-list">
                {invalidDetails.map((issue, i) => <li key={i}><code>{issue.path}</code> {issue.message}</li>)}
              </ul>
              <div className="banner-actions">
                <button onClick={() => setInvalidDetails(null)}>知道了</button>
              </div>
            </div>
          )}

          <textarea
            aria-label="契约 schema"
            spellCheck={false}
            value={text}
            onChange={event => {
              setText(event.target.value);
              setDirty(true);
            }}
          />
        </section>

        <section className="pane">
          <div className="pane-title">
            <h2><RefreshCw size={15}/> 预览校验</h2>
            {previewBusy && <Loader2 size={15} className="spin"/>}
          </div>
          <p className="hint">粘贴一段样例 JSON，按编辑器中的契约（含引用）校验。</p>
          <textarea
            aria-label="样例 JSON"
            className="sample"
            placeholder='{"orderId": "O-1", ...}'
            spellCheck={false}
            value={sample}
            onChange={event => updateSample(event.target.value)}
          />
          {preview && preview.contractId === selected && (
            preview.valid ? (
              <div className="result-ok"><CheckCircle2 size={15}/> 校验通过（{preview.contractId}）</div>
            ) : (
              <div className="result-errors">
                <strong>校验未通过（{preview.contractId}）：</strong>
                <ul className="issue-list">
                  {preview.errors.map((issue, i) => <li key={i}><code>{issue.path}</code> {issue.message}</li>)}
                </ul>
              </div>
            )
          )}
        </section>
      </section>
    </main>
  );
}
