// 浏览器端保存一份 CSV（模板 / 回流文件由服务端动作返回文本，不落服务器磁盘）。
export function saveCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text.startsWith("\uFEFF") ? text : `\uFEFF${text}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000); // 立刻回收会让部分浏览器取消下载
}
