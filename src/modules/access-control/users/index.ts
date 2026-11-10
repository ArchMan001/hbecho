// users/ 的对外出口。access-control/index.ts（任务 11）是模块唯一对外入口，再从这里取。
export { createUserAdmin, type ChangeInput, type InviteInput, type UserAdmin, type UserAdminDeps, type UserView } from "./admin";
export { BOOTSTRAP_ACTOR, createBootstrap, type Bootstrap } from "./bootstrap";
