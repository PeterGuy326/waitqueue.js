import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Pagination,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  type MenuProps,
  type TableColumnsType,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  MenuOutlined,
  MoonOutlined,
  PlusOutlined,
  RedoOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { NextPage } from 'next';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useColorMode } from '../theme/control-room-theme';
import styles from '../style/dashboard.module.css';

const { Header, Sider, Content } = Layout;
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 10_000;
const DEAD_LETTER_PAGE_SIZE = 20;

type ViewKey = 'overview' | 'queues' | 'deadLetters' | 'diagnostics';
type ServiceState = 'SYNCING' | 'ONLINE' | 'DEGRADED' | 'STALE' | 'OFFLINE';

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
  retrying?: number;
  deadLetters?: number;
  oldestWaitingAt?: string | null;
  oldestWaitingAgeSeconds?: number | null;
  callbacks?: { success: number; failure: number };
  claims?: { claimed: number; recovered: number };
  crontab: QueueCrontab;
  updatedAt: string;
}

interface QueueOverview {
  generatedAt: string;
  metricsStartedAt?: string;
  summary: {
    queueCount: number;
    waiting: number;
    running: number;
    capacity: number;
    utilization: number;
    retrying?: number;
    deadLetters?: number;
    oldestWaitingAt?: string | null;
    oldestWaitingAgeSeconds?: number | null;
    callbackSuccesses?: number;
    callbackFailures?: number;
    claims?: number;
    recovered?: number;
    deadLettered?: number;
  };
  queues: QueueOverviewItem[];
}

interface HealthPayload {
  status: string;
  dependencies?: {
    mysql: 'ok' | 'unavailable';
    redis: 'ok' | 'unavailable';
  };
}

interface HealthState {
  live: boolean | null;
  ready: boolean | null;
  dependencies: HealthPayload['dependencies'];
  checkedAt?: string;
}

interface DeadLetterItem {
  entryId: string;
  taskId: string;
  retryCount: number;
  failedAt: string;
  reason: 'callback_failed' | 'lease_expired';
}

interface DeadLetterPage {
  total: number;
  offset: number;
  limit: number;
  items: DeadLetterItem[];
}

interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

interface QueueFormValues {
  namespace: string;
  hookUrl: string;
  concurrency: number;
  run: string;
  check: string;
  expire: string;
}

interface TaskFormValues {
  queueId: number;
  taskId: string;
}

const DEFAULT_QUEUE_VALUES: QueueFormValues = {
  namespace: '',
  hookUrl: '',
  concurrency: 5,
  run: '*/5 * * * * *',
  check: '*/10 * * * * *',
  expire: '0 */5 * * * *',
};

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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetchWithTimeout(path, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  return decodeResponse<T>(response);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return decodeResponse<T>(response);
}

async function probeHealth(path: string): Promise<{ ok: boolean; data?: HealthPayload }> {
  const response = await fetchWithTimeout(path, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  let payload: ApiEnvelope<HealthPayload> | undefined;
  try {
    payload = (await response.json()) as ApiEnvelope<HealthPayload>;
  } catch {
    return { ok: false };
  }
  return { ok: response.ok && payload.code === 0, data: payload.data };
}

function safeNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value as number) >= 0 ? value : undefined;
}

function metric(value: number | undefined): number | '—' {
  return safeNumber(value) ?? '—';
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatAge(value: number | null | undefined, waiting = 0): string {
  if (value === undefined) return '—';
  if (value === null) return waiting > 0 ? '时间未知' : '无等待';
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60) return value < 1 ? '刚刚' : `${Math.floor(value)} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分 ${Math.floor(value % 60)} 秒`;
  if (value < 86_400) return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分`;
  return `${Math.floor(value / 86_400)} 天 ${Math.floor((value % 86_400) / 3600)} 小时`;
}

function displayHook(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname === '/' ? '' : '/…'}`;
  } catch {
    return 'invalid hook origin';
  }
}

function queueState(queue: QueueOverviewItem): { label: string; color: 'success' | 'warning' | 'error' | 'default' } {
  if ((queue.deadLetters ?? 0) > 0) return { label: '需处理', color: 'error' };
  if (queue.waiting > 0 && queue.running >= queue.concurrency) return { label: '容量已满', color: 'warning' };
  if (queue.waiting > 0 || (queue.retrying ?? 0) > 0) return { label: '有积压', color: 'warning' };
  if (queue.running > 0) return { label: '运行中', color: 'success' };
  return { label: '空闲', color: 'default' };
}

function serviceState(overview: QueueOverview | null, error: string, health: HealthState, loading: boolean): ServiceState {
  if (loading && !overview) return 'SYNCING';
  if (!overview) return 'OFFLINE';
  if (error) return 'STALE';
  if (health.live === false) return 'OFFLINE';
  if (health.ready === false) return 'DEGRADED';
  if (health.live === true && health.ready === true) return 'ONLINE';
  return 'SYNCING';
}

function stateTag(state: ServiceState) {
  const map: Record<ServiceState, { color: string; icon: React.ReactNode; text: string }> = {
    SYNCING: { color: 'processing', icon: <ReloadOutlined spin />, text: 'SYNCING' },
    ONLINE: { color: 'success', icon: <CheckCircleOutlined />, text: 'ONLINE' },
    DEGRADED: { color: 'warning', icon: <WarningOutlined />, text: 'DEGRADED' },
    STALE: { color: 'warning', icon: <FieldTimeOutlined />, text: 'STALE' },
    OFFLINE: { color: 'error', icon: <WarningOutlined />, text: 'OFFLINE' },
  };
  const item = map[state];
  return <Tag color={item.color} icon={item.icon}>{item.text}</Tag>;
}

function SidebarCatalog({
  overview,
  queues,
  activeQueueId,
  query,
  onQuery,
  onSelect,
  onCreate,
}: {
  overview: QueueOverview | null;
  queues: QueueOverviewItem[];
  activeQueueId: number | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (queueId: number) => void;
  onCreate: () => void;
}) {
  return (
    <div className={styles.catalog}>
      <div className={styles.catalogNumbers} aria-label="队列实时摘要">
        <span><b>{metric(overview?.summary.queueCount)}</b> 队列</span>
        <span><b>{metric(overview?.summary.running)}</b> 运行</span>
        <span><b>{metric(overview?.summary.waiting)}</b> 等待</span>
      </div>
      <div className={styles.catalogSearch}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索 namespace / origin / ID"
          aria-label="搜索队列"
        />
      </div>
      <button className={styles.catalogTitle} type="button" onClick={() => onQuery('')}>
        <AppstoreOutlined />
        <span><strong>完整目录</strong><small>REALTIME QUEUE REGISTRY</small></span>
        <b>{overview?.summary.queueCount ?? 0}</b>
      </button>
      <div className={styles.catalogLabel}>
        <span>SCHEDULER QUEUES</span>
        <b>{queues.length}</b>
      </div>
      <nav className={styles.queueNav} aria-label="已注册队列">
        {queues.map((queue) => {
          const selected = queue.queueId === activeQueueId;
          const state = queueState(queue);
          return (
            <button
              key={queue.queueId}
              type="button"
              className={selected ? styles.queueNavActive : undefined}
              onClick={() => onSelect(queue.queueId)}
              aria-current={selected ? 'location' : undefined}
            >
              <span className={styles.queueGlyph}><CloudServerOutlined /></span>
              <span>
                <strong title={queue.namespace}>{queue.namespace}</strong>
                <small>Q-{String(queue.queueId).padStart(3, '0')} · {state.label}</small>
              </span>
              <Badge count={queue.waiting} showZero overflowCount={99999} color={queue.waiting > 0 ? '#d46b08' : '#777'} />
            </button>
          );
        })}
        {queues.length === 0 && <p className={styles.catalogEmpty}>{query ? '没有匹配队列' : '暂无队列'}</p>}
      </nav>
      <div className={styles.catalogFooter}>
        <Button type="primary" icon={<PlusOutlined />} block onClick={onCreate}>注册队列</Button>
        <small>自动刷新 · 10 秒</small>
      </div>
    </div>
  );
}

const Dashboard: NextPage = () => {
  const { message, modal } = AntApp.useApp();
  const { mode, toggleMode } = useColorMode();
  const [overview, setOverview] = useState<QueueOverview | null>(null);
  const [health, setHealth] = useState<HealthState>({ live: null, ready: null, dependencies: undefined });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [activeQueueId, setActiveQueueId] = useState<number | null>(null);
  const [view, setView] = useState<ViewKey>('overview');
  const [mobileCatalogOpen, setMobileCatalogOpen] = useState(false);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<number | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deadLetters, setDeadLetters] = useState<DeadLetterPage | null>(null);
  const [deadLetterQueueId, setDeadLetterQueueId] = useState<number | null>(null);
  const [deadLetterLoading, setDeadLetterLoading] = useState(false);
  const [deadLetterPage, setDeadLetterPage] = useState(1);
  const overviewRequest = useRef(false);
  const healthRequest = useRef(false);
  const deadLetterRequest = useRef(0);
  const [queueForm] = Form.useForm<QueueFormValues>();
  const [taskForm] = Form.useForm<TaskFormValues>();

  const loadOverview = useCallback(async (manual = false) => {
    if (overviewRequest.current) return;
    overviewRequest.current = true;
    if (manual) setRefreshing(true);
    try {
      const data = await getJson<QueueOverview>('/waitqueue/admin/overview');
      setOverview(data);
      setActiveQueueId((current) => current ?? data.queues[0]?.queueId ?? null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接 WaitQueue 服务');
    } finally {
      overviewRequest.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    if (healthRequest.current) return;
    healthRequest.current = true;
    try {
      const [live, ready] = await Promise.allSettled([
        probeHealth('/waitqueue/health/live'),
        probeHealth('/waitqueue/health/ready'),
      ]);
      const liveResult = live.status === 'fulfilled' ? live.value : { ok: false };
      const readyResult = ready.status === 'fulfilled' ? ready.value : { ok: false };
      setHealth({
        live: liveResult.ok,
        ready: readyResult.ok,
        dependencies: readyResult.data?.dependencies,
        checkedAt: new Date().toISOString(),
      });
    } finally {
      healthRequest.current = false;
    }
  }, []);

  const refreshAll = useCallback(async (manual = false) => {
    await Promise.all([loadOverview(manual), loadHealth()]);
  }, [loadHealth, loadOverview]);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll();
    }, REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshAll]);

  const queues = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview?.queues ?? [];
    return (overview?.queues ?? []).filter((queue) =>
      queue.namespace.toLowerCase().includes(normalized) ||
      displayHook(queue.hookUrl).toLowerCase().includes(normalized) ||
      String(queue.queueId).includes(normalized)
    );
  }, [overview, query]);

  const activeQueue = useMemo(
    () => overview?.queues.find((queue) => queue.queueId === activeQueueId) ?? overview?.queues[0] ?? null,
    [activeQueueId, overview]
  );
  const currentDeadLetters = deadLetterQueueId === activeQueue?.queueId ? deadLetters : null;

  const currentServiceState = serviceState(overview, error, health, loading);

  const loadDeadLetters = useCallback(async (queueId: number, page = 1) => {
    const requestId = ++deadLetterRequest.current;
    setDeadLetterLoading(true);
    try {
      let resolvedPage = page;
      let offset = (resolvedPage - 1) * DEAD_LETTER_PAGE_SIZE;
      let data = await getJson<DeadLetterPage>(
        `/waitqueue/admin/deadLetters?queueId=${queueId}&offset=${offset}&limit=${DEAD_LETTER_PAGE_SIZE}`
      );
      if (requestId !== deadLetterRequest.current) return;

      if (resolvedPage > 1 && data.items.length === 0 && data.total <= offset) {
        resolvedPage = Math.max(1, Math.ceil(data.total / DEAD_LETTER_PAGE_SIZE));
        offset = (resolvedPage - 1) * DEAD_LETTER_PAGE_SIZE;
        data = await getJson<DeadLetterPage>(
          `/waitqueue/admin/deadLetters?queueId=${queueId}&offset=${offset}&limit=${DEAD_LETTER_PAGE_SIZE}`
        );
      }
      if (requestId !== deadLetterRequest.current) return;
      setDeadLetters(data);
      setDeadLetterQueueId(queueId);
      setDeadLetterPage(resolvedPage);
    } catch (reason) {
      if (requestId === deadLetterRequest.current) {
        message.error(reason instanceof Error ? reason.message : '读取死信队列失败');
      }
    } finally {
      if (requestId === deadLetterRequest.current) setDeadLetterLoading(false);
    }
  }, [message]);

  useEffect(() => {
    setDeadLetterPage(1);
    setDeadLetters(null);
    setDeadLetterQueueId(null);
    if (view === 'deadLetters' && activeQueue) {
      void loadDeadLetters(activeQueue.queueId, 1);
    } else {
      deadLetterRequest.current += 1;
      setDeadLetterLoading(false);
    }
  }, [activeQueue?.queueId, loadDeadLetters, view]);

  const openQueueModal = (queue?: QueueOverviewItem) => {
    setEditingQueueId(queue?.queueId ?? null);
    queueForm.setFieldsValue(
      queue
        ? {
            namespace: queue.namespace,
            hookUrl: queue.hookUrl,
            concurrency: queue.concurrency,
            run: queue.crontab.run,
            check: queue.crontab.check,
            expire: queue.crontab.expire,
          }
        : DEFAULT_QUEUE_VALUES
    );
    setQueueModalOpen(true);
  };

  const openTaskModal = (queue?: QueueOverviewItem) => {
    taskForm.setFieldsValue({ queueId: queue?.queueId ?? overview?.queues[0]?.queueId, taskId: '' });
    setTaskModalOpen(true);
  };

  const submitQueue = async (values: QueueFormValues) => {
    setSubmitting(true);
    try {
      await postJson('/waitqueue/queue/newQueue', {
        namespace: values.namespace,
        hookUrl: values.hookUrl,
        currMaxCount: values.concurrency,
        crontab: { run: values.run, check: values.check, expire: values.expire },
      });
      message.success('队列配置已生效');
      setQueueModalOpen(false);
      await refreshAll(true);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '保存队列失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitTask = async (values: TaskFormValues) => {
    const queue = overview?.queues.find((item) => item.queueId === values.queueId);
    if (!queue) {
      message.error('请选择一个有效队列');
      return;
    }
    setSubmitting(true);
    try {
      await postJson('/waitqueue/scheduler/addTask', {
        namespace: queue.namespace,
        hookUrl: queue.hookUrl,
        taskId: values.taskId,
      });
      message.success('任务已进入等待队列');
      setTaskModalOpen(false);
      await refreshAll(true);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '提交任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const replayDeadLetter = (item: DeadLetterItem) => {
    if (!activeQueue) return;
    modal.confirm({
      title: '确认重放这条死信？',
      content: `队列 ${activeQueue.namespace} · 任务 ${item.taskId} · 已重试 ${item.retryCount} 次`,
      okText: '重放并重新入队',
      cancelText: '取消',
      icon: <RedoOutlined />,
      async onOk() {
        try {
          await postJson('/waitqueue/admin/deadLetters/replay', {
            queueId: activeQueue.queueId,
            taskId: item.taskId,
            entryId: item.entryId,
          });
          message.success('死信已重新入队');
          await Promise.all([refreshAll(true), loadDeadLetters(activeQueue.queueId, deadLetterPage)]);
        } catch (reason) {
          message.error(reason instanceof Error ? reason.message : '死信重放失败');
          throw reason;
        }
      },
    });
  };

  const menuItems: MenuProps['items'] = [
    { key: 'overview', icon: <DashboardOutlined />, label: '总览' },
    { key: 'queues', icon: <BarsOutlined />, label: '队列' },
    { key: 'deadLetters', icon: <WarningOutlined />, label: '死信' },
    { key: 'diagnostics', icon: <SafetyCertificateOutlined />, label: '诊断' },
  ];

  const queueColumns: TableColumnsType<QueueOverviewItem> = [
    {
      title: '队列 / 回调源',
      key: 'queue',
      width: 250,
      fixed: 'left',
      render: (_, queue) => (
        <div className={styles.queueIdentity}>
          <span>Q-{String(queue.queueId).padStart(3, '0')}</span>
          <div>
            <button type="button" onClick={() => setActiveQueueId(queue.queueId)}>{queue.namespace}</button>
            <code title="敏感路径已隐藏">{displayHook(queue.hookUrl)}</code>
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_, queue) => {
        const state = queueState(queue);
        return <Tag color={state.color}>{state.label}</Tag>;
      },
    },
    {
      title: '积压 / 最老等待',
      key: 'backlog',
      width: 180,
      render: (_, queue) => (
        <div className={styles.tableMetric}>
          <strong className={queue.waiting > 0 ? styles.warningText : undefined}>{queue.waiting}</strong>
          <small><FieldTimeOutlined /> {formatAge(queue.oldestWaitingAgeSeconds, queue.waiting)}</small>
        </div>
      ),
    },
    {
      title: '运行槽位',
      key: 'capacity',
      width: 170,
      render: (_, queue) => (
        <div className={styles.capacityCell}>
          <span><b>{queue.running}</b> / {queue.concurrency}</span>
          <Progress percent={Math.min(100, Math.max(0, queue.utilization))} showInfo={false} size="small" />
        </div>
      ),
    },
    {
      title: 'Retry',
      dataIndex: 'retrying',
      width: 90,
      align: 'right',
      render: (value: number | undefined) => <b className={(value ?? 0) > 0 ? styles.warningText : undefined}>{metric(value)}</b>,
    },
    {
      title: 'DLQ',
      dataIndex: 'deadLetters',
      width: 90,
      align: 'right',
      render: (value: number | undefined) => <b className={(value ?? 0) > 0 ? styles.dangerText : undefined}>{metric(value)}</b>,
    },
    {
      title: '投递失败',
      key: 'failures',
      width: 110,
      align: 'right',
      render: (_, queue) => <b className={(queue.callbacks?.failure ?? 0) > 0 ? styles.dangerText : undefined}>{metric(queue.callbacks?.failure)}</b>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 128,
      fixed: 'right',
      render: (_, queue) => (
        <Space size={4}>
          <Tooltip title="提交任务"><Button aria-label={`向 ${queue.namespace} 提交任务`} icon={<SendOutlined />} onClick={() => openTaskModal(queue)} /></Tooltip>
          <Tooltip title="编辑配置"><Button aria-label={`编辑 ${queue.namespace} 配置`} icon={<SettingOutlined />} onClick={() => openQueueModal(queue)} /></Tooltip>
        </Space>
      ),
    },
  ];

  const deadLetterColumns: TableColumnsType<DeadLetterItem> = [
    { title: '任务 ID', dataIndex: 'taskId', ellipsis: true, render: (value: string) => <code>{value}</code> },
    { title: '失败原因', dataIndex: 'reason', width: 150, render: (value: DeadLetterItem['reason']) => <Tag color="error">{value === 'lease_expired' ? '租约过期' : '回调失败'}</Tag> },
    { title: '重试次数', dataIndex: 'retryCount', width: 110, align: 'right' },
    { title: '失败时间', dataIndex: 'failedAt', width: 180, render: formatTimestamp },
    { title: '操作', key: 'action', width: 110, fixed: 'right', render: (_, item) => <Button icon={<RedoOutlined />} onClick={() => replayDeadLetter(item)}>重放</Button> },
  ];

  const catalog = (
    <SidebarCatalog
      overview={overview}
      queues={queues}
      activeQueueId={activeQueue?.queueId ?? null}
      query={query}
      onQuery={setQuery}
      onSelect={(queueId) => {
        setActiveQueueId(queueId);
        setMobileCatalogOpen(false);
      }}
      onCreate={() => {
        setMobileCatalogOpen(false);
        openQueueModal();
      }}
    />
  );

  return (
    <>
      <Head>
        <title>WaitQueue Workbench</title>
        <meta name="description" content="WaitQueue 实时调度与恢复工作台" />
      </Head>
      <a className={styles.skipLink} href="#main-content">跳到主要内容</a>
      <Layout className={styles.shell}>
        <Header className={styles.topbar}>
          <div className={styles.brand}>
            <Button className={styles.mobileMenu} type="text" icon={<MenuOutlined />} aria-label="打开队列目录" onClick={() => setMobileCatalogOpen(true)} />
            <span className={styles.brandMark} aria-hidden="true">&gt;_</span>
            <div><strong>WaitQueue Backend</strong><small>RUNTIME CONTROL PLANE</small></div>
          </div>
          <div className={styles.workspace}><b>运行工作台</b><span>· Workbench</span></div>
          <Menu
            className={styles.topMenu}
            mode="horizontal"
            items={menuItems}
            selectedKeys={[view]}
            onClick={({ key }) => setView(key as ViewKey)}
          />
          <div className={styles.topMeta}>
            <span>Queues <b>{metric(overview?.summary.queueCount)}</b></span>
            <span>Open <b>{metric(overview?.summary.waiting)}</b></span>
            {stateTag(currentServiceState)}
            <Tooltip title={mode === 'light' ? '切换深色主题' : '切换浅色主题'}>
              <Button type="text" icon={mode === 'light' ? <MoonOutlined /> : <SunOutlined />} aria-label="切换主题" onClick={toggleMode} />
            </Tooltip>
          </div>
        </Header>

        <Layout className={styles.workspaceLayout}>
          <Sider className={styles.sidebar} width={288} theme={mode}>{catalog}</Sider>
          <Content id="main-content" className={styles.content} aria-busy={loading || refreshing}>
            {error && (
              <Alert
                className={styles.alert}
                type={overview ? 'warning' : 'error'}
                showIcon
                message={overview ? '当前展示的是最后一次成功快照' : '控制面暂时离线'}
                description={error}
                action={<Button onClick={() => void refreshAll(true)}>重新连接</Button>}
              />
            )}

            <section className={styles.hero} aria-labelledby="workbench-title">
              <div>
                <span className={styles.heroPrompt} aria-hidden="true">&gt;_</span>
                <h1 id="workbench-title">WaitQueue Workbench</h1>
                <Tag>Runtime Operations</Tag>
              </div>
              <p>轻量队列状态 · Redis 运行快照 · Claim 恢复 · Dead Letter 运维</p>
              <div className={styles.heroActions}>
                <Button icon={<ReloadOutlined spin={refreshing} />} disabled={refreshing} onClick={() => void refreshAll(true)}>刷新快照</Button>
                <Button type="primary" icon={<SendOutlined />} disabled={!activeQueue} onClick={() => openTaskModal(activeQueue ?? undefined)}>提交任务</Button>
              </div>
            </section>

            <Segmented
              className={styles.mobileViewNav}
              block
              value={view}
              options={[
                { label: '总览', value: 'overview', icon: <DashboardOutlined /> },
                { label: '队列', value: 'queues', icon: <BarsOutlined /> },
                { label: '死信', value: 'deadLetters', icon: <WarningOutlined /> },
                { label: '诊断', value: 'diagnostics', icon: <SafetyCertificateOutlined /> },
              ]}
              onChange={(value) => setView(value as ViewKey)}
              aria-label="工作台视图"
            />

            {loading && !overview ? (
              <div className={styles.initialSkeleton}><Skeleton active paragraph={{ rows: 10 }} /></div>
            ) : (
              <>
                {(view === 'overview' || view === 'queues') && (
                  <>
                    <section className={styles.summaryGrid} aria-label="运行摘要">
                      <Card className={styles.summaryCard} bordered title={<span><ThunderboltOutlined /> Runtime Pulse</span>} extra={<small>LIVE GAUGES</small>}>
                        <div className={styles.metricGrid}>
                          <Statistic title="当前积压" value={overview?.summary.waiting ?? '—'} suffix="tasks" />
                          <Statistic title="最老等待" value={formatAge(overview?.summary.oldestWaitingAgeSeconds, overview?.summary.waiting)} />
                          <Statistic title="运行 / 容量" value={overview ? `${overview.summary.running} / ${overview.summary.capacity}` : '—'} />
                          <Statistic title="Retry" value={metric(overview?.summary.retrying)} valueStyle={(overview?.summary.retrying ?? 0) > 0 ? { color: '#d46b08' } : undefined} />
                          <Statistic title="DLQ" value={metric(overview?.summary.deadLetters)} valueStyle={(overview?.summary.deadLetters ?? 0) > 0 ? { color: '#c9363e' } : undefined} />
                          <div className={styles.utilizationMetric}>
                            <small>容量利用率</small>
                            <Progress type="circle" size={52} percent={overview?.summary.utilization ?? 0} />
                          </div>
                        </div>
                      </Card>

                      <Card className={styles.summaryCard} bordered title={<span><SafetyCertificateOutlined /> Delivery & Recovery</span>} extra={<small>PROCESS COUNTERS</small>}>
                        <div className={styles.deliveryGrid}>
                          <div><small>CALLBACK OK</small><strong>{metric(overview?.summary.callbackSuccesses)}</strong></div>
                          <div><small>CALLBACK FAILED</small><strong className={(overview?.summary.callbackFailures ?? 0) > 0 ? styles.dangerText : undefined}>{metric(overview?.summary.callbackFailures)}</strong></div>
                          <div><small>CLAIMED</small><strong>{metric(overview?.summary.claims)}</strong></div>
                          <div><small>RECOVERED</small><strong>{metric(overview?.summary.recovered)}</strong></div>
                        </div>
                        <div className={styles.counterNote}>
                          <CodeOutlined /> 本进程观察累计，重启清零
                          {overview?.metricsStartedAt && <span>· since {formatTimestamp(overview.metricsStartedAt)}</span>}
                        </div>
                      </Card>
                    </section>

                    {activeQueue && (
                      <section className={styles.focusBar} aria-label="当前选中队列">
                        <CloudServerOutlined />
                        <div><small>CURRENT QUEUE · Q-{String(activeQueue.queueId).padStart(3, '0')}</small><strong>{activeQueue.namespace}</strong></div>
                        <code>{displayHook(activeQueue.hookUrl)}</code>
                        <div className={styles.focusMetrics}>
                          <span><b>{activeQueue.waiting}</b> waiting</span>
                          <span><b>{formatAge(activeQueue.oldestWaitingAgeSeconds, activeQueue.waiting)}</b> oldest</span>
                          <span><b>{metric(activeQueue.retrying)}</b> retry</span>
                          <span className={(activeQueue.deadLetters ?? 0) > 0 ? styles.dangerText : undefined}><b>{metric(activeQueue.deadLetters)}</b> DLQ</span>
                        </div>
                        <Space size={4}>
                          <Button icon={<SendOutlined />} onClick={() => openTaskModal(activeQueue)}>任务</Button>
                          <Button icon={<SettingOutlined />} onClick={() => openQueueModal(activeQueue)}>配置</Button>
                        </Space>
                      </section>
                    )}

                    <section className={styles.registryPanel} aria-labelledby="registry-title">
                      <div className={styles.sectionHeader}>
                        <div><h2 id="registry-title"><BarsOutlined /> Queue Registry</h2><p>真实运行快照 · 展开查看 Cron 和配置时间</p></div>
                        <Tag>{queues.length} / {overview?.summary.queueCount ?? 0}</Tag>
                      </div>
                      {queues.length > 0 ? (
                        <>
                          <div className={styles.desktopTable}>
                            <Table
                              rowKey="queueId"
                              columns={queueColumns}
                              dataSource={queues}
                              pagination={false}
                              size="small"
                              scroll={{ x: 1140 }}
                              rowClassName={(queue) => queue.queueId === activeQueue?.queueId ? styles.activeTableRow : ''}
                              expandable={{
                                expandedRowRender: (queue) => (
                                  <div className={styles.queueDetails}>
                                    <span><b>RUN</b><code>{queue.crontab.run}</code></span>
                                    <span><b>CHECK</b><code>{queue.crontab.check}</code></span>
                                    <span><b>EXPIRE</b><code>{queue.crontab.expire}</code></span>
                                    <span><b>UPDATED</b>{formatTimestamp(queue.updatedAt)}</span>
                                  </div>
                                ),
                              }}
                            />
                          </div>
                          <div className={styles.queueMobileList}>
                            {queues.map((queue) => {
                              const state = queueState(queue);
                              return (
                                <Card key={queue.queueId} size="small" title={queue.namespace} extra={<Tag color={state.color}>{state.label}</Tag>}>
                                  <div className={styles.mobileMetricGrid}>
                                    <span><small>WAITING</small><b>{queue.waiting}</b></span>
                                    <span><small>OLDEST</small><b>{formatAge(queue.oldestWaitingAgeSeconds, queue.waiting)}</b></span>
                                    <span><small>RETRY</small><b>{metric(queue.retrying)}</b></span>
                                    <span><small>DLQ</small><b>{metric(queue.deadLetters)}</b></span>
                                  </div>
                                  <Progress percent={queue.utilization} size="small" format={() => `${queue.running}/${queue.concurrency}`} />
                                  <Space><Button icon={<SendOutlined />} onClick={() => openTaskModal(queue)}>任务</Button><Button icon={<SettingOutlined />} onClick={() => openQueueModal(queue)}>配置</Button></Space>
                                </Card>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <Empty description={query ? '没有匹配的队列' : '还没有注册队列'}>
                          {query ? <Button onClick={() => setQuery('')}>清除筛选</Button> : <Button type="primary" icon={<PlusOutlined />} onClick={() => openQueueModal()}>注册第一条队列</Button>}
                        </Empty>
                      )}
                    </section>
                  </>
                )}

                {view === 'deadLetters' && (
                  <section className={styles.registryPanel} aria-labelledby="dlq-title">
                    <div className={styles.sectionHeader}>
                      <div><h2 id="dlq-title"><WarningOutlined /> Dead Letter Queue</h2><p>精确 generation 重放 · 失败时保留原记录</p></div>
                      <Space>
                        <Select
                          aria-label="选择死信队列"
                          value={activeQueue?.queueId}
                          style={{ minWidth: 180 }}
                          options={(overview?.queues ?? []).map((queue) => ({ value: queue.queueId, label: queue.namespace }))}
                          onChange={(queueId) => setActiveQueueId(queueId)}
                        />
                        <Button icon={<ReloadOutlined />} loading={deadLetterLoading} disabled={!activeQueue} onClick={() => activeQueue && void loadDeadLetters(activeQueue.queueId, deadLetterPage)}>刷新</Button>
                      </Space>
                    </div>
                    {activeQueue ? (
                      <>
                        <Alert className={styles.inlineInfo} type="info" showIcon message={`${activeQueue.namespace} · ${metric(activeQueue.deadLetters)} 条当前死信`} description="entryId 仅用于防止旧代际误重放，不会进入 Prometheus 标签或应用日志。" />
                        <Table rowKey="entryId" columns={deadLetterColumns} dataSource={currentDeadLetters?.items ?? []} loading={deadLetterLoading} pagination={false} size="small" scroll={{ x: 760 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有死信" /> }} />
                        {(currentDeadLetters?.total ?? 0) > DEAD_LETTER_PAGE_SIZE && (
                          <Pagination
                            className={styles.pagination}
                            current={deadLetterPage}
                            pageSize={DEAD_LETTER_PAGE_SIZE}
                            total={currentDeadLetters?.total ?? 0}
                            showSizeChanger={false}
                            onChange={(page) => void loadDeadLetters(activeQueue.queueId, page)}
                          />
                        )}
                      </>
                    ) : <Empty description="先注册并选择一个队列" />}
                  </section>
                )}

                {view === 'diagnostics' && (
                  <section className={styles.diagnosticsGrid} aria-labelledby="diagnostics-title">
                    <Card className={styles.diagnosticCard} title={<span id="diagnostics-title"><SafetyCertificateOutlined /> Service Diagnostics</span>}>
                      <div className={styles.healthRows}>
                        <div><span><CloudServerOutlined /> Process liveness</span>{health.live === null ? <Tag>UNKNOWN</Tag> : <Tag color={health.live ? 'success' : 'error'}>{health.live ? 'LIVE' : 'DOWN'}</Tag>}</div>
                        <div><span><SafetyCertificateOutlined /> Dependency readiness</span>{health.ready === null ? <Tag>UNKNOWN</Tag> : <Tag color={health.ready ? 'success' : 'warning'}>{health.ready ? 'READY' : 'UNAVAILABLE'}</Tag>}</div>
                        <div><span><DatabaseOutlined /> MySQL</span><Tag color={health.dependencies?.mysql === 'ok' ? 'success' : 'error'}>{health.dependencies?.mysql ?? 'unknown'}</Tag></div>
                        <div><span><DatabaseOutlined /> Redis</span><Tag color={health.dependencies?.redis === 'ok' ? 'success' : 'error'}>{health.dependencies?.redis ?? 'unknown'}</Tag></div>
                      </div>
                      <small>Last probe · {formatTimestamp(health.checkedAt)}</small>
                    </Card>
                    <Card className={styles.diagnosticCard} title={<span><CodeOutlined /> Telemetry Contract</span>}>
                      <ul className={styles.contractList}>
                        <li>Prometheus：<code>/metrics</code>（服务端 Bearer 鉴权；不经浏览器代理）</li>
                        <li>Gauge 来自约 1 秒缓存的 Redis / MySQL 运行快照。</li>
                        <li>Counter 为本进程观察值，重启清零；多实例使用 <code>sum(rate())</code>。</li>
                        <li>指标标签不包含 taskId、token、hookUrl 或异常消息。</li>
                      </ul>
                    </Card>
                  </section>
                )}
              </>
            )}

            <footer className={styles.footer}>
              <span><DatabaseOutlined /> DATA SOURCE · /waitqueue/admin/overview · 10s</span>
              <span>Snapshot {formatTimestamp(overview?.generatedAt)} · 不伪造趋势或历史成功率</span>
            </footer>
          </Content>
        </Layout>
      </Layout>

      <Drawer title="Queue Catalog" placement="left" width="min(88vw, 320px)" open={mobileCatalogOpen} onClose={() => setMobileCatalogOpen(false)} styles={{ body: { padding: 0 } }}>{catalog}</Drawer>

      <Modal title={editingQueueId === null ? '注册队列' : `编辑队列 Q-${String(editingQueueId).padStart(3, '0')}`} open={queueModalOpen} onCancel={() => setQueueModalOpen(false)} footer={null} destroyOnHidden>
        <Form form={queueForm} layout="vertical" initialValues={DEFAULT_QUEUE_VALUES} onFinish={submitQueue} requiredMark="optional">
          <div className={styles.formGrid}>
            <Form.Item name="namespace" label="Namespace" rules={[{ required: true, whitespace: true, max: 64 }]}><Input disabled={editingQueueId !== null} placeholder="billing" /></Form.Item>
            <Form.Item name="concurrency" label="并发上限" rules={[{ required: true }]}><InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} /></Form.Item>
          </div>
          <Form.Item name="hookUrl" label="Hook URL" rules={[{ required: true, type: 'url', max: 255 }]} extra="回调路径可能包含敏感信息，列表只显示 origin。"><Input disabled={editingQueueId !== null} placeholder="https://worker.example/callback" /></Form.Item>
          <div className={styles.cronFields}>
            <Form.Item name="run" label="RUN cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
            <Form.Item name="check" label="CHECK cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
            <Form.Item name="expire" label="EXPIRE cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
          </div>
          <div className={styles.modalActions}><Button onClick={() => setQueueModalOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={submitting}>{editingQueueId === null ? '注册队列' : '保存配置'}</Button></div>
        </Form>
      </Modal>

      <Modal title="提交任务" open={taskModalOpen} onCancel={() => setTaskModalOpen(false)} footer={null} destroyOnHidden>
        <Form form={taskForm} layout="vertical" onFinish={submitTask} requiredMark="optional">
          <Form.Item name="queueId" label="目标队列" rules={[{ required: true }]}><Select options={(overview?.queues ?? []).map((queue) => ({ value: queue.queueId, label: `${queue.namespace} · Q-${queue.queueId}` }))} /></Form.Item>
          <Form.Item name="taskId" label="Task ID" rules={[{ required: true, whitespace: true, max: 256 }]} extra="同一队列内，活跃 taskId 是幂等键。"><Input autoFocus placeholder="order-20260811-001" /></Form.Item>
          <div className={styles.modalActions}><Button onClick={() => setTaskModalOpen(false)}>取消</Button><Button type="primary" htmlType="submit" icon={<SendOutlined />} loading={submitting}>进入等待队列</Button></div>
        </Form>
      </Modal>
    </>
  );
};

export default Dashboard;
