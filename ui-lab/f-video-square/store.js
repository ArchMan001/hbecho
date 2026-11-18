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
  // 经销商视频广场（f-video-square）：筛选默认值见 design §N.2
  sq: { brand: "all", platform: "all", kind: "video", plan: "all", branch: "all", time: "all", like: "all", q: "", page: 1, planLive: false, aiTab: "analyze" },
};
export const SQ_DEFAULT = { brand: "all", platform: "all", kind: "video", plan: "all", branch: "all", time: "all", like: "all", q: "", page: 1 };

export function resetDemoState() {
  state.demoState = "normal";
}