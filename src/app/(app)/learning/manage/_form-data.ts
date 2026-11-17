// 新建 / 编辑页共用的表单选项：品牌（标注哪些是自己授权的）、标签、上传上限。
import type { AuthContext } from "../../../../modules/access-control";
import { listTagTree } from "../../../../modules/learning";
import type { BrandOption } from "../../../_components/learning/course-form";
import type { TagCategoryOption } from "../../../_components/learning/tag-picker";
import { learning } from "../../../_lib/learning";
import { web } from "../../../_lib/session";

export async function formOptions(ctx: AuthContext): Promise<{ brands: BrandOption[]; categories: TagCategoryOption[]; limits: { docMaxBytes: number; coverMaxBytes: number; videoMaxBytes: number; videoMaxMinutes: number } }> {
  const deps = learning();
  const [org, tree] = await Promise.all([web().directory(), listTagTree(deps, ctx)]);
  const c = deps.config;
  return {
    brands: org.brands.map((b) => ({ id: b.id, name: b.name, allowed: ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id)) })),
    categories: tree.map((c) => ({ id: c.categoryId, name: c.name, tags: c.tags.map((t) => ({ id: t.tagId, name: t.name })) })),
    limits: { docMaxBytes: c.docMaxBytes, coverMaxBytes: c.coverMaxBytes, videoMaxBytes: c.videoMaxBytes, videoMaxMinutes: Math.round(c.videoMaxSeconds / 60) },
  };
}

export const RAIL = [
  { kicker: "发布", title: "保存即发布", text: "没有草稿与审核；品牌、人员级别、标签、封面与文件任一不满足就拒绝保存。" },
  { kicker: "替换", title: "直接覆盖", text: "替换文件不保留旧版本，学习进度不清零；若新视频更短，续播位置截断到新时长内。" },
  { kicker: "可见性", title: "品牌 × 人员级别", text: "全部品牌是动态语义：新品牌上线后自动可见。指定品牌不随品牌新增而扩展。" },
] as const;
