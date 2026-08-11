import type { NextPage } from 'next';
import Head from 'next/head';
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from '../style/dashboard.module.css';

interface QueueCrontab {
  run: string;
  check: string;
  expire: string;
}

interface QueueOverviewItem {
  queueId: number;
  namespace: string;
  hookUrl: string;
  concurrency: number;
  waiting: number;
  running: number;
  available: number;
  utilization: number;
  crontab: QueueCrontab;
  updatedAt: string;
}

interface QueueOverview {
  generatedAt: string;
  summary: {
    queueCount: number;
    waiting: number;
    running: number;
    capacity: number;
    utilization: number;
  };
  queues: QueueOverviewItem[];
}

interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface QueueDraft {
  namespace: string;
  hookUrl: string;
  concurrency: string;
  run: string;
  check: string;
  expire: string;
}

interface TaskDraft {
  queueId: string;
  taskId: string;
}

interface ToastState {
  id: number;
  tone: 'success' | 'error';
  text: string;
}

const EMPTY_QUEUE: QueueDraft = {
  namespace: '',
  hookUrl: '',
  concurrency: '5',
  run: '*/5 * * * * *',
  check: '*/10 * * * * *',
  expire: '0 */5 * * * *',
};

const REQUEST_TIMEOUT_MS = 10_000;

function Glyph({ children }: { children: React.ReactNode }) {
  return <span className={styles.iconGlyph} aria-hidden="true">{children}</span>;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请检查 WaitQueue 服务状态');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function decodeResponse<T>(response: Response): Promise<T> {
  let payload: ApiEnvelope<T>;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`服务返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return decodeResponse<T>(response);
}

function formatTimestamp(value?: string): string {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function queueStatus(queue: QueueOverviewItem): { label: string; tone: string } {
  if (queue.waiting > 0 && queue.running >= queue.concurrency) {
    return { label: '排队中', tone: styles.statusWarning };
  }
  if (queue.waiting > 0) return { label: '有积压', tone: styles.statusWarning };
  if (queue.running > 0) return { label: '运行中', tone: styles.statusActive };
  return { label: '空闲', tone: styles.statusIdle };
}

function CapacityTrack({ queue }: { queue: QueueOverviewItem }) {
  const segments = Math.min(Math.max(queue.concurrency, 1), 12);
  const active =
    queue.running === 0
      ? 0
      : Math.max(1, Math.min(segments, Math.ceil((queue.running / queue.concurrency) * segments)));

  return (
    <div className={styles.capacityTrack} aria-label={`运行 ${queue.running}，并发上限 ${queue.concurrency}`}>
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} className={index < active ? styles.capacityActive : styles.capacitySlot} />
      ))}
    </div>
  );
}

function Dialog({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.querySelector<HTMLElement>('[data-dashboard-shell]');
    background?.setAttribute('inert', '');
    background?.setAttribute('aria-hidden', 'true');

    const dialog = dialogRef.current;
    const preferredFocus =
      dialog?.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
      dialog?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])') ??
      dialog?.querySelector<HTMLElement>('button:not([disabled])');
    preferredFocus?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      background?.removeAttribute('inert');
      background?.removeAttribute('aria-hidden');
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && onClose()}
    >
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h2 id="dialog-title">{title}</h2>
          </div>
          <button className={styles.iconButton} type="button" onClick={onClose} aria-label="关闭">
            <Glyph>×</Glyph>
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

const Dashboard: NextPage = () => {
  const [overview, setOverview] = useState<QueueOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [activeQueueId, setActiveQueueId] = useState<number | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<number | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [queueDraft, setQueueDraft] = useState<QueueDraft>(EMPTY_QUEUE);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>({ queueId: '', taskId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const requestInFlight = useRef(false);
  const toastSequence = useRef(0);

  const notify = useCallback((tone: ToastState['tone'], text: string) => {
    toastSequence.current += 1;
    setToast({ id: toastSequence.current, tone, text });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadOverview = useCallback(async (manual = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (manual) setRefreshing(true);
    try {
      const response = await fetchWithTimeout('/waitqueue/admin/overview', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await decodeResponse<QueueOverview>(response);
      setOverview(data);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接 waitqueue 服务');
    } finally {
      requestInFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadOverview();
    }, 10_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void loadOverview();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadOverview]);

  useEffect(() => {
    const saved = window.localStorage.getItem('waitqueue-theme');
    if (saved === 'dark') setTheme('dark');
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('waitqueue-theme', theme);
  }, [theme]);

  const queues = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview?.queues ?? [];
    return (overview?.queues ?? []).filter(
      (queue) =>
        queue.namespace.toLowerCase().includes(normalized) ||
        queue.hookUrl.toLowerCase().includes(normalized) ||
        String(queue.queueId).includes(normalized)
    );
  }, [overview, query]);

  const activeQueue = useMemo(
    () => queues.find((queue) => queue.queueId === activeQueueId) ?? queues[0] ?? null,
    [activeQueueId, queues]
  );

  const serviceState = loading && !overview ? 'SYNCING' : error ? (overview ? 'STALE' : 'OFFLINE') : 'ONLINE';
  const serviceTone = error ? styles.serviceError : styles.serviceOnline;

  const openQueueDialog = (queue?: QueueOverviewItem) => {
    setEditingQueueId(queue?.queueId ?? null);
    setQueueDraft(
      queue
        ? {
            namespace: queue.namespace,
            hookUrl: queue.hookUrl,
            concurrency: String(queue.concurrency),
            run: queue.crontab.run,
            check: queue.crontab.check,
            expire: queue.crontab.expire,
          }
        : EMPTY_QUEUE
    );
    setQueueDialogOpen(true);
  };

  const openTaskDialog = (queue?: QueueOverviewItem) => {
    setTaskDraft({ queueId: queue ? String(queue.queueId) : String(overview?.queues[0]?.queueId ?? ''), taskId: '' });
    setTaskDialogOpen(true);
  };

  const updateQueueDraft = (field: keyof QueueDraft) => (event: ChangeEvent<HTMLInputElement>) => {
    setQueueDraft((current) => ({ ...current, [field]: event.target.value }));
  };

  const submitQueue = async (event: FormEvent) => {
    event.preventDefault();
    const concurrency = Number(queueDraft.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      notify('error', '并发上限必须是大于 0 的整数');
      return;
    }
    setSubmitting(true);
    try {
      await postJson('/waitqueue/queue/newQueue', {
        namespace: queueDraft.namespace,
        hookUrl: queueDraft.hookUrl,
        currMaxCount: concurrency,
        crontab: {
          run: queueDraft.run,
          check: queueDraft.check,
          expire: queueDraft.expire,
        },
      });
      notify('success', '队列配置已生效');
      setQueueDialogOpen(false);
      await loadOverview();
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : '保存队列失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitTask = async (event: FormEvent) => {
    event.preventDefault();
    const queue = overview?.queues.find((item) => String(item.queueId) === taskDraft.queueId);
    if (!queue) {
      notify('error', '请选择一个有效队列');
      return;
    }
    setSubmitting(true);
    try {
      await postJson('/waitqueue/scheduler/addTask', {
        namespace: queue.namespace,
        hookUrl: queue.hookUrl,
        taskId: taskDraft.taskId,
      });
      notify('success', `任务 ${taskDraft.taskId} 已进入等待队列`);
      setTaskDialogOpen(false);
      await loadOverview();
    } catch (reason) {
      notify('error', reason instanceof Error ? reason.message : '提交任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>WaitQueue Control Room</title>
        <meta name="description" content="waitqueue.js 实时队列控制面" />
      </Head>
      {toast && (
        <div
          key={toast.id}
          className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : styles.toastSuccess}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          <span aria-hidden="true">{toast.tone === 'error' ? '!' : '✓'}</span>
          <strong>{toast.text}</strong>
          <button type="button" onClick={() => setToast(null)} aria-label="关闭提示">
            <Glyph>×</Glyph>
          </button>
        </div>
      )}
      <div className={styles.shell} data-dashboard-shell>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">&gt;_</span>
            <div>
              <strong>WaitQueue Backend</strong>
              <small>wq v1.0</small>
            </div>
          </div>

          <div className={styles.workspaceTitle}>
            <strong>运行控制台</strong>
            <span>· Dashboard</span>
          </div>

          <nav className={styles.productNav} aria-label="控制台导航">
            <a className={styles.navActive} href="#workbench-title"><i aria-hidden="true">◎</i> 探索</a>
            <a href="#queues-title"><i aria-hidden="true">▣</i> 队列</a>
            <a href="#runtime-pulse"><i aria-hidden="true">∿</i> 调度</a>
          </nav>

          <div className={styles.topbarMeta}>
            <span><i aria-hidden="true">◇</i> Queues <b>{overview?.summary.queueCount ?? '—'}</b></span>
            <span><i aria-hidden="true">◇</i> Capacity <b>{overview?.summary.capacity ?? '—'}</b></span>
            <div className={`${styles.serviceState} ${serviceTone}`} role="status" aria-live="polite">
              <i className={styles.liveDot} aria-hidden="true" />
              <span>{serviceState}</span>
            </div>
          </div>
        </header>

        <div className={styles.bodyGrid}>
          <aside className={styles.sidebar} aria-label="队列目录">
            <div className={styles.sidebarNumbers}>
              <span><i aria-hidden="true">◇</i> {overview?.summary.queueCount ?? '—'} 队列</span>
              <span><i aria-hidden="true">◉</i> {overview?.summary.running ?? '—'} 运行</span>
              <span><i aria-hidden="true">◌</i> {overview?.summary.waiting ?? '—'} 等待</span>
            </div>

            <div className={styles.sidebarSearch}>
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search queues / hooks..."
                aria-label="搜索队列"
              />
            </div>

            <button className={styles.catalogButton} type="button" onClick={() => setQuery('')}>
              <span className={styles.cubeGlyph} aria-hidden="true">◇</span>
              <span>
                <strong>完整目录</strong>
                <small>{overview?.summary.queueCount ?? 0} queues · realtime</small>
              </span>
              <b>{overview?.summary.queueCount ?? '—'}</b>
            </button>

            <div className={styles.sidebarRule} />
            <div className={styles.sidebarLabel}>
              <span>⌘ &nbsp;SCHEDULER QUEUES</span>
              <b>{queues.length}</b>
            </div>

            <nav className={styles.queueNav} aria-label="已注册队列">
              {queues.map((queue) => {
                const status = queueStatus(queue);
                const selected = activeQueue?.queueId === queue.queueId;
                return (
                  <a
                    key={queue.queueId}
                    className={selected ? styles.queueNavActive : undefined}
                    href={`#queue-${queue.queueId}`}
                    aria-current={selected ? 'location' : undefined}
                    onClick={() => setActiveQueueId(queue.queueId)}
                  >
                    <span className={`${styles.navQueueGlyph} ${status.tone}`} aria-hidden="true">◈</span>
                    <span>
                      <strong>{queue.namespace}</strong>
                      <small>q-{String(queue.queueId).padStart(3, '0')} · {queue.running}/{queue.concurrency} slots</small>
                    </span>
                    <b>{queue.waiting}</b>
                  </a>
                );
              })}
            </nav>

            <div className={styles.sidebarFoot}>
              <span>AUTO REFRESH</span>
              <strong>10 SEC</strong>
              <small>Last sync {formatTimestamp(overview?.generatedAt)}</small>
            </div>
          </aside>

          <main className={styles.main}>
            {error && (
              <div className={styles.alert} role="alert">
                <div>
                  <strong>{overview ? '数据已过期' : '控制面暂时离线'}</strong>
                  <span>{error}</span>
                </div>
                <button type="button" onClick={() => void loadOverview(true)}>重新连接</button>
              </div>
            )}

            <section className={styles.hero} aria-labelledby="workbench-title">
              <div className={styles.heroTitle}>
                <span aria-hidden="true">&gt;_</span>
                <h1 id="workbench-title">WaitQueue Workbench</h1>
                <b>Runtime Queue Contract</b>
              </div>
              <p>轻量任务调度 · Redis 实时快照 · 并发槽位控制</p>
            </section>

            <section className={styles.summaryGrid} aria-label="调度摘要">
              <article className={styles.summaryCard} id="runtime-pulse">
                <div className={styles.cardHeading}>
                  <span className={styles.cardIcon} aria-hidden="true">◎</span>
                  <div>
                    <h2>Runtime Pulse</h2>
                    <p>当前容量、占用与等待状态</p>
                  </div>
                  <span className={styles.arrow} aria-hidden="true">→</span>
                </div>
                <div className={styles.metricStrip}>
                  <span><small>QUEUES</small><strong>{overview?.summary.queueCount ?? '—'}</strong></span>
                  <span><small>WAITING</small><strong>{overview?.summary.waiting ?? '—'}</strong></span>
                  <span><small>RUNNING</small><strong>{overview?.summary.running ?? '—'}</strong></span>
                  <span><small>CAPACITY</small><strong>{overview?.summary.capacity ?? '—'}</strong></span>
                </div>
                <div className={styles.metricBadges}>
                  <span className={styles.mintBadge}>runtime {overview?.summary.running ?? 0}</span>
                  <span>utilization {overview ? `${overview.summary.utilization}%` : '—'}</span>
                </div>
              </article>

              <article className={styles.summaryCard}>
                <div className={styles.cardHeading}>
                  <span className={styles.cardIcon} aria-hidden="true">✧</span>
                  <div>
                    <h2>调度工作台 · Control</h2>
                    <p>队列注册、任务入队与运行同步</p>
                  </div>
                  <span className={styles.arrow} aria-hidden="true">→</span>
                </div>
                <div className={styles.actionRow}>
                  <button className={`${styles.controlButton} ${styles.primaryButton}`} type="button" onClick={() => openQueueDialog()}>
                    <Glyph>＋</Glyph>注册队列
                  </button>
                  <button className={styles.controlButton} type="button" disabled={!overview?.queues.length} onClick={() => openTaskDialog(activeQueue ?? undefined)}>
                    <Glyph>▷</Glyph>提交任务
                  </button>
                  <button className={styles.controlButton} type="button" disabled={refreshing} aria-busy={refreshing} onClick={() => void loadOverview(true)}>
                    <Glyph>↻</Glyph>{refreshing ? '刷新中' : '刷新'}
                  </button>
                  <button
                    className={styles.themeButton}
                    type="button"
                    aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
                    onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
                  >
                    <Glyph>{theme === 'light' ? '◒' : '☼'}</Glyph>
                  </button>
                </div>
                <div className={styles.metricBadges}>
                  <span>{overview?.summary.queueCount ?? 0} queues / {overview?.summary.capacity ?? 0} slots</span>
                  <span className={error ? styles.errorBadge : styles.mintBadge}>{serviceState}</span>
                </div>
              </article>
            </section>

            {activeQueue && (
              <section className={styles.focusBar} aria-label="当前队列">
                <span className={styles.cubeGlyph} aria-hidden="true">◇</span>
                <div>
                  <small>CURRENT QUEUE</small>
                  <strong>{activeQueue.namespace}</strong>
                </div>
                <code>{displayUrl(activeQueue.hookUrl)}</code>
                <div className={styles.focusStats}>
                  <span><b>{activeQueue.waiting}</b> waiting</span>
                  <span><b>{activeQueue.running}</b> / {activeQueue.concurrency} running</span>
                </div>
                <button type="button" onClick={() => openQueueDialog(activeQueue)}><Glyph>✎</Glyph> 配置</button>
              </section>
            )}

            <section className={styles.queuePanel} aria-labelledby="queues-title">
              <div className={styles.queueToolbar}>
                <div>
                  <h2 id="queues-title"><span>⚡</span> Queue Registry</h2>
                  <p>实时队列目录 · 点击操作完成任务入队或配置更新</p>
                </div>
                <span className={styles.resultCount}>{queues.length} / {overview?.summary.queueCount ?? 0}</span>
              </div>

              <div className={styles.tableWrap}>
                <table className={styles.queueTable}>
                  <caption className={styles.visuallyHidden}>已注册队列的实时运行状态、并发槽位与调度规则</caption>
                  <thead>
                    <tr>
                      <th>队列 / 回调</th>
                      <th>状态</th>
                      <th>等待</th>
                      <th>运行槽位</th>
                      <th>调度规则</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queues.map((queue) => {
                      const status = queueStatus(queue);
                      return (
                        <tr id={`queue-${queue.queueId}`} key={queue.queueId} className={activeQueue?.queueId === queue.queueId ? styles.activeRow : undefined}>
                          <td data-label="队列 / 回调">
                            <div className={styles.queueIdentity}>
                              <span className={styles.queueId}>Q-{String(queue.queueId).padStart(3, '0')}</span>
                              <div>
                                <button type="button" onClick={() => setActiveQueueId(queue.queueId)}>{queue.namespace}</button>
                                <code title={displayUrl(queue.hookUrl)}>{displayUrl(queue.hookUrl)}</code>
                              </div>
                            </div>
                          </td>
                          <td data-label="状态">
                            <span className={`${styles.queueStatus} ${status.tone}`}><i aria-hidden="true" /> {status.label}</span>
                          </td>
                          <td data-label="等待">
                            <strong className={queue.waiting > 0 ? styles.waitingCount : undefined}>{queue.waiting}</strong>
                            <small className={styles.cellCaption}>tasks</small>
                          </td>
                          <td data-label="运行槽位">
                            <div className={styles.capacityValue}><strong>{queue.running}</strong><span>/ {queue.concurrency}</span></div>
                            <CapacityTrack queue={queue} />
                          </td>
                          <td data-label="调度规则">
                            <div className={styles.cronStack}>
                              <code><b>RUN</b>{queue.crontab.run}</code>
                              <code><b>CHK</b>{queue.crontab.check}</code>
                              <code><b>EXP</b>{queue.crontab.expire}</code>
                            </div>
                          </td>
                          <td data-label="操作">
                            <div className={styles.rowActions}>
                              <button type="button" onClick={() => openTaskDialog(queue)} title="提交任务" aria-label={`向 ${queue.namespace} 队列提交任务`}><Glyph>▷</Glyph></button>
                              <button type="button" onClick={() => openQueueDialog(queue)} title="编辑配置" aria-label={`编辑 ${queue.namespace} 队列配置`}><Glyph>✎</Glyph></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {loading && !overview && (
                  <div className={styles.loadingState} aria-label="正在读取队列"><span /><span /><span /></div>
                )}

                {!loading && queues.length === 0 && (
                  <div className={styles.emptyState}>
                    <div className={styles.emptyGlyph}>∅</div>
                    <strong>{query ? '没有匹配的队列' : '还没有注册队列'}</strong>
                    <p>{query ? '换一个 namespace、URL 或队列 ID 试试。' : '注册第一条队列后，实时状态会出现在这里。'}</p>
                    {!query && (
                      <button className={`${styles.controlButton} ${styles.primaryButton}`} type="button" onClick={() => openQueueDialog()}>
                        <Glyph>＋</Glyph>注册第一条队列
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>

            <footer className={styles.footer}>
              <span><i aria-hidden="true">◇</i> DATA SOURCE · /waitqueue/admin/overview · AUTO REFRESH 10s</span>
              <span>实时快照，不包含历史吞吐与成功率</span>
            </footer>
          </main>
        </div>
      </div>

      {queueDialogOpen && (
        <Dialog
          title={editingQueueId === null ? '注册队列' : `编辑队列 Q-${String(editingQueueId).padStart(3, '0')}`}
          eyebrow="QUEUE CONFIGURATION"
          onClose={() => setQueueDialogOpen(false)}
        >
          <form className={styles.form} onSubmit={submitQueue}>
            <div className={styles.formGrid}>
              <label>
                <span>Namespace</span>
                <input required disabled={editingQueueId !== null} maxLength={64} value={queueDraft.namespace} onChange={updateQueueDraft('namespace')} placeholder="billing" />
              </label>
              <label>
                <span>并发上限</span>
                <input required type="number" min="1" max="1000" value={queueDraft.concurrency} onChange={updateQueueDraft('concurrency')} />
              </label>
            </div>
            <label>
              <span>Hook URL</span>
              <input required disabled={editingQueueId !== null} type="url" maxLength={255} value={queueDraft.hookUrl} onChange={updateQueueDraft('hookUrl')} placeholder="http://worker.internal/callback" />
            </label>
            <div className={styles.ruleGroup}>
              <span className={styles.ruleTitle}>CRON SCHEDULE</span>
              <label>
                <span>RUN</span>
                <input required maxLength={64} value={queueDraft.run} onChange={updateQueueDraft('run')} />
              </label>
              <label>
                <span>CHECK</span>
                <input required maxLength={64} value={queueDraft.check} onChange={updateQueueDraft('check')} />
              </label>
              <label>
                <span>EXPIRE</span>
                <input required maxLength={64} value={queueDraft.expire} onChange={updateQueueDraft('expire')} />
              </label>
            </div>
            <p className={styles.formHint}>
              {editingQueueId === null
                ? '相同 namespace + Hook URL 会更新现有队列配置。'
                : '队列身份不可修改；保存后会更新并发上限与调度规则。'}
            </p>
            <div className={styles.dialogActions}>
              <button className={styles.controlButton} type="button" onClick={() => setQueueDialogOpen(false)}>取消</button>
              <button className={`${styles.controlButton} ${styles.primaryButton}`} type="submit" disabled={submitting} aria-busy={submitting}>
                {submitting ? '保存中' : '保存配置'}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {taskDialogOpen && (
        <Dialog title="提交任务" eyebrow="ENQUEUE TASK" onClose={() => setTaskDialogOpen(false)}>
          <form className={styles.form} onSubmit={submitTask}>
            <label>
              <span>目标队列</span>
              <select
                required
                value={taskDraft.queueId}
                onChange={(event) => setTaskDraft((current) => ({ ...current, queueId: event.target.value }))}
              >
                {(overview?.queues ?? []).map((queue) => (
                  <option key={queue.queueId} value={queue.queueId}>
                    Q-{String(queue.queueId).padStart(3, '0')} · {queue.namespace}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Task ID</span>
              <input
                required
                maxLength={256}
                value={taskDraft.taskId}
                onChange={(event) => setTaskDraft((current) => ({ ...current, taskId: event.target.value }))}
                placeholder="invoice-20260810-001"
                data-dialog-autofocus
              />
            </label>
            <p className={styles.formHint}>任务会进入 Redis waiting list，由对应队列的 RUN 周期领取。</p>
            <div className={styles.dialogActions}>
              <button className={styles.controlButton} type="button" onClick={() => setTaskDialogOpen(false)}>取消</button>
              <button className={`${styles.controlButton} ${styles.primaryButton}`} type="submit" disabled={submitting} aria-busy={submitting}>
                <Glyph>▷</Glyph>{submitting ? '提交中' : '进入队列'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
};

export default Dashboard;
