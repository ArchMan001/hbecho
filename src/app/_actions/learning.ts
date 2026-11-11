"use server";
// 学习域的服务端动作：每个都先认证、再交给 Module（Capability、品牌范围、状态都在 Module 里判断，这里没有第二套）。
import {
  createDocumentCourse,
  createTag,
  createVideoCourse,
  deleteTag,
  downloadDocument,
  getPlayback,
  renameTag,
  replaceDocumentFile,
  replaceVideoFile,
  republishCourse,
  requestUpload,
  requestVideoUpload,
  unpublishCourse,
  updateCourse,
  type DownloadLink,
  type Playback,
  type UploadTicket,
  type VodUploadTicket,
} from "../../modules/learning";
import { run } from "../_lib/action";
import { learning } from "../_lib/learning";
import type { ActionResult } from "../_lib/result";

export async function requestUploadAction(slot: "doc" | "cover", mime: string, size: number): Promise<ActionResult<UploadTicket>> {
  return run((ctx) => requestUpload(learning(), ctx, { slot, mime, size }));
}
export async function requestVideoUploadAction(title: string, fileName: string, size: number): Promise<ActionResult<VodUploadTicket & { maxBytes: number }>> {
  return run((ctx) => requestVideoUpload(learning(), ctx, { title, fileName, size }));
}
export async function createDocumentAction(input: unknown): Promise<ActionResult<{ courseId: string }>> {
  return run((ctx) => createDocumentCourse(learning(), ctx, input));
}
export async function createVideoAction(input: unknown, idempotencyKey: string): Promise<ActionResult<{ courseId: string; replayed: boolean }>> {
  return run((ctx) => createVideoCourse(learning(), ctx, input, idempotencyKey));
}
export async function updateCourseAction(courseId: string, patch: unknown): Promise<ActionResult<{ changed: string[] }>> {
  return run((ctx) => updateCourse(learning(), ctx, courseId, patch));
}
export async function unpublishAction(courseId: string): Promise<ActionResult<{ changed: boolean }>> {
  return run((ctx) => unpublishCourse(learning(), ctx, courseId));
}
export async function republishAction(courseId: string): Promise<ActionResult<{ changed: boolean }>> {
  return run((ctx) => republishCourse(learning(), ctx, courseId));
}
export async function replaceDocumentAction(courseId: string, input: unknown): Promise<ActionResult<undefined>> {
  return run(async (ctx) => void (await replaceDocumentFile(learning(), ctx, courseId, input)));
}
export async function replaceVideoAction(courseId: string, input: unknown): Promise<ActionResult<undefined>> {
  return run(async (ctx) => void (await replaceVideoFile(learning(), ctx, courseId, input)));
}
export async function createTagAction(name: string): Promise<ActionResult<{ tagId: string; name: string }>> {
  return run((ctx) => createTag(learning(), ctx, name));
}
export async function renameTagAction(tagId: string, name: string): Promise<ActionResult<{ tagId: string; name: string }>> {
  return run((ctx) => renameTag(learning(), ctx, tagId, name));
}
export async function deleteTagAction(tagId: string): Promise<ActionResult<undefined>> {
  return run(async (ctx) => void (await deleteTag(learning(), ctx, tagId)));
}
/** 点击「开始学习」时才取播放凭证（不自动播放，G-D38）。 */
export async function getPlaybackAction(courseId: string): Promise<ActionResult<Playback>> {
  return run((ctx) => getPlayback(learning(), ctx, courseId));
}
/** 下载原件：签发短期附件链接并记下载审计。 */
export async function downloadAction(courseId: string): Promise<ActionResult<DownloadLink>> {
  return run((ctx) => downloadDocument(learning(), ctx, courseId));
}
