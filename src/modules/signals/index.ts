// signals 的对外入口。模块外只从这里导入。
export * from "./assemble";
export * from "./audit";
export * from "./authz";
export * from "./catalog";
export * from "./config";
export * from "./errors";
export type { CommentFact, ContentFact, Facts, Material, SubjectScope } from "./facts";
export * from "./scoring/ports";
export * from "./speech/ports";
