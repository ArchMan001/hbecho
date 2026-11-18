// ICP 备案号（运维手册 §10.6 第 5 条）：对外开放的站点必须把备案号挂在页脚并链接到工信部，管局会复查。
// 备案号来自运行环境（HBECHO_ICP_NUMBER），本地与 CI 不设置时不显示。
export function IcpFooter({ light = false }: { light?: boolean }) {
  const icp = process.env.HBECHO_ICP_NUMBER?.trim();
  if (!icp) return null;
  return (
    <p className={light ? "auth-footer-note" : "site-foot"}>
      <a href="https://beian.miit.gov.cn" target="_blank" rel="noreferrer noopener" style={light ? { color: "rgba(255,255,255,.82)" } : undefined}>
        {icp}
      </a>
    </p>
  );
}

/** 版本标识：显示「这一页跑的是哪一版代码」。预览（4400）显示工作树提交号，ECS 显示镜像标签对应的提交号，两边一眼能核对是否同一版。 */
export function BuildStamp() {
  const build = process.env.HBECHO_BUILD_SHA?.trim();
  if (!build) return null;
  return (
    <p className="site-foot" title="页面代码对应的提交号；与 /api/health 返回的 build 相同">
      版本 {build}
    </p>
  );
}
