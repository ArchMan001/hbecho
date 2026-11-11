// 访问控制模块的唯一对外入口（design §9）。其他业务模块只能从这里导入；静态护栏 B-AX-14 强制。
// 例外：src/app（Next 入口）与 worker/access-* / worker/sms-smoke-*（本模块自己的进程入口）可以走内部路径。
export * from "./adapters";
export * from "./audit";
export * from "./audit-adapters";
export * from "./audit-read";
export * from "./authenticate";
export * from "./authorize";
export * from "./egress";
export * from "./errors";
export * from "./grants";
export * from "./linkage";
export * from "./maintenance";
export * from "./quality";
export * from "./roles";
export * from "./scope";
export * from "./services";
export * from "./service-principals";
export * from "./users";
