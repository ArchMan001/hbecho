"use server";
// 用户管理的服务端动作：参数校验 + 调用 UserAdmin。授权边界、读写同源、审计都在 Module 里。
import { AccessError } from "../../modules/access-control";
import { idOf, idsOf, isAccessError, run } from "../_lib/action";
import { web } from "../_lib/session";
import type { ActionResult } from "../_lib/result";

export interface InviteForm {
  name: string;
  role: string;
  phone: string;
  brandIds: string[];
  branchIds: string[];
  storeCode: string;
}
const str = (v: unknown, max: number): string => {
  if (typeof v !== "string" || v.length > max) throw new AccessError("input", "invalid_input", "输入内容不合法");
  return v;
};
const inviteInput = (f: InviteForm) => ({
  name: str(f.name, 100),
  role: str(f.role, 32),
  phone: str(f.phone, 32),
  brandIds: idsOf(f.brandIds, "品牌"),
  branchIds: idsOf(f.branchIds, "分公司"),
  ...(str(f.storeCode, 64).trim() ? { storeCode: f.storeCode.trim() } : {}),
});

export async function inviteUser(f: InviteForm): Promise<ActionResult<{ userId: string }>> {
  return run((ctx) => web().admin.invite(ctx, inviteInput(f)));
}

/** 创建前的核对：同一套校验，不写任何东西；门店专员会定位专员，并告知手机号是否已被占用。 */
export async function previewInvite(f: InviteForm): Promise<ActionResult<{ phoneExists: boolean; staffFound: boolean }>> {
  return run(async (ctx) => {
    const p = await web().admin.previewInvite(ctx, inviteInput(f));
    return { phoneExists: p.phoneExists, staffFound: p.mediaStaffId !== null };
  });
}

export interface ChangeForm {
  displayName?: string;
  role?: string;
  brandIds?: string[];
  branchIds?: string[];
  phone?: string;
}
export async function saveUser(userId: string, f: ChangeForm): Promise<ActionResult<{ userId: string }>> {
  return run((ctx) =>
    web().admin.changeAccess(ctx, idOf(userId, "用户"), {
      ...(f.displayName !== undefined ? { displayName: str(f.displayName, 100) } : {}),
      ...(f.role !== undefined ? { role: str(f.role, 32) } : {}),
      ...(f.brandIds !== undefined ? { brandIds: idsOf(f.brandIds, "品牌") } : {}),
      ...(f.branchIds !== undefined ? { branchIds: idsOf(f.branchIds, "分公司") } : {}),
      ...(f.phone !== undefined ? { phone: str(f.phone, 32) } : {}),
    }),
  );
}

export async function disableUser(userId: string): Promise<ActionResult<{ changed: boolean }>> {
  return run((ctx) => web().admin.disable(ctx, idOf(userId, "用户")));
}

export async function restoreUser(userId: string): Promise<ActionResult<{ removedBrands: number; removedBranches: number }>> {
  return run(async (ctx) => {
    const r = await web().admin.restore(ctx, idOf(userId, "用户"));
    return { removedBrands: r.removedBrandIds.length, removedBranches: r.removedBranchIds.length };
  });
}

export async function forceLogoutUser(userId: string): Promise<ActionResult<{ revoked: number }>> {
  return run((ctx) => web().admin.forceLogout(ctx, idOf(userId, "用户")));
}

/**
 * 批量停用待激活用户（B-D04，design §15.1）：逐个走与单个停用相同的 `disable`，各自授权、各自审计、各自一个事务。
 * 只处理仍是「待激活」的用户；越界或已变化的跳过并计数，不让整批失败。
 */
export async function disablePending(userIds: string[]): Promise<ActionResult<{ disabled: number; skipped: number }>> {
  return run(async (ctx) => {
    const ids = idsOf(userIds, "用户", 1000);
    const pending = new Set((await web().admin.list(ctx, { status: "pending_activation" })).filter((u) => u.manageable).map((u) => u.userId));
    let disabled = 0;
    let skipped = 0;
    for (const id of ids) {
      if (!pending.has(id.toString())) {
        skipped++;
        continue;
      }
      try {
        if ((await web().admin.disable(ctx, id)).changed) disabled++;
        else skipped++;
      } catch (e) {
        if (!isAccessError(e)) throw e;
        skipped++;
      }
    }
    return { disabled, skipped };
  });
}
