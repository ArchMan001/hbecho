// 经销商视频广场（F4 首个切片）：对外入口。页面与 CLI 只从这里导入。
export * from "./assemble";
export * from "./browse";
export type { SquareAlert, SquareDeps } from "./deps";
export * from "./errors";
export * from "./filter";
export { createSquareStrategy, listBrandPolicies, setBrandPolicy, visibleBrands, type BrandPolicyRow, type ViewMode, type VisibleBrands } from "./policy";
