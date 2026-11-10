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
  userImportStep: 1,
  userImportUploaded: false,
  batchView: "rows",
  loginAs: "platform_admin",
};

export function resetDemoState() {
  state.demoState = "normal";
}