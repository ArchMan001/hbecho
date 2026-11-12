// 判定提示词的版本标识（requirements SG-9）。1.0 的模板与输出 schema 由 C 保管，随代码版本化；模板正文在任务 9 加入。
// 提示词版本是判定参数指纹的一部分：改模板就升版本，旧版本的结果行保留。
export const JUDGE_PROMPT_ID = "asr-judge";
export const JUDGE_PROMPT_VERSION = 1;
