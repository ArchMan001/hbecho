// 下游端口（design §10.4）：D / E 未建，默认空实现。计划删除 / 恢复 / 清除的调用时机现在就固定。
// 契约：onDeleted / onRestored / purge 必须幂等；purge 在数据库事务之外调用，失败时本模块不清除计划（下次维护重试）；
// onDeleted / onRestored 只是加速通知，D / E 以 activity_plans.status 为准对账。
export interface PlanDownstream {
  summarize(planId: bigint): Promise<{ judgementPlans: number; results: number; running: number }>;
  onDeleted(planId: bigint): Promise<void>;
  onRestored(planId: bigint): Promise<void>;
  purge(planId: bigint): Promise<void>;
}
export const noDownstream: PlanDownstream = {
  summarize: async () => ({ judgementPlans: 0, results: 0, running: 0 }),
  onDeleted: async () => {},
  onRestored: async () => {},
  purge: async () => {},
};
