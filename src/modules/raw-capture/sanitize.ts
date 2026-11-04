// 传输错误消息进入 ODS artifact 与调用元数据之前先去掉凭证：认证头、Cookie、Bearer、形似密钥的 token。
const HEADER = /\b(x-api-key|authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*[^,;\n]*/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEYLIKE = /\b(sk|ak|LTAI)[-_]?[A-Za-z0-9_-]{8,}/g;

export function sanitizeMessage(message: string, max = 500): string {
  return message.replace(HEADER, "[redacted]").replace(BEARER, "[redacted]").replace(KEYLIKE, "[redacted]").slice(0, max);
}
