// 运营命令共用的授权判断（design §9、FS-20.1）。1.0 的调用方只有服务身份；B 域接入后只替换 ActorContext 的来源。
// 范围里没有「品牌集合」：影响面超出单个账号的命令一律要求全范围身份（宁可拒绝，B 域接入后再细化）。
import { CAP_SYNC_TRIGGER, type ActorContext } from "../tracer-command";
import { SyncError } from "./errors";

export function requireCap(actor: ActorContext, cap: string = CAP_SYNC_TRIGGER): void {
  if (!actor.capabilities.has(cap)) throw new SyncError("forbidden", `缺少 Capability ${cap}`);
}
export function requireFullScope(actor: ActorContext, what = "取消批次"): void {
  if (actor.scope.platformCodes !== "all" || actor.scope.mediaStaffIds !== "all") {
    throw new SyncError("out_of_scope", `${what}需要全平台、全专员范围的服务身份（1.0 不支持按范围部分执行）`);
  }
}
export function requirePlatformAdmin(actor: ActorContext, what: string): void {
  if (actor.platformAdmin !== true) throw new SyncError("forbidden", `${what}只允许超管`);
}
export const inPlatformScope = (actor: ActorContext, code: string): boolean => actor.scope.platformCodes === "all" || actor.scope.platformCodes.has(code);
export const inStaffScope = (actor: ActorContext, staffId: bigint | null): boolean =>
  staffId === null ? actor.scope.mediaStaffIds === "all" : actor.scope.mediaStaffIds === "all" || actor.scope.mediaStaffIds.has(staffId);
