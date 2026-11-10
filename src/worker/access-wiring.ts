// `access` CLI 的依赖装配（access-main 与测试共用，所以测试证明的就是生产接线）。
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { branches, brands } from "../db/schema";
import {
  AccessError,
  createAuditReader,
  createAuditWriter,
  createAuthorizer,
  createBootstrap,
  createContextResolver,
  createOrgDirectory,
  createStaffLinkage,
  createUserAdmin,
  createUserImport,
  purgeOlderThan,
  userIdOf,
} from "../modules/access-control";
import type { AccessCliDeps } from "./access-cli";

export function buildAccessCliDeps(d: {
  db: Db;
  clock: { now(): Date };
  logger?: Logger;
  actorId: string | undefined;
  io: Pick<AccessCliDeps, "readFile" | "writeFile" | "stdout" | "stderr" | "onInternalError">;
}): AccessCliDeps {
  const { db, clock } = d;
  const audit = createAuditWriter({ db, clock, ...(d.logger ? { logger: d.logger } : {}) });
  const dir = createOrgDirectory(db);
  const linkage = createStaffLinkage({ db, clock, audit, dir, purgeAudit: () => purgeOlderThan(db, audit, clock), ...(d.logger ? { log: (e, m) => d.logger!.info(e, m) } : {}) });
  const authorizer = createAuthorizer();
  const admin = createUserAdmin({ db, clock, audit, dir, authorizer });
  const resolver = createContextResolver({ db, dir, linkage });
  return {
    admin,
    imp: createUserImport({ db, clock, audit, admin }),
    boot: createBootstrap({ db, clock, audit }),
    audit: createAuditReader({ db, authorizer }),
    maintain: linkage,
    actorId: d.actorId,
    async context(actorId) {
      const id = userIdOf(actorId);
      if (id === null) throw new AccessError("configuration", "actor_invalid", "HBECHO_ACCESS_ACTOR 必须是 user:<数字 ID>（CLI 以真实用户的身份操作，服务身份不能管理用户）");
      const r = await resolver.contextForUser(id, null);
      if (!r.ok) throw new AccessError("authorization", "actor_not_active", `HBECHO_ACCESS_ACTOR 对应的用户不是有效用户（${r.reason}）`);
      return r.ctx;
    },
    async refs() {
      const [b, br] = await Promise.all([db.select({ id: brands.brandId, code: brands.brandCode }).from(brands), db.select({ id: branches.branchId, code: branches.branchCode }).from(branches)]);
      return { brandIds: new Map(b.map((x) => [x.code, x.id])), branchIds: new Map(br.map((x) => [x.code, x.id])) };
    },
    ...d.io,
  };
}
