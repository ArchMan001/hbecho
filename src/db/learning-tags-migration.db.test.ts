// 0013 迁移的回填（g-learning-tags-v2）：把旧的扁平标签「平台-抖音」拆成一级 + 二级，保留 tag_id 与课程引用。
// 做法：把已迁移好的测试库退回 0013 之前的形状，插入旧数据，再原样执行迁移文件，核对结果。迁移文件最后会把库恢复成最新结构。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../tests/harness/db";
import { learningEnv } from "../../tests/harness/learning";
const t = useTestDb();

describe("0013_learning_tag_categories", () => {
  it("按第一个 '-' 拆分，无前缀归「未分类」，保留 tag_id 和课程引用", async () => {
    const e = await learningEnv(t);
    const sql = readFileSync(join(__dirname, "../../drizzle/0013_learning_tag_categories.sql"), "utf8");
    const q = async (text: string) => t.pool.query(text);
    await q("ALTER TABLE tags DROP FOREIGN KEY fk_tags_category");
    await q("ALTER TABLE tags DROP INDEX uq_tags_category_name");
    await q("ALTER TABLE tags DROP COLUMN category_id");
    await q("DROP TABLE tag_categories");

    const old = ["平台-抖音", "平台-小红书", "板块-水机", " 平台 - 视频号 ", "A-B-C", "无前缀", "-开头", "尾部-"];
    const idOf = new Map<string, bigint>();
    for (const name of old) {
      const [r] = await t.pool.query<RowDataPacket[]>("INSERT INTO tags (name, created_at) VALUES (?, UTC_TIMESTAMP(6))", [name]);
      idOf.set(name, BigInt((r as unknown as { insertId: number }).insertId));
    }
    const courseId = await e.insertCourse({ tagIds: [idOf.get("平台-抖音")!, idOf.get("无前缀")!] });

    for (const stmt of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await q(stmt);

    const [rows] = await t.pool.query<RowDataPacket[]>("SELECT t.tag_id AS id, c.name AS category, t.name AS name FROM tags t JOIN tag_categories c ON c.category_id = t.category_id ORDER BY t.tag_id");
    const got = new Map(rows.map((r) => [BigInt(r.id as number | string), `${r.category as string}/${r.name as string}`]));
    expect(got.get(idOf.get("平台-抖音")!)).toBe("平台/抖音");
    expect(got.get(idOf.get("平台-小红书")!)).toBe("平台/小红书");
    expect(got.get(idOf.get("板块-水机")!)).toBe("板块/水机");
    expect(got.get(idOf.get(" 平台 - 视频号 ")!)).toBe("平台/视频号"); // 前后空白去掉
    expect(got.get(idOf.get("A-B-C")!)).toBe("A/B-C"); // 只拆第一个 '-'
    expect(got.get(idOf.get("无前缀")!)).toBe("未分类/无前缀");
    expect(got.get(idOf.get("-开头")!)).toBe("未分类/-开头"); // 前缀为空：不拆
    expect(got.get(idOf.get("尾部-")!)).toBe("未分类/尾部-"); // 后缀为空：不拆

    const [cats] = await t.pool.query<RowDataPacket[]>("SELECT name FROM tag_categories ORDER BY category_id");
    expect(cats.map((c) => c.name)).toEqual(["平台", "板块", "A", "未分类"]); // 按首个标签的创建顺序
    const [refs] = await t.pool.query<RowDataPacket[]>("SELECT tag_id AS id FROM course_tags WHERE course_id = ? ORDER BY tag_id", [courseId]);
    expect(refs.map((r) => BigInt(r.id as number | string))).toEqual([idOf.get("平台-抖音")!, idOf.get("无前缀")!]); // 引用不变
    // 结构已恢复：category_id 非空且有外键
    const [col] = await t.pool.query<RowDataPacket[]>("SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tags' AND column_name = 'category_id'");
    expect(col[0]!.n).toBe("NO");
  });

  it("没有旧标签时不凭空造「未分类」", async () => {
    await learningEnv(t);
    const sql = readFileSync(join(__dirname, "../../drizzle/0013_learning_tag_categories.sql"), "utf8");
    await t.pool.query("ALTER TABLE tags DROP FOREIGN KEY fk_tags_category");
    await t.pool.query("ALTER TABLE tags DROP INDEX uq_tags_category_name");
    await t.pool.query("ALTER TABLE tags DROP COLUMN category_id");
    await t.pool.query("DROP TABLE tag_categories");
    for (const stmt of sql.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await t.pool.query(stmt);
    const [cats] = await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM tag_categories");
    expect(Number(cats[0]!.n)).toBe(0);
  });
});
