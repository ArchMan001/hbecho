// 阿里云短信发送器（design §7.8，ADR-0005 `@alicloud/*` 范围）。
// 采用：@alicloud/dysmsapi20170525 4.6.0（官方 SDK，Apache-2.0；官方云服务 SDK 不受星标限制）
// 用途：调用 SendSms，把验证码交给阿里云。
// 不用它做什么：不做限频、不做资格校验、不记录结果、不决定用哪个模板——这些都在 SmsService；本文件只负责「一次调用」。
//
// 真实发送**不属于自动验收**（AX-13）：需要人工批准、显式开关、固定条数与审计摘要。默认测试只用注入的假客户端；
// 签名与模板已申请（2026-11-06），名称与编码待提供，在拿到之前生产不得把 HBECHO_SMS_MODE 设为 aliyun。
import type { SmsKind, SmsMessage, SmsSender } from "./sms";

/** SDK 调用的最小端口：测试注入假实现。 */
export interface AliyunSmsClient {
  sendSms(req: { phoneNumbers: string; signName: string; templateCode: string; templateParam: string }): Promise<{ body?: { code?: string; message?: string; bizId?: string } }>;
}

export interface AliyunSmsSenderConfig {
  signName: string;
  /** 每种用途一个模板；模板正文由业务在阿里云控制台维护，变量名固定为 code。 */
  templates: Readonly<Record<SmsKind, string>>;
}

/**
 * 这些错误码说明是**运维问题，不是某个用户的问题**：整个平台都会发不出短信，应该告警（参考 hbdam 的同名清单）。
 * 其余错误（号码非法、被运营商拦截……）多半只影响单个用户。
 */
export const OPERATIONAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "isv.AMOUNT_NOT_ENOUGH", // 余额不足：全平台停摆，最该报警的一个
  "isv.OUT_OF_SERVICE", // 服务停用（通常是投诉率超标导致签名被停）
  "isv.SMS_SIGNATURE_ILLEGAL", // 签名不可用
  "isv.SMS_TEMPLATE_ILLEGAL", // 模板不可用
  "isv.DAY_LIMIT_CONTROL", // 触达阿里云侧的日发送上限
  "isv.BUSINESS_LIMIT_CONTROL", // 触达阿里云侧的频控
]);

/** 发送失败。message 不含手机号与验证码（会进日志）。 */
export class AliyunSmsError extends Error {
  constructor(
    readonly providerCode: string,
    /** true = 运维问题（余额 / 签名 / 模板 / 日限额），不是某个用户的问题。 */
    readonly operational: boolean = OPERATIONAL_ERROR_CODES.has(providerCode),
  ) {
    super(`阿里云短信发送失败：${providerCode}`);
    this.name = "AliyunSmsError";
  }
}

export class AliyunSmsSender implements SmsSender {
  constructor(
    private readonly client: AliyunSmsClient,
    private readonly cfg: AliyunSmsSenderConfig,
  ) {}

  async send(msg: SmsMessage): Promise<{ providerRef?: string }> {
    const res = await this.client.sendSms({
      phoneNumbers: msg.phone,
      signName: this.cfg.signName,
      templateCode: this.cfg.templates[msg.kind],
      templateParam: JSON.stringify({ code: msg.code }),
    });
    const code = res.body?.code ?? "NO_RESPONSE";
    if (code !== "OK") throw new AliyunSmsError(code);
    return res.body?.bizId ? { providerRef: res.body.bizId } : {};
  }
}

export interface AliyunCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint?: string;
}

/** 构造真实 SDK 客户端；动态导入，默认测试与不使用阿里云的进程不加载 SDK。 */
export async function createAliyunSmsClient(cred: AliyunCredentials): Promise<AliyunSmsClient> {
  const { default: Dysmsapi, SendSmsRequest } = await import("@alicloud/dysmsapi20170525");
  // SDK 构造函数只读取这几个普通属性（openapi-core client.js），类型上要求 Config 实例，在这一处收口
  const sdk = new Dysmsapi({ accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret, endpoint: cred.endpoint ?? "dysmsapi.aliyuncs.com" } as never);
  return {
    sendSms: async (r) => {
      const out = await sdk.sendSms(new SendSmsRequest({ phoneNumbers: r.phoneNumbers, signName: r.signName, templateCode: r.templateCode, templateParam: r.templateParam }));
      return { body: { ...(out.body?.code ? { code: out.body.code } : {}), ...(out.body?.message ? { message: out.body.message } : {}), ...(out.body?.bizId ? { bizId: out.body.bizId } : {}) } };
    },
  };
}
