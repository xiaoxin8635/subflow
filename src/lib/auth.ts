/**
 * @file 会话认证工具
 * @description 基于「随机 token + 数据库会话记录 + httpOnly Cookie」的认证方案：
 *   - 登录成功后生成 256 位随机 token，数据库只存其 SHA-256 哈希（防拖库撞库）
 *   - Cookie 设置 httpOnly + SameSite=Lax，生产环境自动开启 secure
 *   - 会话有效期 30 天，登出即删除记录，可服务端随时吊销
 */
import { createHash, randomBytes } from "crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "./db";
import type { User } from "@prisma/client";

/** 会话 Cookie 名称 */
const SESSION_COOKIE = "subflow_session";

/** 会话有效期（天） */
const SESSION_TTL_DAYS = 30;

/**
 * 计算 SHA-256 十六进制哈希
 * @param input 原始字符串
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 为指定用户创建新会话并写入 Cookie（仅在 Route Handler / Server Action 中可调用）
 * @param userId 用户 ID
 */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.session.create({
    data: { userId, tokenHash: sha256(token), expiresAt },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

/**
 * 获取当前登录用户（含剩余额度）；未登录或会话过期返回 null
 * 供服务端组件与 API 路由共同使用。
 * 用 React cache 包裹：同一次 RSC 请求内（layout + 页面各调一次）只查一次库
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  return session.user;
});

/**
 * 销毁当前会话（删除数据库记录并清除 Cookie）
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * 手机号脱敏展示：138****1234
 * @param phone 11 位手机号
 */
export function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}
