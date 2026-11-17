// 学习平台原型共享状态。只用于 ui-lab，不进生产构建。

export const state = {
  role: "platform_admin",
  demoState: "normal",
  demoOpen: false,
  courseQuery: "",
  courseTags: [],
  onlyInProgress: false,
  filtersOpen: false,
  manageFilter: { status: "all", kind: "all" },
  summaryBrand: "all",
  formKind: "video",
  formBrandScope: "specified",
  formBrands: ["日立"],
  formTags: [],
  formLevel: "all",
  formTitle: "",
  formDesc: "",
  formError: null,
  tagError: null,
};