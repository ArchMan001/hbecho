// 编排（design §5.2、§7）：授权 → 选执行 → 经 D 的读口取行 → 经 A 补名称 / 快照 / 采集状态 / 图片 → 套列规则与单元格规则。
// 只读：没有写入、没有锁、网络 IO（图片签名）发生在数据库读取之后，不持有事务。
import type { Db } from "../../db/client";
import { isEmptyScope, type AuthContext, type Authorizer, type createEgress, type ResourceConstraint } from "../access-control";
import { JudgementError } from "../judgement/errors";
import type { ContentFact, ExecutionDescriptor, OrgFilter, Outcomes, ParticipantFact } from "../judgement/outcomes";
import type { MediaObjectStore } from "../raw-capture/ports";
import { accountCell, contentCell, emptyCell, fmtBjt, httpUrl, kindLabel, resultCell, valueCell } from "./cells";
import { authorizeReport, CAP_EXPORT, CAP_READ, type ReportRef } from "./authz";
import { buildColumns } from "./columns";
import { exportFileName, writeWorkbook } from "./export";
import { createReportFacts, type OrgNames, type ProfileFact, type ReportFacts, type SnapshotFact, type SyncFact } from "./facts";
import {
  DEFAULT_EXPORT_LIMITS, MAX_CONCURRENT_EXPORTS, PAGE_SIZE, ReportError,
  type Cell, type ColumnDef, type ExecutionOption, type ReportFilterInput, type ReportHeader, type Tab, type TableView, type ViewRow,
} from "./types";

export type OutcomesPort = Pick<Outcomes, "executionsOf" | "planRefOf" | "plansOverview" | "listContents" | "listParticipants" | "streamContents" | "streamParticipants">;
export interface ReportDeps {
  db: Db;
  authorizer: Pick<Authorizer, "authorize">;
  egress: Pick<ReturnType<typeof createEgress>, "guardExit">;
  outcomes: OutcomesPort;
  /** 正式媒资桶签名器；null = 未配置，所有图片用占位 */
  media: Pick<MediaObjectStore, "signedGetUrl"> | null;
  mediaTtlSeconds: number;
  limits?: { videoRows: number; accountRows: number };
  alert?: (e: { code: string; [k: string]: unknown }) => void;
}
const STAFF_QUERY_MAX = 200;
const BATCH = 500;
const dec = (s: string | undefined, what: string): bigint | undefined => {
  if (s === undefined || s === "") return undefined;
  if (!/^[1-9]\d{0,18}$/.test(s)) throw new ReportError("input", "invalid_filter", `${what}不是合法的 ID`);
  return BigInt(s);
};
/** D 的错误 → 报表错误：不存在 → not_found；其余原样上抛（页面显示通用错误）。 */
function mapD(e: unknown): never {
  if (e instanceof JudgementError && e.category === "not_found") throw new ReportError("not_found", e.code, "找不到这个判定计划或执行");
  throw e;
}
const prunedOf = (e: unknown): boolean => e instanceof JudgementError && e.code === "content_rows_pruned";

export interface FilterOptions {
  regions: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string; regionId: string }>;
  sectors: Array<{ id: string; name: string }>;
  stores: Array<{ id: string; name: string; branchId: string; sectorId: string }>;
}
export interface ReportView {
  header: ReportHeader;
  executions: ExecutionOption[];
  options: FilterOptions;
  tab: Tab;
  table: TableView;
  /** 范围内（未筛选）的行数，用于标签上的数字；视频明细已被清理为 0 */
  totals: { videos: number; accounts: number };
}
export interface ExportPlan {
  fileName: string;
  warnings: string[];
  videoRows: number;
  accountRows: number;
}
export interface OverviewRow {
  planId: string;
  alias: string;
  activityPlanName: string;
  platformCode: string;
  archived: boolean;
  latest: { executionId: string; completedAt: string; version: number } | null;
}

export function createReportDetail(deps: ReportDeps) {
  const facts: ReportFacts = createReportFacts({ db: deps.db, media: deps.media, mediaTtlSeconds: deps.mediaTtlSeconds, ...(deps.alert ? { alert: (e) => deps.alert!(e) } : {}) });
  const limits = deps.limits ?? DEFAULT_EXPORT_LIMITS;
  let activeExports = 0;

  /** 导航落地页：范围内可见的判定计划。越范围的计划不出现（不泄露存在性）；回收站里的活动计划不出现。 */
  async function overview(ctx: AuthContext): Promise<OverviewRow[]> {
    if (isEmptyScope(ctx.scope)) throw new ReportError("auth", "scope_empty", "当前账号没有可见的数据范围");
    if (!ctx.capabilities.has(CAP_READ)) throw new ReportError("auth", "capability_not_granted", "没有权限执行这个操作");
    const out: OverviewRow[] = [];
    for (const p of await deps.outcomes.plansOverview()) {
      const d = await deps.authorizer.authorize(ctx, { capability: CAP_READ, resource: { key: "report", ref: p.ref } });
      if (!d.ok) continue;
      out.push({
        planId: p.planId.toString(), alias: p.alias, activityPlanName: p.activityPlanName, platformCode: p.platform, archived: p.status === "archived",
        latest: p.latest ? { executionId: p.latest.executionId.toString(), completedAt: p.latest.completedAt.toISOString(), version: p.latest.version } : null,
      });
    }
    return out;
  }

  interface Opened {
    planId: bigint;
    ref: ReportRef;
    alias: string;
    activityPlanName: string;
    constraint: ResourceConstraint;
    execs: ExecutionDescriptor[];
  }
  /** 授权 + 取该判定计划的已完成执行。不存在 / 越范围 → not_found；没有已完成执行 → no_completed_execution。 */
  async function open(ctx: AuthContext, capability: string, planIdText: string): Promise<Opened> {
    const planId = dec(planIdText, "判定计划");
    if (planId === undefined) throw new ReportError("not_found", "plan_not_found", "找不到这个判定计划");
    let pr;
    try {
      pr = await deps.outcomes.planRefOf(planId);
    } catch (e) {
      return mapD(e);
    }
    const constraint = await authorizeReport(deps.authorizer, ctx, capability, pr.ref);
    const execs = await deps.outcomes.executionsOf(planId);
    return { planId, ref: pr.ref, alias: pr.alias, activityPlanName: pr.activityPlanName, constraint, execs };
  }
  function pick(o: Opened, executionId: string | undefined): ExecutionDescriptor {
    if (o.execs.length === 0) throw new ReportError("conflict", "no_completed_execution", "这个判定计划还没有完成的执行");
    if (executionId === undefined || executionId === "") return o.execs[0]!;
    const id = dec(executionId, "执行");
    const e = o.execs.find((x) => x.executionId === id);
    if (!e) throw new ReportError("not_found", "execution_not_found", "找不到这次执行");
    return e;
  }

  async function orgFilter(input: ReportFilterInput): Promise<OrgFilter> {
    const f: OrgFilter = {};
    const set = <K extends "regionId" | "branchId" | "sectorId" | "storeId">(k: K, v: bigint | undefined) => { if (v !== undefined) f[k] = v; };
    set("regionId", dec(input.regionId, "大区")); set("branchId", dec(input.branchId, "分公司")); set("sectorId", dec(input.sectorId, "板块")); set("storeId", dec(input.storeId, "门店"));
    const q = input.staffQuery?.trim();
    if (q) {
      if ([...q].length > 50) throw new ReportError("input", "invalid_filter", "搜索关键字过长");
      const ids = await facts.staffIdsByQuery(q, STAFF_QUERY_MAX);
      if (ids.length > STAFF_QUERY_MAX) throw new ReportError("input", "staff_query_too_broad", "匹配的专员太多，请缩小关键字");
      f.staffIds = ids;
    }
    return f;
  }

  async function headerOf(o: Opened, exec: ExecutionDescriptor, platformName: string, videosAvailable: boolean, abilityResultsAvailable: boolean): Promise<ReportHeader> {
    return {
      planId: o.planId.toString(), activityPlanName: o.activityPlanName, planAlias: o.alias, platformCode: exec.platform, platformName,
      version: exec.version, executionId: exec.executionId.toString(), completedAt: exec.completedAt.toISOString(), cutoffAt: exec.cutoffAt.toISOString(),
      window: { fromBjt: exec.window.from, toBjt: exec.window.to ?? "" }, videosAvailable, abilityResultsAvailable,
    };
  }

  /** 视频明细一页的行（页面与导出共用）。 */
  async function renderVideoRows(exec: ExecutionDescriptor, rows: ContentFact[], platformName: string, withImages: boolean): Promise<{ rows: ViewRow[]; missing: number }> {
    const snapIds = rows.map((r) => r.contentSnapshotId);
    const accountIds = rows.map((r) => r.accountId);
    const [snaps, profiles, homes, names, covers] = await Promise.all([
      facts.snapshots(snapIds), facts.profiles(accountIds, exec.cutoffAt), facts.homeUrls(accountIds),
      facts.orgNames({ brandIds: rows.map((r) => r.org.brandId), regionIds: rows.map((r) => r.org.regionId), branchIds: rows.map((r) => r.org.branchId), sectorIds: rows.map((r) => r.org.sectorId), dealerIds: rows.map((r) => r.org.dealerId), storeIds: rows.map((r) => r.org.storeId), staffIds: rows.map((r) => r.staffId) }),
      withImages ? facts.coverUrls(snapIds) : Promise.resolve(new Map<bigint, string>()),
    ]);
    const conds = exec.config.conditions.filter((c) => c.subject === "content");
    let missing = 0;
    const out = rows.map((r) => {
      const s = snaps.get(r.contentSnapshotId);
      const p = profiles.get(r.accountId);
      if (!s) missing++; // 读不到冻结的内容快照；互动值的缺失 / 空是值状态，不算「读不到」
      const cells: Record<string, Cell> = { ...orgCells(r.org, r.staffId, names, platformName), nickname: { text: p?.nickname ?? "", tone: "plain" }, homeUrl: linkCell(homes.get(r.accountId)) };
      Object.assign(cells, {
        kind: { text: s ? kindLabel(s.kind) : "", tone: "plain" }, title: { text: s?.title ?? "", tone: "plain" }, publishedAt: { text: fmtBjt(s?.publishedAt), tone: "plain" },
        url: linkCell(s?.shareUrl), contentId: { text: s?.platformContentId ?? "", tone: "plain" },
        like: s ? valueCell(s.like.state, s.like.value) : emptyCell(), comment: s ? valueCell(s.comment.state, s.comment.value) : emptyCell(),
        share: s ? valueCell(s.share.state, s.share.value) : emptyCell(), collect: s ? valueCell(s.collect.state, s.collect.value) : emptyCell(),
        snapshotAt: { text: fmtBjt(s?.snapshotAt), tone: "plain" },
      });
      for (const c of conds) cells[c.key] = contentCell(c, { final: r.final, stopLayer: r.stopLayer, reasonCode: r.reasonCode, evidence: r.evidence, comments: { total: r.comments.total, pass: r.comments.pass } });
      const cover = covers.get(r.contentSnapshotId);
      return { cells, images: cover ? { cover } : {} } satisfies ViewRow;
    });
    return { rows: out, missing };
  }

  async function renderAccountRows(exec: ExecutionDescriptor, rows: ParticipantFact[], platformName: string, withImages: boolean, abilityResultsAvailable: boolean): Promise<{ rows: ViewRow[]; missing: number }> {
    const accountIds = rows.map((r) => r.accountId);
    const [profiles, homes, syncs, counts, names] = await Promise.all([
      facts.profiles(accountIds, exec.cutoffAt), facts.homeUrls(accountIds), facts.syncStates(accountIds, exec.cutoffAt), facts.collectedCounts(accountIds, exec.cutoffAt),
      facts.orgNames({ brandIds: rows.map((r) => r.org.brandId), regionIds: rows.map((r) => r.org.regionId), branchIds: rows.map((r) => r.org.branchId), sectorIds: rows.map((r) => r.org.sectorId), dealerIds: rows.map((r) => r.org.dealerId), storeIds: rows.map((r) => r.org.storeId), staffIds: rows.map((r) => r.staffId) }),
    ]);
    const profIds = [...profiles.values()].map((p) => p.profileSnapshotId);
    const [avatars, backgrounds] = withImages ? await Promise.all([facts.avatarUrls(profIds), facts.backgroundUrls(profIds)]) : [new Map<bigint, string>(), new Map<bigint, string>()];
    let missing = 0;
    const out = rows.map((r) => {
      const p: ProfileFact | undefined = profiles.get(r.accountId);
      if (!p) missing++; // 数据截止时点前没有主页快照；粉丝数等值状态为空是正常的，不算「读不到」
      const sy = syncs.get(r.accountId);
      const cells: Record<string, Cell> = { ...orgCells(r.org, r.staffId, names, platformName), nickname: { text: p?.nickname ?? "", tone: "plain" }, homeUrl: linkCell(homes.get(r.accountId)) };
      Object.assign(cells, {
        followers: p ? valueCell(p.followers.state, p.followers.value) : emptyCell(), likesTotal: p ? valueCell(p.likes.state, p.likes.value) : emptyCell(), posts: p ? valueCell(p.posts.state, p.posts.value) : emptyCell(),
        collected: valueCell("value", BigInt(counts.get(r.accountId) ?? 0)),
        profileOk: syncOkCell(sy?.profile), profileAt: { text: fmtBjt(sy?.profile.at), tone: "plain" }, listOk: syncOkCell(sy?.list), listAt: { text: fmtBjt(sy?.list.at), tone: "plain" },
        result: resultCell(r.results.plan),
      });
      for (const c of exec.config.conditions) cells[c.key] = accountCell(c, abilityResultsAvailable ? r.abilityResults : null);
      const images = { ...(p && avatars.get(p.profileSnapshotId) ? { avatar: avatars.get(p.profileSnapshotId)! } : {}), ...(p && backgrounds.get(p.profileSnapshotId) ? { background: backgrounds.get(p.profileSnapshotId)! } : {}) };
      return { cells, images } satisfies ViewRow;
    });
    return { rows: out, missing };
  }

  function orgCells(org: ContentFact["org"], staffId: bigint, n: OrgNames, platformName: string): Record<string, Cell> {
    const t = (text: string | undefined): Cell => ({ text: text ?? "", tone: "plain" });
    const store = n.store.get(org.storeId);
    return { brand: t(n.brand.get(org.brandId)), region: t(n.region.get(org.regionId)), branch: t(n.branch.get(org.branchId)), sector: t(n.sector.get(org.sectorId)), dealer: t(n.dealer.get(org.dealerId)), store: t(store?.name), storeCode: t(store?.code), staff: t(n.staff.get(staffId)), platform: t(platformName) };
  }
  const linkCell = (raw: string | null | undefined): Cell => {
    const u = httpUrl(raw);
    return u ? { text: u, tone: "plain", link: u } : { text: "", tone: "plain" };
  };
  const syncOkCell = (s: SyncFact | undefined): Cell => ({ text: s?.ok ?? "无记录", tone: s?.ok === "否" ? "fail" : s?.ok === "无记录" ? "unobtained" : "plain" });

  /** 筛选下拉的选项：范围内、该执行的参与专员实际出现过的大区 / 分公司 / 板块 / 门店（不列没有参与者的组织）。 */
  async function filterOptions(exec: ExecutionDescriptor, constraint: ResourceConstraint): Promise<FilterOptions> {
    const seen = { region: new Set<bigint>(), branch: new Map<bigint, bigint>(), sector: new Set<bigint>(), store: new Map<bigint, { branch: bigint; sector: bigint }>(), regionOfBranch: new Map<bigint, bigint>() };
    for await (const p of deps.outcomes.streamParticipants(exec.executionId, constraint)) {
      seen.region.add(p.org.regionId); seen.branch.set(p.org.branchId, p.org.regionId); seen.sector.add(p.org.sectorId); seen.store.set(p.org.storeId, { branch: p.org.branchId, sector: p.org.sectorId });
    }
    const names = await facts.orgNames({ regionIds: [...seen.region], branchIds: [...seen.branch.keys()], sectorIds: [...seen.sector], storeIds: [...seen.store.keys()] });
    const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, "zh-CN");
    return {
      regions: [...seen.region].map((id) => ({ id: id.toString(), name: names.region.get(id) ?? id.toString() })).sort(byName),
      branches: [...seen.branch].map(([id, r]) => ({ id: id.toString(), name: names.branch.get(id) ?? id.toString(), regionId: r.toString() })).sort(byName),
      sectors: [...seen.sector].map((id) => ({ id: id.toString(), name: names.sector.get(id) ?? id.toString() })).sort(byName),
      stores: [...seen.store].map(([id, v]) => ({ id: id.toString(), name: names.store.get(id)?.name ?? id.toString(), branchId: v.branch.toString(), sectorId: v.sector.toString() })).sort(byName),
    };
  }

  /** 视频明细 / 账号维度的一页。 */
  async function view(ctx: AuthContext, planIdText: string, args: { tab: Tab; executionId?: string; filter: ReportFilterInput; page: number }): Promise<ReportView> {
    const o = await open(ctx, CAP_READ, planIdText);
    const exec = pick(o, args.executionId);
    const filter = await orgFilter(args.filter);
    const platformName = await facts.platformName(exec.platform);
    // 探测：内容级行是否已被保留期清理、账号能力结果是否可用（旧执行早于 JP-22）
    let videosTotal = 0;
    let videosAvailable = true;
    try {
      videosTotal = (await deps.outcomes.listContents(exec.executionId, o.constraint, {}, { offset: 0, limit: 0 })).total;
    } catch (e) {
      if (!prunedOf(e)) return mapD(e);
      videosAvailable = false;
    }
    const probe = await deps.outcomes.listParticipants(exec.executionId, o.constraint, {}, { offset: 0, limit: 1 });
    const abilityResultsAvailable = probe.rows.length === 0 ? true : probe.rows[0]!.abilityResults !== null;
    const columns = buildColumns(args.tab, exec.config.conditions, platformName);
    const page = Math.max(1, Math.floor(args.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    let table: TableView;
    if (args.tab === "videos") {
      if (!videosAvailable) table = { columns, rows: [], total: 0, page: 1, pageCount: 1, missingRows: 0 };
      else {
        const r = await deps.outcomes.listContents(exec.executionId, o.constraint, filter, { offset, limit: PAGE_SIZE });
        const rendered = await renderVideoRows(exec, r.rows, platformName, true);
        table = { columns, rows: rendered.rows, total: r.total, page, pageCount: Math.max(1, Math.ceil(r.total / PAGE_SIZE)), missingRows: rendered.missing };
      }
    } else {
      const r = await deps.outcomes.listParticipants(exec.executionId, o.constraint, filter, { offset, limit: PAGE_SIZE });
      const rendered = await renderAccountRows(exec, r.rows, platformName, true, abilityResultsAvailable);
      table = { columns, rows: rendered.rows, total: r.total, page, pageCount: Math.max(1, Math.ceil(r.total / PAGE_SIZE)), missingRows: rendered.missing };
    }
    return {
      header: await headerOf(o, exec, platformName, videosAvailable, abilityResultsAvailable),
      executions: o.execs.map((e, i) => ({ executionId: e.executionId.toString(), completedAt: e.completedAt.toISOString(), version: e.version, isLatest: i === 0 })),
      options: await filterOptions(exec, o.constraint), tab: args.tab, table, totals: { videos: videosTotal, accounts: probe.total },
    };
  }

  // ---- 导出 ---------------------------------------------------------------------------------------------------
  async function* videoRows(exec: ExecutionDescriptor, constraint: ResourceConstraint, filter: OrgFilter, platformName: string): AsyncGenerator<ViewRow> {
    let buf: ContentFact[] = [];
    const flush = async function* () {
      const { rows } = await renderVideoRows(exec, buf, platformName, false);
      buf = [];
      yield* rows;
    };
    for await (const r of deps.outcomes.streamContents(exec.executionId, constraint, filter)) {
      buf.push(r);
      if (buf.length >= BATCH) yield* flush();
    }
    if (buf.length) yield* flush();
  }
  async function* accountRows(exec: ExecutionDescriptor, constraint: ResourceConstraint, filter: OrgFilter, platformName: string, abilityResultsAvailable: boolean): AsyncGenerator<ViewRow> {
    let buf: ParticipantFact[] = [];
    const flush = async function* () {
      const { rows } = await renderAccountRows(exec, buf, platformName, false, abilityResultsAvailable);
      buf = [];
      yield* rows;
    };
    for await (const p of deps.outcomes.streamParticipants(exec.executionId, constraint, filter)) {
      buf.push(p);
      if (buf.length >= BATCH) yield* flush();
    }
    if (buf.length) yield* flush();
  }

  /**
   * 导出（两个 sheet，无图）。顺序：出口 4 守卫（含审计）→ 行数上限（超限一个字节都不生成）→ 并发上限 → 流式写出。
   * 视频明细在内容级行已被清理时不生成该 sheet（warnings 里带 videos_pruned）；账号能力结果不可用时账号能力列为空（abilities_unavailable）。
   */
  async function prepareExport(ctx: AuthContext, planIdText: string, args: { executionId?: string; filter: ReportFilterInput }) {
    const o = await open(ctx, CAP_EXPORT, planIdText);
    const exec = pick(o, args.executionId);
    const d = await deps.egress.guardExit(4, ctx, { capability: CAP_EXPORT, resource: { key: "report", ref: o.ref }, audit: { targetType: "judgement_plan", targetId: o.planId.toString(), detail: { executionId: exec.executionId.toString(), format: "xlsx" } } });
    if (!d.ok) throw d.kind === "not_found" ? new ReportError("not_found", "plan_not_found", "找不到这个判定计划") : new ReportError("auth", d.reason, "没有权限执行这个操作");
    const filter = await orgFilter(args.filter);
    const platformName = await facts.platformName(exec.platform);
    const warnings: string[] = [];
    let videos = 0;
    try {
      videos = (await deps.outcomes.listContents(exec.executionId, o.constraint, filter, { offset: 0, limit: 0 })).total;
    } catch (e) {
      if (!prunedOf(e)) return mapD(e);
      warnings.push("videos_pruned");
    }
    const probe = await deps.outcomes.listParticipants(exec.executionId, o.constraint, {}, { offset: 0, limit: 1 });
    const abilityResultsAvailable = probe.rows.length === 0 ? true : probe.rows[0]!.abilityResults !== null;
    if (!abilityResultsAvailable) warnings.push("abilities_unavailable");
    const accounts = (await deps.outcomes.listParticipants(exec.executionId, o.constraint, filter, { offset: 0, limit: 0 })).total;
    if (videos > limits.videoRows || accounts > limits.accountRows) throw new ReportError("conflict", "export_row_limit", "行数超过导出上限，请先用筛选缩小范围");
    const completedDate = fmtBjt(exec.completedAt).slice(0, 10);
    return { o, exec, filter, platformName, warnings, abilityResultsAvailable, videosPruned: warnings.includes("videos_pruned"), plan: { fileName: exportFileName(o.activityPlanName, o.alias, completedDate), warnings, videoRows: videos, accountRows: accounts } satisfies ExportPlan };
  }
  /**
   * 开始写出到 sink。并发上限在这里**同步**占位：满了立刻抛 export_busy（此时还没有写出任何字节，调用方可以回 429）；
   * 返回的 Promise 在写完（或失败）后释放占位。调用方先 prepareExport 拿文件名与警告头。
   */
  function startExport(prep: Awaited<ReturnType<typeof prepareExport>>, sink: import("node:stream").Writable): Promise<{ rowsBySheet: Record<string, number> }> {
    if (activeExports >= MAX_CONCURRENT_EXPORTS) throw new ReportError("conflict", "export_busy", "当前有较多导出正在进行，请稍后再试");
    activeExports++;
    return (async () => {
      try {
        const { exec, o, filter, platformName } = prep;
        const sheets = [
          ...(prep.videosPruned ? [] : [{ name: "视频明细", columns: buildColumns("videos", exec.config.conditions, platformName), rows: videoRows(exec, o.constraint, filter, platformName) }]),
          { name: "账号维度", columns: buildColumns("accounts", exec.config.conditions, platformName), rows: accountRows(exec, o.constraint, filter, platformName, prep.abilityResultsAvailable) },
        ];
        return await writeWorkbook(sink, sheets);
      } finally {
        activeExports--;
      }
    })();
  }
  const writeExport = async (prep: Awaited<ReturnType<typeof prepareExport>>, sink: import("node:stream").Writable) => startExport(prep, sink);
  /** 一步到位（CLI 与测试用）：prepare + write。 */
  async function exportWorkbook(ctx: AuthContext, planIdText: string, args: { executionId?: string; filter: ReportFilterInput }, sink: import("node:stream").Writable) {
    const prep = await prepareExport(ctx, planIdText, args);
    const r = await writeExport(prep, sink);
    return { ...prep.plan, ...r };
  }
  /** 页面「导出」弹窗的预览：文件名、行数、警告、两张表的表头（不写文件、不过出口）。 */
  async function exportPreview(ctx: AuthContext, planIdText: string, args: { executionId?: string; filter: ReportFilterInput }) {
    const o = await open(ctx, CAP_EXPORT, planIdText);
    const exec = pick(o, args.executionId);
    const filter = await orgFilter(args.filter);
    const platformName = await facts.platformName(exec.platform);
    const warnings: string[] = [];
    let videos = 0;
    try { videos = (await deps.outcomes.listContents(exec.executionId, o.constraint, filter, { offset: 0, limit: 0 })).total; } catch (e) { if (!prunedOf(e)) return mapD(e); warnings.push("videos_pruned"); }
    const probe = await deps.outcomes.listParticipants(exec.executionId, o.constraint, {}, { offset: 0, limit: 1 });
    if (probe.rows[0] && probe.rows[0].abilityResults === null) warnings.push("abilities_unavailable");
    const accounts = (await deps.outcomes.listParticipants(exec.executionId, o.constraint, filter, { offset: 0, limit: 0 })).total;
    return {
      fileName: exportFileName(o.activityPlanName, o.alias, fmtBjt(exec.completedAt).slice(0, 10)), warnings, videoRows: videos, accountRows: accounts,
      tooMany: videos > limits.videoRows || accounts > limits.accountRows, limits,
      videoColumns: warnings.includes("videos_pruned") ? [] : buildColumns("videos", exec.config.conditions, platformName), accountColumns: buildColumns("accounts", exec.config.conditions, platformName),
    };
  }
  return { overview, view, exportPreview, prepareExport, startExport, writeExport, exportWorkbook };
}
export type ReportDetail = ReturnType<typeof createReportDetail>;
export type { SnapshotFact };
