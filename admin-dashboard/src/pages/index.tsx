import type { NextPage } from 'next';
import Head from 'next/head';
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Message } from '@arco-design/web-react';
import {
  IconClose,
  IconEdit,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSun,
} from '@arco-design/web-react/icon';
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

const EMPTY_QUEUE: QueueDraft = {
  namespace: '',
  hookUrl: '',
  concurrency: '5',
  run: '*/5 * * * * *',
  check: '*/10 * * * * *',
  expire: '0 */5 * * * *',
};

const REQUEST_TIMEOUT_MS = 10_000;

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

function LiveFlow({ overview }: { overview: QueueOverview | null }) {
  const summary = overview?.summary;
  const segments = 10;
  const active = summary?.capacity
    ? Math.min(segments, Math.ceil((summary.running / summary.capacity) * segments))
    : 0;

  return (
    <div className={styles.flow} aria-label="任务从等待、运行到释放的调度流程">
      <div className={`${styles.flowNode} ${styles.flowWaiting}`}>
        <span className={styles.flowLabel}>WAITING</span>
        <strong>{summary?.waiting ?? '—'}</strong>
        <small>Redis list</small>
      </div>
      <div className={styles.flowConnector} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={`${styles.flowNode} ${styles.flowRunning}`}>
        <span className={styles.flowLabel}>RUNNING</span>
        <div className={styles.heroSlots}>
          {Array.from({ length: segments }, (_, index) => (
            <i key={index} className={index < active ? styles.heroSlotActive : undefined} />
          ))}
        </div>
        <small>
          {summary?.running ?? '—'} / {summary?.capacity ?? '—'} slots
        </small>
      </div>
      <div className={styles.flowConnector} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={`${styles.flowNode} ${styles.flowReleased}`}>
        <span className={styles.flowLabel}>RELEASED</span>
        <strong className={styles.liveGlyph}>✓</strong>
        <small>slot ready</small>
      </div>
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
      dialog?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])');
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
            <IconClose />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

const Dashboard: NextPage = () => {
  const [message, messageHolder] = Message.useMessage();
  const [overview, setOverview] = useState<QueueOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<number | null>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [queueDraft, setQueueDraft] = useState<QueueDraft>(EMPTY_QUEUE);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>({ queueId: '', taskId: '' });
  const [submitting, setSubmitting] = useState(false);
  const requestInFlight = useRef(false);

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
    if (theme === 'dark') document.body.setAttribute('arco-theme', 'dark');
    else document.body.removeAttribute('arco-theme');
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
      message.error?.('并发上限必须是大于 0 的整数');
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
      message.success?.('队列配置已生效');
      setQueueDialogOpen(false);
      await loadOverview();
    } catch (reason) {
      message.error?.(reason instanceof Error ? reason.message : '保存队列失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitTask = async (event: FormEvent) => {
    event.preventDefault();
    const queue = overview?.queues.find((item) => String(item.queueId) === taskDraft.queueId);
    if (!queue) {
      message.error?.('请选择一个有效队列');
      return;
    }
    setSubmitting(true);
    try {
      await postJson('/waitqueue/scheduler/addTask', {
        namespace: queue.namespace,
        hookUrl: queue.hookUrl,
        taskId: taskDraft.taskId,
      });
      message.success?.(`任务 ${taskDraft.taskId} 已进入等待队列`);
      setTaskDialogOpen(false);
      await loadOverview();
    } catch (reason) {
      message.error?.(reason instanceof Error ? reason.message : '提交任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {messageHolder}
      <Head>
        <title>WaitQueue Control Room</title>
        <meta name="description" content="waitqueue.js 实时队列控制面" />
      </Head>
      <div className={styles.shell} data-dashboard-shell>
        <aside className={styles.rail} aria-label="产品标识">
          <div className={styles.mark}>WQ</div>
          <div className={styles.railLine} />
          <div className={styles.railIndex}>
            <span>01</span>
            <small>LIVE</small>
          </div>
          <div className={styles.railWordmark}>WAITQUEUE.JS</div>
          <a className={styles.railLink} href="https://github.com/PeterGuy326/waitqueue.js" target="_blank" rel="noreferrer">
            GH
          </a>
        </aside>

        <main className={styles.main}>
          <header className={styles.header}>
            <div>
              <span className={styles.eyebrow}>CONTROL PLANE / REALTIME</span>
              <h1>队列控制室</h1>
              <p>把等待、占用与释放放在同一条调度轨道上。</p>
            </div>
            <div className={styles.headerActions}>
              <div className={`${styles.servicePill} ${serviceTone}`}>
                <span className={styles.liveDot} />
                <div>
                  <strong>{serviceState}</strong>
                  <small>{formatTimestamp(overview?.generatedAt)}</small>
                </div>
              </div>
              <button
                className={styles.iconButton}
                type="button"
                aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
                onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
              >
                {theme === 'light' ? <IconMoon /> : <IconSun />}
              </button>
              <Button icon={<IconRefresh />} loading={refreshing} onClick={() => void loadOverview(true)}>
                刷新
              </Button>
              <Button type="primary" icon={<IconPlus />} onClick={() => openQueueDialog()}>
                注册队列
              </Button>
            </div>
          </header>

          {error && (
            <div className={styles.alert} role="alert">
              <div>
                <strong>{overview ? '数据已过期' : '控制面暂时离线'}</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void loadOverview(true)}>
                重新连接
              </button>
            </div>
          )}

          <section className={styles.heroPanel} aria-labelledby="snapshot-title">
            <div className={styles.panelHeading}>
              <div>
                <span className={styles.eyebrow}>LIVE SCHEDULER SNAPSHOT</span>
                <h2 id="snapshot-title">实时调度快照</h2>
              </div>
              <div className={styles.utilization}>
                <span>容量利用率</span>
                <strong>{overview ? `${overview.summary.utilization}%` : '—'}</strong>
              </div>
            </div>

            <div className={styles.metrics}>
              <div>
                <span>QUEUES</span>
                <strong>{overview?.summary.queueCount ?? '—'}</strong>
                <small>已注册队列</small>
              </div>
              <div>
                <span>WAITING</span>
                <strong className={styles.metricAmber}>{overview?.summary.waiting ?? '—'}</strong>
                <small>等待调度</small>
              </div>
              <div>
                <span>RUNNING</span>
                <strong className={styles.metricBlue}>{overview?.summary.running ?? '—'}</strong>
                <small>占用槽位</small>
              </div>
              <div>
                <span>CAPACITY</span>
                <strong>{overview?.summary.capacity ?? '—'}</strong>
                <small>总并发上限</small>
              </div>
            </div>

            <LiveFlow overview={overview} />
          </section>

          <section className={styles.queuePanel} aria-labelledby="queues-title">
            <div className={styles.queueToolbar}>
              <div>
                <span className={styles.eyebrow}>QUEUE REGISTRY</span>
                <h2 id="queues-title">运行队列</h2>
              </div>
              <div className={styles.toolbarActions}>
                <label className={styles.searchBox}>
                  <span>⌕</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索 namespace / URL / ID"
                    aria-label="搜索队列"
                  />
                </label>
                <Button icon={<IconSend />} disabled={!overview?.queues.length} onClick={() => openTaskDialog()}>
                  提交任务
                </Button>
              </div>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.queueTable}>
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
                      <tr key={queue.queueId}>
                        <td>
                          <div className={styles.queueIdentity}>
                            <span className={styles.queueId}>Q-{String(queue.queueId).padStart(3, '0')}</span>
                            <div>
                              <strong>{queue.namespace}</strong>
                              <code title={displayUrl(queue.hookUrl)}>{displayUrl(queue.hookUrl)}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`${styles.queueStatus} ${status.tone}`}>
                            <i /> {status.label}
                          </span>
                        </td>
                        <td>
                          <strong className={queue.waiting > 0 ? styles.waitingCount : undefined}>{queue.waiting}</strong>
                          <small className={styles.cellCaption}>tasks</small>
                        </td>
                        <td>
                          <div className={styles.capacityValue}>
                            <strong>{queue.running}</strong>
                            <span>/ {queue.concurrency}</span>
                          </div>
                          <CapacityTrack queue={queue} />
                        </td>
                        <td>
                          <div className={styles.cronStack}>
                            <code><b>RUN</b>{queue.crontab.run}</code>
                            <code><b>CHK</b>{queue.crontab.check}</code>
                            <code><b>EXP</b>{queue.crontab.expire}</code>
                          </div>
                        </td>
                        <td>
                          <div className={styles.rowActions}>
                            <button type="button" onClick={() => openTaskDialog(queue)} title="提交任务">
                              <IconSend />
                            </button>
                            <button type="button" onClick={() => openQueueDialog(queue)} title="编辑配置">
                              <IconEdit />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {loading && !overview && (
                <div className={styles.loadingState} aria-label="正在读取队列">
                  <span />
                  <span />
                  <span />
                </div>
              )}

              {!loading && queues.length === 0 && (
                <div className={styles.emptyState}>
                  <div className={styles.emptyGlyph}>∅</div>
                  <strong>{query ? '没有匹配的队列' : '还没有注册队列'}</strong>
                  <p>{query ? '换一个 namespace、URL 或队列 ID 试试。' : '注册第一条队列后，实时状态会出现在这里。'}</p>
                  {!query && (
                    <Button type="primary" icon={<IconPlus />} onClick={() => openQueueDialog()}>
                      注册第一条队列
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>

          <footer className={styles.footer}>
            <span>DATA SOURCE · /waitqueue/admin/overview · AUTO REFRESH 10s</span>
            <span>实时快照，不包含历史吞吐与成功率</span>
          </footer>
        </main>
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
              <Button onClick={() => setQueueDialogOpen(false)}>取消</Button>
              <Button htmlType="submit" type="primary" loading={submitting}>保存配置</Button>
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
              <Button onClick={() => setTaskDialogOpen(false)}>取消</Button>
              <Button htmlType="submit" type="primary" icon={<IconSend />} loading={submitting}>进入队列</Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
};

export default Dashboard;
