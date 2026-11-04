// v2 §5.1 的列类型约定。内部 ID 是 signed BIGINT（TS 用 bigint，API 输出十进制字符串）；
// 时间是 UTC DATETIME(6)；SHA-256 是 BINARY(32)；状态是 VARCHAR + CHECK，不用 ENUM。
import { sql, type SQL } from "drizzle-orm";
import { bigint, customType, datetime, type AnyMySqlColumn } from "drizzle-orm/mysql-core";

export const id = (name: string) => bigint(name, { mode: "bigint" });
export const counter = (name: string) => bigint(name, { mode: "number" });
export const utc = (name: string) => datetime(name, { mode: "date", fsp: 6 });

/** SHA-256，BINARY(32)。 */
export const sha256 = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "binary(32)",
});

/** 外部 ID、业务编码等需要按字节精确比较的文本：utf8mb4_bin。 */
export const binText = customType<{ data: string; driverData: string; config: { length: number } }>({
  dataType: (config) => `varchar(${config?.length ?? 255}) character set utf8mb4 collate utf8mb4_bin`,
});

/**
 * 对象 key 等纯 ASCII 文本：ascii_bin。
 * 为什么不用 utf8mb4：oss_objects 的唯一键 (provider_code, region, bucket, object_key, object_version)
 * 合计 1887 个字符，按 utf8mb4 是 7548 字节，超过 InnoDB 索引 3072 字节上限（MySQL 8.4 实测报 1071）；
 * ASCII 是 1887 字节。对象 key 与版本由我们生成，约束为 ASCII。
 */
export const asciiBin = customType<{ data: string; driverData: string; config: { length: number } }>({
  dataType: (config) => `varchar(${config?.length ?? 255}) character set ascii collate ascii_bin`,
});

/** v2 §5.2 值状态检查：value 状态必须非负且非空；其余四态 value 必须为空。 */
export function valueStateCheck(value: AnyMySqlColumn, state: AnyMySqlColumn): SQL {
  return sql`(${state} = 'value' AND ${value} IS NOT NULL AND ${value} >= 0) OR (${state} IN ('missing','explicit_null','invalid','unsupported') AND ${value} IS NULL)`;
}

export const inList = (col: AnyMySqlColumn, values: readonly string[]): SQL =>
  sql`${col} IN (${sql.join(
    values.map((v) => sql.raw(`'${v}'`)),
    sql.raw(","),
  )})`;
