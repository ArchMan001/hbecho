// 服务端动作的统一返回：成功带数据，失败带人话与稳定错误码（ui-foundation §5「错误」）。
// 这个文件不是 "use server"，服务端动作文件与客户端组件都可以导入它。
export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; code: string; message: string; hint?: string };

/** 把 BIGINT 之类不能直接序列化给客户端的值留在服务端；传给客户端的只有字符串、数字与数组。 */
export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
export const fail = (code: string, message: string, hint?: string): ActionResult<never> => ({ ok: false, code, message, ...(hint ? { hint } : {}) });
