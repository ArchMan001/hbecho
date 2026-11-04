import { describe, expect, it } from "vitest";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { peekResponseMeta } from "./peek";

describe("peekResponseMeta：捕获后、解析前的调用元数据提取（不是业务解释）", () => {
  it("成功信封：action、任务状态、供应商 task/request ID", () => {
    expect(peekResponseMeta(loadFixtureBytes("raw3.douyin.media_user_info"))).toEqual({
      parseable: true,
      topLevelCode: "0",
      action: "media_user_info",
      taskStatus: "succeeded",
      providerTaskId: "6a954bef25f71e00016485f6",
      providerRequestId: "6a954bef25f71e00016485f6",
      errorCode: null,
      resultIsNull: false,
    });
  });

  it("HTTP 400 的错误体：顶层字符串 code 与 request_id（raw7 C19 实测）", () => {
    expect(peekResponseMeta(loadFixtureBytes("raw7.C19.http400"))).toMatchObject({
      parseable: true,
      errorCode: "INVALID_REQUEST",
      providerRequestId: "req_ec5b7f7ecf3844a6b38b68aee7912f5a",
      action: null,
      taskStatus: null,
    });
  });

  it("HTTP 500 RESULT_VALIDATION_FAILED（raw7 C20 无效链接实测）", () => {
    expect(peekResponseMeta(loadFixtureBytes("raw7.C20.http500"))).toMatchObject({ errorCode: "RESULT_VALIDATION_FAILED" });
  });

  it("异步轮询里任务失败：HTTP 200 + data.status=failed + data.error.code（raw4 C10 实测）", () => {
    expect(peekResponseMeta(loadFixtureBytes("raw4.C10.poll1"))).toMatchObject({
      action: "user_video_list",
      taskStatus: "failed",
      errorCode: "RESULT_VALIDATION_FAILED",
    });
  });

  it("成功但 result 为 null / 缺失 → resultIsNull（间歇性 result:null）；运行中不算", () => {
    const nul = bytesOf('{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"succeeded","result":null}}');
    const missing = bytesOf('{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"succeeded"}}');
    const running = bytesOf('{"code":0,"data":{"task_id":"t","action":"media_user_info","status":"running","result":null}}');
    expect(peekResponseMeta(nul).resultIsNull).toBe(true);
    expect(peekResponseMeta(missing).resultIsNull).toBe(true);
    expect(peekResponseMeta(running).resultIsNull).toBe(false);
  });

  it("不可解析：非 JSON、非法 UTF-8、数组、标量 → parseable=false，其余全 null，不抛异常", () => {
    for (const bytes of [bytesOf("<html>"), new Uint8Array([0xff, 0xfe]), bytesOf("[]"), bytesOf("3"), bytesOf("")]) {
      expect(peekResponseMeta(bytes)).toEqual({
        parseable: false,
        topLevelCode: null,
        action: null,
        taskStatus: null,
        providerTaskId: null,
        providerRequestId: null,
        errorCode: null,
        resultIsNull: false,
      });
    }
  });

  it("元数据字段被限长并只接受字符串，避免把任意载荷搬进调用表", () => {
    const long = "x".repeat(2000);
    const m = peekResponseMeta(bytesOf(`{"code":"${long}","request_id":"${long}","data":{"task_id":${"1".repeat(30)},"action":"${long}","status":"ok"}}`));
    expect(m.errorCode!.length).toBeLessThanOrEqual(128);
    expect(m.providerRequestId!.length).toBeLessThanOrEqual(512);
    expect(m.action!.length).toBeLessThanOrEqual(64);
    expect(m.providerTaskId).toBe("1".repeat(30)); // 数字型 task_id 也按原文保留
  });
});
