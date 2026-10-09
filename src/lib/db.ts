/**
 * @file Prisma Client 单例模块
 * @description 全局共享一个 PrismaClient 实例，避免开发模式下热重载创建过多数据库连接。
 *              Next.js 开发环境会在 globalThis 上缓存实例；生产环境直接新建。
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** 全局唯一的 Prisma 数据库客户端实例 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
