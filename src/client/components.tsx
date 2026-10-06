import {useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FilePlus2,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
  XCircle,
} from 'lucide-react';
import type {IssueDTO, PreviewDTO, SummaryDTO} from './api';
import type {BreakingDTO} from './api';
import type {ContractDTO} from './api';
import {diffSchemas, type DiffEntry} from './schema-diff';

/* ----------------------------- 左侧：契约列表 ----------------------------- */

export function ContractList(props: {
  summaries: SummaryDTO[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="pane list-pane">
      <div className="pane-head">
        <h2>契约</h2>
        <button className="ghost" onClick={props.onCreate} title="新建契约">
          <FilePlus2 size={15} /> 新建
        </button>
      </div>
      {props.loading && <div className="muted small pad">加载中…</div>}
      <div className="list">
        {props.summaries.map(item => {
          const affectedCount = item.affected.length;
          return (
            <button
              key={item.id}
              className={`list-item ${item.id === props.selectedId ? 'active' : ''}`}
              onClick={() => props.onSelect(item.id)}
            >
              <span className="list-item-title">
                {item.name} <code className="list-item-id">{item.id}</code>
              </span>
              <span className="list-item-meta">
                <GitBranch size={12} /> rev {item.revision}
                {affectedCount > 0 && (
                  <span
                    className="badge danger"
                    title={item.affected
                      .map(a => `${a.source}：${a.chain.join(' ← ')}`)
                      .join('\n')}
                  >
                    <AlertTriangle size={11} /> 受影响 ×{affectedCount}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/* ----------------------------- 中间：编辑区 ----------------------------- */

export function EditorPane(props: {
  contractId: string | null;
  name: string;
  revision: number;
  dirty: boolean;
  text: string;
  parseError: string | null;
  schemaIssues: IssueDTO[];
  saving: boolean;
  onNameChange: (name: string) => void;
  onTextChange: (text: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="pane editor-pane">
      <div className="toolbar">
        <input
          className="name-input"
          value={props.name}
          onChange={event => props.onNameChange(event.target.value)}
          placeholder="契约名称"
        />
        <span className={`pill ${props.dirty ? 'warn' : 'ok'}`}>
          {props.contractId === null
            ? '未创建'
            : props.dirty
              ? `基于 rev ${props.revision}，有未保存修改`
              : `已保存 rev ${props.revision}`}
        </span>
        <button className="primary" onClick={props.onSave} disabled={props.saving || props.parseError !== null}>
          {props.saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
          保存
        </button>
      </div>
      {props.parseError && (
        <div className="banner error">
          <XCircle size={15} /> JSON 语法错误：{props.parseError}
        </div>
      )}
      {!props.parseError && props.schemaIssues.length > 0 && (
        <div className="banner warn">
          <AlertTriangle size={15} />
          <div>
            契约结构问题（{props.schemaIssues.length}）：
            <ul className="issue-mini">
              {props.schemaIssues.slice(0, 5).map((issue, index) => (
                <li key={index}>
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <textarea
        aria-label="Contract schema"
        className="editor"
        spellCheck={false}
        value={props.text}
        onChange={event => props.onTextChange(event.target.value)}
      />
    </section>
  );
}

/* ----------------------------- 右侧：样例预览 ----------------------------- */

export function PreviewPane(props: {
  sample: string;
  loading: boolean;
  preview: PreviewDTO | null;
  onSampleChange: (sample: string) => void;
}) {
  const issues = props.preview?.issues.filter(issue => issue.scope === 'sample') ?? [];
  const schemaIssues = props.preview?.issues.filter(issue => issue.scope === 'schema') ?? [];
  return (
    <section className="pane preview-pane">
      <div className="pane-head">
        <h2>
          <RefreshCw size={15} className={props.loading ? 'spin' : ''} /> 样例校验
        </h2>
        {props.preview && !props.loading && (
          props.preview.valid ? (
            <span className="pill ok"><CheckCircle2 size={13} /> 通过</span>
          ) : (
            <span className="pill danger"><XCircle size={13} /> 不通过</span>
          )
        )}
        {props.loading && <span className="pill muted"><Loader2 size={13} className="spin" /> 校验中…</span>}
      </div>
      <textarea
        aria-label="Sample JSON"
        className="sample-editor"
        spellCheck={false}
        placeholder='贴一段样例 JSON，例如 {"orderId": "o-1"}'
        value={props.sample}
        onChange={event => props.onSampleChange(event.target.value)}
      />
      <div className="issues">
        {props.preview?.parseError && (
          <div className="issue error">
            <code>$</code> 样例不是合法 JSON：{props.preview.parseError}
          </div>
        )}
        {schemaIssues.map((issue, index) => (
          <div className="issue warn" key={`s-${index}`}>
            <code>{issue.path}</code> {issue.message}
          </div>
        ))}
        {issues.map((issue, index) => (
          <div className="issue error" key={`v-${index}`}>
            <code>{issue.path}</code> {issue.message}
          </div>
        ))}
        {props.preview?.truncated && (
          <div className="issue muted">错误过多，仅显示前 300 条；深层递归样例每层都可能重复同类错误。</div>
        )}
        {props.preview && !props.loading && props.preview.valid && !props.preview.parseError && (
          <div className="issue ok"><CheckCircle2 size={14} /> 样例符合契约及其全部引用。</div>
        )}
      </div>
    </section>
  );
}

/* ----------------------------- 破坏性改动确认框 ----------------------------- */

export function BreakingDialog(props: {
  changes: BreakingDTO[];
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <Modal onClose={props.onCancel} title="本次保存包含破坏性改动">
      <p className="muted">
        以下改动会让仍在产生旧格式数据的消费方校验失败。默认阻止发布；确认你已经通知消费方后可以强制发布。
      </p>
      <ul className="change-list">
        {props.changes.map((change, index) => (
          <li key={index}>
            <span className="tag danger">{labelOf(change.code)}</span>
            <code>{change.path === '$' ? '（根）' : change.path}</code>
            <span className="muted">{change.message}</span>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="ghost" onClick={props.onCancel}>取消</button>
        <button className="danger" onClick={props.onConfirm} disabled={props.confirming}>
          {props.confirming ? <Loader2 size={15} className="spin" /> : <AlertTriangle size={15} />}
          我确认，强制发布
        </button>
      </div>
    </Modal>
  );
}

function labelOf(code: string): string {
  const labels: Record<string, string> = {
    property_removed: '删字段',
    required_added: '变必填',
    type_changed: '类型变化',
    type_added: '新增类型约束',
    enum_value_removed: '删枚举值',
    items_added: '新增元素约束',
  };
  return labels[code] ?? code;
}

/* ----------------------------- 乐观锁冲突框 ----------------------------- */

export function ConflictDialog(props: {
  current: ContractDTO;
  baseRevision: number;
  onClose: () => void;
  onRebase: () => void;
  onTakeTheirs: () => void;
}) {
  const base = props.current.revisions.find(item => item.revision === props.baseRevision);
  const diff: DiffEntry[] = useMemo(() => {
    if (!base) return [];
    return diffSchemas(base.schema, props.current.latest.schema);
  }, [base, props.current.latest.schema]);

  return (
    <Modal onClose={props.onClose} title="保存被拒绝：契约已被他人更新">
      <p className="muted">
        你在 <strong>rev {props.baseRevision}</strong> 上编辑，但别人已经发布了{' '}
        <strong>rev {props.current.revision}</strong>。你编辑框里的文本没有被覆盖，
        可以对照下面的改动手动合并后，基于最新 revision 重新保存。
      </p>
      <ul className="change-list">
        {diff.length === 0 && <li className="muted">两份 revision 结构相同（可能只改了名称）。</li>}
        {diff.map((entry, index) => (
          <li key={index}>
            <span className={`tag ${entry.kind === 'removed' ? 'danger' : entry.kind === 'added' ? 'ok' : 'warn'}`}>
              {entry.kind === 'removed' ? '删除' : entry.kind === 'added' ? '新增' : '变化'}
            </span>
            <code>{entry.path}</code>
            <span className="muted">{entry.detail}</span>
          </li>
        ))}
      </ul>
      <details className="theirs-view">
        <summary>查看别人发布的 rev {props.current.revision} 全文</summary>
        <pre>{JSON.stringify(props.current.latest.schema, null, 2)}</pre>
      </details>
      <div className="modal-actions">
        <button className="ghost" onClick={props.onClose}>取消</button>
        <button className="ghost" onClick={props.onRebase} title="文本保持不变，仅把保存基线更新到最新 revision">
          保留我的文本，基线更新到 rev {props.current.revision}
        </button>
        <button className="primary" onClick={props.onTakeTheirs}>放弃我的编辑，用最新版覆盖</button>
      </div>
    </Modal>
  );
}

/* ----------------------------- 新建契约框 ----------------------------- */

export function NewContractDialog(props: {onClose: () => void; onSubmit: (id: string, name: string) => void}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) && name.trim().length > 0;
  return (
    <Modal onClose={props.onClose} title="新建契约">
      <label className="form-row">
        契约 ID
        <input value={id} onChange={e => setId(e.target.value)} placeholder="例如 inventory-events" autoFocus />
        <small className="muted">字母/数字开头，可含 - _，保存后不可修改。</small>
      </label>
      <label className="form-row">
        显示名称
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如 库存事件" />
      </label>
      <div className="modal-actions">
        <button className="ghost" onClick={props.onClose}>取消</button>
        <button className="primary" disabled={!valid} onClick={() => props.onSubmit(id, name.trim())}>创建并编辑</button>
      </div>
    </Modal>
  );
}

/* ----------------------------- 通用 Modal 与 Toast ----------------------------- */

function Modal(props: {title: string; onClose: () => void; children: React.ReactNode}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="icon" onClick={props.onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Toast(props: {kind: 'ok' | 'error'; text: string; onDone: () => void}) {
  const timer = useRef<number | null>(null);
  useEffect(() => {
    timer.current = window.setTimeout(props.onDone, 4000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [props.text, props.onDone]);
  return <div className={`toast ${props.kind}`}>{props.text}</div>;
}
