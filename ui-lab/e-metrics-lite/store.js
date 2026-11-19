// 原型共享状态。只用于 ui-lab，不进生产构建。

export const state = {
  role: "platform_admin",
  demoState: "normal",
  demoOpen: false,
  planTab: "basic",
  planFilter: { brand: "all", platform: "all", status: "all" },
  accountFilter: { status: "all", platform: "all" },
  userFilter: { role: "all", status: "all" },
  auditFilter: { event: "all", range: "all" },
  filtersOpen: false,
  loginMode: "code",
  authError: null,
  authNotice: null,
  selectedAccount: null,
  selectedAccountId: "a1",
  importStep: 3,
  importUploaded: false,
  mdStep: 1,
  mdMode: "import",
  mdUploaded: false,
  mdClose: [],
  mdBrowse: { view: "stores", brand: [], region: [], branch: [], sector: [], tier: [], status: [], kw: "", page: 1, size: 20 },
  openPanel: null,
  userImportStep: 1,
  userImportUploaded: false,
  batchView: "rows",
  loginAs: "platform_admin",
  // 全量明细（e-metrics-lite）：筛选与标签；big = 原型里模拟「导出行数超限」
  el: { tab: "videos", region: "all", branch: "all", sector: "all", store: "all", q: "", page: 1, big: false, planKey: "" },
};
export const EL_DEFAULT = { region: "all", branch: "all", sector: "all", store: "all", q: "", page: 1 };

export function resetDemoState() {
  state.demoState = "normal";
}