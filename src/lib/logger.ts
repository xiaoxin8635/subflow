/**
 * @file 结构化日志（P1.6 可观测性）
 * @description 全部关键路径日志输出为单行 JSON（时间/级别/模块/消息/上下文），
 *              便于 docker logs 采集与后续接日志平台。Error 对象自动展开为
 *              message + stack。级别映射：info→console.log、warn→console.warn、
 *              error→console.error。
 */

/** 日志级别 */
type LogLevel = "info" | "warn" | "error";

/** 附加上下文（扁平键值对；Error 自动序列化） */
export type LogMeta = Record<string, unknown>;

/**
 * 将 meta 中的值归一化为可 JSON 序列化形式（Error → message/stack）
 * @param value 原始值
 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * 输出一行结构化 JSON 日志
 * @param level  级别
 * @param module 模块名（如 "worker"、"export"、"alert"）
 * @param msg    消息（中文，面向运维阅读）
 * @param meta   附加上下文
 */
function emit(level: LogLevel, module: string, msg: string, meta?: LogMeta): void {
  const entry: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    module,
    msg,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) entry[k] = normalizeValue(v);
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** 结构化日志门面 */
export const logger = {
  /**
   * 记录 info 级别日志
   * @param module 模块名
   * @param msg    消息
   * @param meta   附加上下文
   */
  info(module: string, msg: string, meta?: LogMeta): void {
    emit("info", module, msg, meta);
  },
  /**
   * 记录 warn 级别日志
   * @param module 模块名
   * @param msg    消息
   * @param meta   附加上下文
   */
  warn(module: string, msg: string, meta?: LogMeta): void {
    emit("warn", module, msg, meta);
  },
  /**
   * 记录 error 级别日志
   * @param module 模块名
   * @param msg    消息
   * @param meta   附加上下文
   */
  error(module: string, msg: string, meta?: LogMeta): void {
    emit("error", module, msg, meta);
  },
};
