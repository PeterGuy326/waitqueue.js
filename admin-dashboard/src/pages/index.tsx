import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Pagination,
  Progress,
  Row,
  Select,
  Skeleton,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  type BadgeProps,
  type MenuProps,
  type TagProps,
  type TableColumnsType,
} from 'antd';
import {
  Activity,
  ArchiveRestore,
  Boxes,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  LayoutDashboard,
  ListTree,
  Menu as MenuIcon,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  TriangleAlert,
  Waypoints,
} from 'lucide-react';
import type { NextPage } from 'next';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from '../style/dashboard.module.css';
import { useColorMode } from '../theme/control-room-theme';

const { Header, Sider, Content } = Layout;
const { Paragraph, Text, Title } = Typography;
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

const VIEW_COPY: Record<ViewKey, { title: string; description: string }> = {
  overview: { title: '运行总览', description: '队列积压、容量与恢复状态' },
  queues: { title: '队列详情', description: '运行快照与调度配置' },
  deadLetters: { title: '死信处理', description: '审阅并安全重放失败任务' },
  diagnostics: { title: '服务诊断', description: '探针与指标契约' },
};

const VIEW_MENU_ITEMS = [
  { key: 'overview', icon: <LayoutDashboard size={19} />, label: '总览' },
  { key: 'queues', icon: <ListTree size={19} />, label: '队列' },
  { key: 'deadLetters', icon: <ArchiveRestore size={19} />, label: '死信' },
  { key: 'diagnostics', icon: <ShieldCheck size={19} />, label: '诊断' },
] satisfies Array<{ key: ViewKey; icon: ReactNode; label: string }>;

const RAIL_MENU_STYLES: MenuProps['styles'] = {
  root: { width: '100%', flex: 1, borderInlineEnd: 0 },
  item: {
    display: 'flex',
    width: 'var(--ui-rail-item-width, 52px)',
    height: 'var(--ui-rail-item-height, 56px)',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    margin: '4px 2px',
    padding: '5px 2px',
    lineHeight: 1,
  },
  itemIcon: { display: 'inline-grid', minWidth: 19, margin: 0, placeItems: 'center' },
  itemContent: { width: '100%', margin: 0, overflow: 'visible', textAlign: 'center', textOverflow: 'clip' },
};

const QUEUE_MENU_STYLES: MenuProps['styles'] = {
  root: { background: 'transparent', borderInlineEnd: 0 },
  item: { height: 62, marginBlock: 2, marginInline: 0, paddingInline: 10, lineHeight: 'normal' },
  itemIcon: { lineHeight: 1 },
  itemContent: { minWidth: 0 },
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

function queueState(queue: QueueOverviewItem): { label: string; color: 'success' | 'warning' | 'error' | 'default'; badge: 'success' | 'warning' | 'error' | 'default' } {
  if ((queue.deadLetters ?? 0) > 0) return { label: '需要处理', color: 'error', badge: 'error' };
  if (queue.waiting > 0 && queue.running >= queue.concurrency) return { label: '容量已满', color: 'warning', badge: 'warning' };
  if (queue.waiting > 0 || (queue.retrying ?? 0) > 0) return { label: '存在积压', color: 'warning', badge: 'warning' };
  if (queue.running > 0) return { label: '运行中', color: 'success', badge: 'success' };
  return { label: '空闲', color: 'default', badge: 'default' };
}

type StatusTone = 'success' | 'warning' | 'error' | 'processing' | 'default';

const STATUS_TAG_STYLES: Record<Exclude<StatusTone, 'default'>, TagProps['styles']> = {
  success: { root: { color: 'var(--ui-success)', background: 'var(--ui-success-soft)' } },
  warning: { root: { color: 'var(--ui-warning)', background: 'var(--ui-warning-soft)' } },
  error: { root: { color: 'var(--ui-danger)', background: 'var(--ui-danger-soft)' } },
  processing: { root: { color: 'var(--ui-info)', background: 'var(--ui-info-soft)' } },
};

const QUEUE_COUNT_BADGE_STYLES: BadgeProps['styles'] = {
  indicator: { color: 'var(--ui-primary-foreground)', background: 'var(--ui-primary)' },
};

function StatusTag({ tone, icon, children, label }: { tone: StatusTone; icon?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <Tag
      color={tone}
      icon={icon}
      styles={tone === 'default' ? undefined : STATUS_TAG_STYLES[tone]}
      aria-label={label}
      title={label}
    >
      {children}
    </Tag>
  );
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
  const map: Record<ServiceState, { color: StatusTone; icon: ReactNode; text: string }> = {
    SYNCING: { color: 'processing', icon: <RefreshCw className={styles.spin} size={13} />, text: '正在同步' },
    ONLINE: { color: 'success', icon: <CheckCircle2 size={13} />, text: '服务在线' },
    DEGRADED: { color: 'warning', icon: <TriangleAlert size={13} />, text: '依赖异常' },
    STALE: { color: 'warning', icon: <Clock3 size={13} />, text: '快照陈旧' },
    OFFLINE: { color: 'error', icon: <TriangleAlert size={13} />, text: '服务离线' },
  };
  const item = map[state];
  return <StatusTag tone={item.color} icon={item.icon} label={item.text}>{item.text}</StatusTag>;
}

function ConsolePageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: ReactNode;
  description: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderMain}>
        <Title level={1} className={styles.pageTitle}>{title}</Title>
        <Paragraph type="secondary" className={styles.pageDescription}>{description}</Paragraph>
        {meta && <div className={styles.pageMeta}>{meta}</div>}
      </div>
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

function SummaryMetricCard({
  title,
  icon,
  value,
  suffix,
  tone = 'default',
  progress,
  footer,
}: {
  title: string;
  icon: ReactNode;
  value: number | string;
  suffix?: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
  progress?: number;
  footer?: ReactNode;
}) {
  const toneClass = tone === 'danger'
    ? styles.metricDanger
    : tone === 'warning'
      ? styles.metricWarning
      : '';
  return (
    <Card className={`${styles.metricCard} ${toneClass}`}>
      <Statistic
        title={(
          <Flex align="center" justify="space-between" gap={12}>
            <Text type="secondary">{title}</Text>
            <span className={styles.metricIcon}>{icon}</span>
          </Flex>
        )}
        value={value}
        suffix={suffix}
      />
      {progress !== undefined && (
        <Progress percent={Math.min(100, Math.max(0, progress))} showInfo={false} size="small" />
      )}
      {footer && <div className={styles.metricFooter}>{footer}</div>}
    </Card>
  );
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
  const queueItems: MenuProps['items'] = queues.map((queue) => {
    const state = queueState(queue);
    const avatarClass = state.badge === 'error'
      ? styles.queueAvatarDanger
      : state.badge === 'warning'
        ? styles.queueAvatarWarning
        : state.badge === 'success'
          ? styles.queueAvatarHealthy
          : styles.queueAvatarNeutral;
    return {
      key: String(queue.queueId),
      icon: <span className={`${styles.queueAvatar} ${avatarClass}`}><Server size={15} /></span>,
      label: (
        <span className={styles.queueMenuLabel}>
          <span className={styles.queueNavCopy}>
            <strong title={queue.namespace}>{queue.namespace}</strong>
            <small>Q-{String(queue.queueId).padStart(3, '0')} · {state.label}</small>
          </span>
          <span className={styles.queueNavCount} aria-label={`${queue.waiting} 个等待任务`}>
            <strong>{queue.waiting}</strong>
            <small>等待</small>
          </span>
          {queue.queueId === activeQueueId && <span className={styles.srOnly}>当前队列</span>}
        </span>
      ),
    };
  });

  return (
    <div className={styles.catalog}>
      <div className={styles.catalogHeader}>
        <span className={styles.catalogAvatar}><Boxes size={18} /></span>
        <span className={styles.catalogHeaderCopy}>
          <strong>WaitQueue</strong>
          <small>队列运行中心</small>
        </span>
        <Badge count={overview?.summary.queueCount ?? 0} showZero styles={QUEUE_COUNT_BADGE_STYLES} />
      </div>

      <div className={styles.catalogSearch}>
        <Input
          allowClear
          prefix={<Search size={15} />}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索队列或回调源"
          aria-label="搜索队列"
        />
      </div>

      <div className={styles.catalogSectionHeader}>
        <span>运行队列</span>
        <span>{queues.length} / {overview?.summary.queueCount ?? 0}</span>
      </div>

      <nav className={styles.queueNav} aria-label="已注册队列">
        {queueItems.length > 0 ? (
          <Menu
            className={styles.queueMenu}
            mode="inline"
            aria-label="选择队列"
            styles={QUEUE_MENU_STYLES}
            items={queueItems}
            selectedKeys={activeQueueId === null ? [] : [String(activeQueueId)]}
            onClick={({ key }) => onSelect(Number(key))}
          />
        ) : (
          <Empty
            className={styles.catalogEmpty}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={query ? '没有匹配的队列' : '暂无队列'}
          />
        )}
      </nav>

      <div className={styles.catalogFooter}>
        <Button type="primary" icon={<Plus size={16} />} block onClick={onCreate}>注册队列</Button>
        <Text type="secondary"><RefreshCw size={12} /> 每 10 秒自动刷新</Text>
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
      setActiveQueueId((current) => data.queues.some((queue) => queue.queueId === current) ? current : data.queues[0]?.queueId ?? null);
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
      icon: <RotateCcw size={19} />,
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

  const openQueueView = (queueId: number) => {
    setActiveQueueId(queueId);
    setView('queues');
    setMobileCatalogOpen(false);
  };

  const menuItems: MenuProps['items'] = VIEW_MENU_ITEMS.map((item) => ({
    ...item,
    label: <span>{item.label}{view === item.key && <span className={styles.srOnly}>，当前页面</span>}</span>,
  }));

  const queueColumns: TableColumnsType<QueueOverviewItem> = [
    {
      title: '队列',
      key: 'queue',
      width: 230,
      render: (_, queue) => (
        <div className={styles.queueIdentity}>
          <Button type="link" onClick={() => openQueueView(queue.queueId)}>{queue.namespace}</Button>
          <span><code>Q-{String(queue.queueId).padStart(3, '0')}</code> · {displayHook(queue.hookUrl)}</span>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_, queue) => {
        const state = queueState(queue);
        return <StatusTag tone={state.color}>{state.label}</StatusTag>;
      },
    },
    {
      title: '等待',
      key: 'backlog',
      width: 150,
      render: (_, queue) => (
        <div className={styles.tableMetric}>
          <strong className={queue.waiting > 0 ? styles.warningText : undefined}>{queue.waiting}</strong>
          <small>{formatAge(queue.oldestWaitingAgeSeconds, queue.waiting)}</small>
        </div>
      ),
    },
    {
      title: '运行容量',
      key: 'capacity',
      width: 180,
      render: (_, queue) => (
        <div className={styles.capacityCell}>
          <span><b>{queue.running}</b> / {queue.concurrency}</span>
          <Progress percent={Math.min(100, Math.max(0, queue.utilization))} showInfo={false} size="small" />
        </div>
      ),
    },
    {
      title: '失败',
      key: 'failures',
      width: 120,
      align: 'right',
      render: (_, queue) => (
        <span className={(queue.callbacks?.failure ?? 0) > 0 || (queue.deadLetters ?? 0) > 0 ? styles.dangerText : undefined}>
          {metric(queue.callbacks?.failure)} / {metric(queue.deadLetters)} DLQ
        </span>
      ),
    },
  ];

  const deadLetterColumns: TableColumnsType<DeadLetterItem> = [
    { title: '任务 ID', dataIndex: 'taskId', ellipsis: true, render: (value: string) => <code>{value}</code> },
    { title: '失败原因', dataIndex: 'reason', width: 150, render: (value: DeadLetterItem['reason']) => <StatusTag tone="error">{value === 'lease_expired' ? '租约过期' : '回调失败'}</StatusTag> },
    { title: '重试次数', dataIndex: 'retryCount', width: 110, align: 'right' },
    { title: '失败时间', dataIndex: 'failedAt', width: 180, render: formatTimestamp },
    { title: '操作', key: 'action', width: 110, fixed: 'right', render: (_, item) => <Button type="link" icon={<RotateCcw size={15} />} onClick={() => replayDeadLetter(item)}>重放</Button> },
  ];

  const catalog = (
    <SidebarCatalog
      overview={overview}
      queues={queues}
      activeQueueId={view === 'queues' || view === 'deadLetters' ? activeQueue?.queueId ?? null : null}
      query={query}
      onQuery={setQuery}
      onSelect={(queueId) => {
        setActiveQueueId(queueId);
        if (view !== 'deadLetters') setView('queues');
        setMobileCatalogOpen(false);
      }}
      onCreate={() => {
        setMobileCatalogOpen(false);
        openQueueModal();
      }}
    />
  );

  const renderOverview = () => (
    <>
      <ConsolePageHeader
        title="队列运行概览"
        description="查看当前积压、执行容量和失败恢复状态。所有数据都来自实时运行快照。"
        meta={<span>已注册 {overview?.summary.queueCount ?? 0} 个队列 · 每 10 秒自动同步</span>}
        actions={<Button icon={<Plus size={16} />} onClick={() => openQueueModal()}>注册队列</Button>}
      />

      <Row className={styles.metricGrid} gutter={[16, 16]} role="region" aria-label="运行摘要">
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard
            title="等待任务"
            icon={<Clock3 size={18} />}
            value={overview?.summary.waiting ?? '—'}
            suffix="个"
            tone={(overview?.summary.waiting ?? 0) > 0 ? 'warning' : 'default'}
            footer={<>最老等待：{formatAge(overview?.summary.oldestWaitingAgeSeconds, overview?.summary.waiting)}</>}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard
            title="运行容量"
            icon={<Activity size={18} />}
            value={overview ? `${overview.summary.running} / ${overview.summary.capacity}` : '—'}
            progress={overview?.summary.utilization ?? 0}
            footer={<>容量利用率 {overview?.summary.utilization ?? 0}%</>}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard
            title="延迟重试"
            icon={<RotateCcw size={18} />}
            value={metric(overview?.summary.retrying)}
            suffix="个"
            tone={(overview?.summary.retrying ?? 0) > 0 ? 'warning' : 'default'}
            footer="等待下一次回队调度"
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard
            title="死信任务"
            icon={<ArchiveRestore size={18} />}
            value={metric(overview?.summary.deadLetters)}
            suffix="个"
            tone={(overview?.summary.deadLetters ?? 0) > 0 ? 'danger' : 'default'}
            footer={<Button type="link" onClick={() => setView('deadLetters')}>进入死信处理</Button>}
          />
        </Col>
      </Row>

      <Row className={styles.overviewGrid} gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={18}>
          <Card
            className={styles.queueHealthCard}
            title={<div className={styles.cardHeading}><ListTree size={18} /><span><strong>队列健康</strong><small>查看实时积压和失败状态</small></span></div>}
            extra={<Tag>{overview?.summary.queueCount ?? 0} 个队列</Tag>}
          >
          {(overview?.queues.length ?? 0) > 0 ? (
            <>
              <div className={styles.desktopTable}>
                <Table rowKey="queueId" columns={queueColumns} dataSource={overview?.queues ?? []} pagination={false} size="small" scroll={{ x: 700 }} />
              </div>
              <div className={styles.mobileQueueList}>
                {(overview?.queues ?? []).map((queue) => {
                  const state = queueState(queue);
                  return (
                    <button key={queue.queueId} type="button" className={styles.mobileQueueCard} onClick={() => openQueueView(queue.queueId)}>
                      <span className={styles.mobileQueueHeader}><strong>{queue.namespace}</strong><StatusTag tone={state.color}>{state.label}</StatusTag></span>
                      <span className={styles.mobileQueueMetrics}>
                        <span><small>等待</small><b>{queue.waiting}</b></span>
                        <span><small>运行</small><b>{queue.running}/{queue.concurrency}</b></span>
                        <span><small>重试</small><b>{metric(queue.retrying)}</b></span>
                        <span><small>DLQ</small><b>{metric(queue.deadLetters)}</b></span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有注册队列">
              <Button type="primary" icon={<Plus size={16} />} onClick={() => openQueueModal()}>注册第一条队列</Button>
            </Empty>
          )}
          </Card>
        </Col>

        <Col xs={24} xl={6}>
          <Card
            className={styles.recoveryCard}
            title={<div className={styles.cardHeading}><Waypoints size={18} /><span><strong>投递与恢复</strong><small>当前进程累计值</small></span></div>}
          >
            <Row className={styles.counterList} gutter={[12, 12]}>
              <Col span={12}><Statistic title="回调成功" value={metric(overview?.summary.callbackSuccesses)} /></Col>
              <Col span={12}><Statistic className={(overview?.summary.callbackFailures ?? 0) > 0 ? styles.dangerStatistic : undefined} title="回调失败" value={metric(overview?.summary.callbackFailures)} /></Col>
              <Col span={12}><Statistic title="成功认领" value={metric(overview?.summary.claims)} /></Col>
              <Col span={12}><Statistic title="租约恢复" value={metric(overview?.summary.recovered)} /></Col>
            </Row>
            <div className={styles.counterNote}>
              <Clock3 size={14} />
              <span>统计自 {formatTimestamp(overview?.metricsStartedAt)}，服务重启后重新计数。</span>
            </div>
          </Card>
        </Col>
      </Row>
    </>
  );

  const renderQueueDetail = () => activeQueue ? (
    <>
      <ConsolePageHeader
        title={activeQueue.namespace}
        description={displayHook(activeQueue.hookUrl)}
        meta={
          <>
            <StatusTag tone={queueState(activeQueue).color}>{queueState(activeQueue).label}</StatusTag>
            <span>配置更新于 {formatTimestamp(activeQueue.updatedAt)}</span>
          </>
        }
        actions={(
          <>
            <Button icon={<Settings size={16} />} onClick={() => openQueueModal(activeQueue)}>编辑配置</Button>
            <Button type="primary" icon={<Send size={16} />} onClick={() => openTaskModal(activeQueue)}>提交任务</Button>
          </>
        )}
      />

      <Row className={styles.metricGrid} gutter={[16, 16]} role="region" aria-label="当前队列运行摘要">
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard title="等待任务" icon={<Clock3 size={18} />} value={activeQueue.waiting} suffix="个" tone={activeQueue.waiting > 0 ? 'warning' : 'default'} footer={<>最老等待：{formatAge(activeQueue.oldestWaitingAgeSeconds, activeQueue.waiting)}</>} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard title="运行中" icon={<Activity size={18} />} value={activeQueue.running} suffix={`/ ${activeQueue.concurrency}`} progress={activeQueue.utilization} footer={<>当前可用槽位：{activeQueue.available}</>} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard title="延迟重试" icon={<RotateCcw size={18} />} value={metric(activeQueue.retrying)} suffix="个" tone={(activeQueue.retrying ?? 0) > 0 ? 'warning' : 'default'} footer="失败后按退避策略回队" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <SummaryMetricCard title="死信任务" icon={<ArchiveRestore size={18} />} value={metric(activeQueue.deadLetters)} suffix="个" tone={(activeQueue.deadLetters ?? 0) > 0 ? 'danger' : 'default'} footer={<Button type="link" onClick={() => setView('deadLetters')}>查看并处理</Button>} />
        </Col>
      </Row>

      <Row className={styles.queueDetailGrid} gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card className={styles.detailCard} title={<div className={styles.cardHeading}><Gauge size={18} /><span><strong>运行容量</strong><small>当前并发槽位使用情况</small></span></div>}>
            <div className={styles.capacitySummary}>
              <span><strong>{activeQueue.utilization}%</strong><small>容量利用率</small></span>
              <Progress percent={activeQueue.utilization} showInfo={false} />
            </div>
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'running', label: '运行中', children: activeQueue.running },
                { key: 'available', label: '可用槽位', children: activeQueue.available },
                { key: 'capacity', label: '并发上限', children: activeQueue.concurrency },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card className={styles.detailCard} title={<div className={styles.cardHeading}><Clock3 size={18} /><span><strong>调度策略</strong><small>服务端生效中的 Cron 配置</small></span></div>}>
            <div className={styles.scheduleList}>
              <div><span>运行任务</span><code>{activeQueue.crontab.run}</code></div>
              <div><span>检查任务</span><code>{activeQueue.crontab.check}</code></div>
              <div><span>回收过期</span><code>{activeQueue.crontab.expire}</code></div>
            </div>
          </Card>
        </Col>

        <Col span={24}>
          <Card className={styles.detailCard} title={<div className={styles.cardHeading}><Waypoints size={18} /><span><strong>投递生命周期</strong><small>该队列在当前进程中的累计状态变化</small></span></div>}>
            <Row className={styles.callbackGrid} gutter={[12, 12]}>
              <Col xs={12} lg={6}><Statistic title="回调成功" value={metric(activeQueue.callbacks?.success)} /></Col>
              <Col xs={12} lg={6}><Statistic className={(activeQueue.callbacks?.failure ?? 0) > 0 ? styles.dangerStatistic : undefined} title="回调失败" value={metric(activeQueue.callbacks?.failure)} /></Col>
              <Col xs={12} lg={6}><Statistic title="任务认领" value={metric(activeQueue.claims?.claimed)} /></Col>
              <Col xs={12} lg={6}><Statistic title="租约恢复" value={metric(activeQueue.claims?.recovered)} /></Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </>
  ) : (
    <Card className={styles.emptySurface}>
      <Empty description="还没有可查看的队列"><Button type="primary" onClick={() => openQueueModal()}>注册队列</Button></Empty>
    </Card>
  );

  const renderDeadLetters = () => (
    <>
      <ConsolePageHeader
        title="死信处理"
        description="按任务代际精确重放；重放失败时保留原始死信记录。"
        meta={<span>entryId 仅用于代际校验，不进入指标标签或应用日志。</span>}
        actions={
          <>
            <Select
              aria-label="选择死信队列"
              value={activeQueue?.queueId}
              className={styles.queueSelect}
              options={(overview?.queues ?? []).map((queue) => ({ value: queue.queueId, label: queue.namespace }))}
              onChange={(queueId) => setActiveQueueId(queueId)}
            />
            <Button icon={<RefreshCw className={deadLetterLoading ? styles.spin : undefined} size={16} />} loading={false} disabled={!activeQueue || deadLetterLoading} onClick={() => activeQueue && void loadDeadLetters(activeQueue.queueId, deadLetterPage)}>刷新</Button>
          </>
        }
      />

      {activeQueue ? (
        <Card className={styles.surfaceCard}>
          <Flex className={styles.deadLetterSummary} align="flex-start" justify="space-between" gap={16} wrap>
            <div>
              <Text strong>{activeQueue.namespace}</Text>
              <Paragraph type="secondary">重放会重新进入等待队列，并保留完整的幂等与代际保护。</Paragraph>
            </div>
            <StatusTag tone={(currentDeadLetters?.total ?? activeQueue.deadLetters ?? 0) > 0 ? 'warning' : 'success'}>
              {currentDeadLetters?.total ?? metric(activeQueue.deadLetters)} 条死信
            </StatusTag>
          </Flex>
          <div className={styles.desktopTable}>
            <Table rowKey="entryId" columns={deadLetterColumns} dataSource={currentDeadLetters?.items ?? []} loading={deadLetterLoading} pagination={false} size="small" scroll={{ x: 760 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有死信" /> }} />
          </div>
          <div className={styles.mobileDeadLetterList}>
            {(currentDeadLetters?.items ?? []).map((item) => (
              <Card key={item.entryId} size="small" className={styles.deadLetterCard}>
                <div className={styles.deadLetterHeader}><code>{item.taskId}</code><StatusTag tone="error">{item.reason === 'lease_expired' ? '租约过期' : '回调失败'}</StatusTag></div>
                <div className={styles.deadLetterMeta}><span>已重试 {item.retryCount} 次</span><span>{formatTimestamp(item.failedAt)}</span></div>
                <Button icon={<RotateCcw size={15} />} onClick={() => replayDeadLetter(item)}>重放任务</Button>
              </Card>
            ))}
            {!deadLetterLoading && (currentDeadLetters?.items.length ?? 0) === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有死信" />}
          </div>
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
        </Card>
      ) : (
        <Card className={styles.emptySurface}><Empty description="先注册并选择一个队列" /></Card>
      )}
    </>
  );

  const renderDiagnostics = () => {
    const probes = [
      { key: 'live', title: '进程存活', path: '/health/live', ok: health.live, icon: <Activity size={19} /> },
      { key: 'ready', title: '依赖就绪', path: '/health/ready', ok: health.ready, icon: <ShieldCheck size={19} /> },
      { key: 'mysql', title: 'MySQL', path: '持久化存储', ok: health.dependencies?.mysql === 'ok' ? true : health.dependencies ? false : null, icon: <Database size={19} /> },
      { key: 'redis', title: 'Redis', path: '运行状态存储', ok: health.dependencies?.redis === 'ok' ? true : health.dependencies ? false : null, icon: <Database size={19} /> },
    ];
    return (
      <>
        <ConsolePageHeader
          title="服务诊断"
          description="健康探针只报告服务状态；Prometheus 指标由服务端鉴权端点提供。"
          meta={<span>最近检查：{formatTimestamp(health.checkedAt)}</span>}
        />

        <Row className={styles.healthGrid} gutter={[16, 16]} role="region" aria-label="服务健康状态">
          {probes.map((probe) => (
            <Col key={probe.key} xs={24} sm={12} xl={6}>
              <Card className={styles.healthCard}>
                <span className={`${styles.healthIcon} ${probe.ok === false ? styles.healthIconDanger : probe.ok === null ? styles.healthIconUnknown : ''}`}>{probe.icon}</span>
                <span className={styles.healthCopy}><strong>{probe.title}</strong><small>{probe.path}</small></span>
                <Badge status={probe.ok === null ? 'default' : probe.ok ? 'success' : 'error'} text={probe.ok === null ? '未知' : probe.ok ? '正常' : '异常'} />
              </Card>
            </Col>
          ))}
        </Row>

        <Row className={styles.diagnosticsGrid} gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card className={styles.detailCard} title={<div className={styles.cardHeading}><ShieldCheck size={18} /><span><strong>探针契约</strong><small>适用于编排系统与负载均衡器</small></span></div>}>
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: 'live', label: 'Liveness', children: <code>/health/live</code> },
                  { key: 'ready', label: 'Readiness', children: <code>/health/ready</code> },
                  { key: 'cache', label: '缓存策略', children: 'readiness 禁止缓存' },
                  { key: 'failure', label: '失败状态', children: '依赖异常时返回 HTTP 503' },
                ]}
              />
            </Card>
          </Col>

          <Col xs={24} lg={12}>
            <Card className={styles.detailCard} title={<div className={styles.cardHeading}><Gauge size={18} /><span><strong>指标契约</strong><small>低基数 Prometheus exposition</small></span></div>}>
              <div className={styles.contractList}>
                <div><span>服务端端点</span><code>/metrics</code></div>
                <div><span>访问方式</span><b>Bearer 鉴权</b></div>
                <div><span>浏览器代理</span><Tag>不开放</Tag></div>
                <div><span>Counter 语义</span><b>进程重启清零</b></div>
              </div>
              <Alert type="info" showIcon message="多实例聚合请使用 sum(rate())；标签不包含 taskId、token、hookUrl 或异常消息。" />
            </Card>
          </Col>
        </Row>
      </>
    );
  };

  return (
    <>
      <Head>
        <title>WaitQueue · 队列运行中心</title>
        <meta name="description" content="WaitQueue 队列运行、恢复与服务诊断中心" />
      </Head>
      <a className={styles.skipLink} href="#main-content">跳到主要内容</a>

      <Layout className={styles.shell} data-product="waitqueue-console">
        <Sider className={styles.moduleRail} width="var(--ui-rail-width)" theme={mode} aria-label="主模块导航">
          <div className={styles.moduleRailInner}>
            <Tooltip title="WaitQueue" placement="right">
              <button type="button" className={styles.brandMark} aria-label="返回运行总览" onClick={() => setView('overview')}><Boxes size={22} /></button>
            </Tooltip>
            <Menu
              className={styles.railMenu}
              mode="inline"
              aria-label="运行模块"
              classNames={{ itemContent: styles.railMenuContent }}
              styles={RAIL_MENU_STYLES}
              items={menuItems}
              selectedKeys={[view]}
              onClick={({ key }) => setView(key as ViewKey)}
            />
            <div className={styles.railFooter}>
              <Tooltip title={mode === 'light' ? '切换深色主题' : '切换浅色主题'} placement="right">
                <Button
                  type="text"
                  icon={mode === 'light' ? <Moon size={18} /> : <Sun size={18} />}
                  aria-label={mode === 'light' ? '切换深色主题' : '切换浅色主题'}
                  aria-pressed={mode === 'dark'}
                  onClick={toggleMode}
                />
              </Tooltip>
            </div>
          </div>
        </Sider>

        <Sider className={styles.contextSidebar} width="var(--ui-sidebar-width)" theme={mode} aria-label="队列目录">{catalog}</Sider>

        <Layout className={styles.mainLayout}>
          <Header className={styles.topbar}>
            <div className={styles.topbarContext}>
              <Button className={styles.mobileMenu} type="text" icon={<MenuIcon size={19} />} aria-label="打开队列目录" onClick={() => setMobileCatalogOpen(true)} />
              <Text strong>{VIEW_COPY[view].title}</Text>
              <Text type="secondary" className={styles.topbarDescription}>· {VIEW_COPY[view].description}</Text>
            </div>
            <div className={styles.topbarActions}>
              <span className={styles.updated}>更新于 {formatTimestamp(overview?.generatedAt)}</span>
              {stateTag(currentServiceState)}
              <Tooltip title="刷新运行快照">
                <Button type="text" icon={<RefreshCw className={refreshing ? styles.spin : undefined} size={17} />} aria-label="刷新运行快照" disabled={refreshing} onClick={() => void refreshAll(true)} />
              </Tooltip>
            </div>
          </Header>

          <Content id="main-content" className={styles.content} tabIndex={-1} aria-busy={loading || refreshing}>
            <div className={styles.page}>
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

              {loading && !overview ? (
                <Card className={styles.initialSkeleton}><Skeleton active paragraph={{ rows: 12 }} /></Card>
              ) : (
                <>
                  {view === 'overview' && renderOverview()}
                  {view === 'queues' && renderQueueDetail()}
                  {view === 'deadLetters' && renderDeadLetters()}
                  {view === 'diagnostics' && renderDiagnostics()}
                </>
              )}

            </div>
          </Content>
        </Layout>
      </Layout>

      <Drawer rootClassName={styles.catalogDrawer} title="队列目录" placement="left" size="min(88vw, 320px)" open={mobileCatalogOpen} onClose={() => setMobileCatalogOpen(false)} styles={{ body: { padding: 0 } }}>{catalog}</Drawer>

      <Modal rootClassName={styles.consoleModal} title={editingQueueId === null ? '注册队列' : `编辑队列 Q-${String(editingQueueId).padStart(3, '0')}`} width={680} open={queueModalOpen} onCancel={() => setQueueModalOpen(false)} footer={null} destroyOnHidden>
        <Form form={queueForm} layout="vertical" initialValues={DEFAULT_QUEUE_VALUES} onFinish={submitQueue} requiredMark="optional">
          <div className={styles.formGrid}>
            <Form.Item name="namespace" label="Namespace" rules={[{ required: true, whitespace: true, max: 64 }]}><Input disabled={editingQueueId !== null} placeholder="billing" /></Form.Item>
            <Form.Item name="concurrency" label="并发上限" rules={[{ required: true }]}><InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} /></Form.Item>
          </div>
          <Form.Item name="hookUrl" label="Hook URL" rules={[{ required: true, type: 'url', max: 255 }]} extra="回调路径可能包含敏感信息，列表只显示 origin。"><Input disabled={editingQueueId !== null} placeholder="https://worker.example/callback" /></Form.Item>
          <div className={styles.cronFields}>
            <Form.Item name="run" label="运行 cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
            <Form.Item name="check" label="检查 cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
            <Form.Item name="expire" label="回收 cron" rules={[{ required: true, max: 64 }]}><Input /></Form.Item>
          </div>
          <div className={styles.modalActions}><Button onClick={() => setQueueModalOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={submitting}>{editingQueueId === null ? '注册队列' : '保存配置'}</Button></div>
        </Form>
      </Modal>

      <Modal rootClassName={styles.consoleModal} title="提交任务" open={taskModalOpen} onCancel={() => setTaskModalOpen(false)} footer={null} destroyOnHidden>
        <Form form={taskForm} layout="vertical" onFinish={submitTask} requiredMark="optional">
          <Form.Item name="queueId" label="目标队列" rules={[{ required: true }]}><Select options={(overview?.queues ?? []).map((queue) => ({ value: queue.queueId, label: `${queue.namespace} · Q-${queue.queueId}` }))} /></Form.Item>
          <Form.Item name="taskId" label="Task ID" rules={[{ required: true, whitespace: true, max: 256 }]} extra="同一队列内，活跃 taskId 是幂等键。"><Input autoFocus placeholder="order-20260811-001" /></Form.Item>
          <div className={styles.modalActions}><Button onClick={() => setTaskModalOpen(false)}>取消</Button><Button type="primary" htmlType="submit" icon={<Send size={16} />} loading={submitting}>进入等待队列</Button></div>
        </Form>
      </Modal>
    </>
  );
};

export default Dashboard;
