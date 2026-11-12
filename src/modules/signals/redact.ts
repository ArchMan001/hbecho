// 写入任务错误详情、结果证据、审计事件之前统一脱敏：URL 一律替换为 <url>（Python 的错误消息可能带签名 URL，SG-14）。
export const redactUrls = (text: string): string => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "<url>");
