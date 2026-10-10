/**
 * @file CI 冒烟测试（node scripts/ci-smoke.mjs，GitHub Actions 与本地通用）
 * @description 轻量冒烟：不调用任何外部付费 API（零 DashScope 调用），验证
 *              「服务起得来 + 登录/上传/校验/通知/页面」核心链路健康：
 *   ① 未登录：/api/me 401、/api/notifications 401
 *   ② 登录：dev 万能码流程
 *   ③ 魔数防御：伪造 mp4 内容分片上传 → complete 415
 *   ④ 轻接口：/api/styles 200、/dashboard 200、/dashboard/new 200（含多选文案）、
 *     /api/notifications 空列表结构、已读接口参数校验 400
 * 运行前提：server 已启动（:3000）、SMS_DEV_MODE=true、数据库已 migrate/seed。
 */
const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
/** 冒烟账号（任意 11 位手机号，dev 万能码） */
const PHONE = process.env.SMOKE_PHONE ?? "13900001111";
/** dev 万能验证码（须与 .env DEV_FIXED_CODE 一致） */
const DEV_CODE = process.env.SMOKE_DEV_CODE ?? "123456";

let failedCount = 0;
/** 断言（失败计数不中断） */
function check(name, cond, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failedCount++;
}

/* ---------- ① 未登录 ---------- */
console.log("[阶段①] 未登录访问…");
const anonMe = await fetch(`${BASE}/api/me`);
check("未登录 /api/me → 401", anonMe.status === 401, `HTTP ${anonMe.status}`);
const anonNotif = await fetch(`${BASE}/api/notifications`);
check("未登录 /api/notifications → 401", anonNotif.status === 401, `HTTP ${anonNotif.status}`);

/* ---------- ② 登录 ---------- */
console.log("[阶段②] 登录…");
let sms = await (await fetch(`${BASE}/api/auth/sms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE }),
})).json();
if (!sms.devCode) {
  // 60s 发码冷却（防刷限流是预期行为），等 65s 重试一次
  if (sms.error) {
    console.log("    发码冷却，等 65 秒重试…");
    await new Promise((r) => setTimeout(r, 65 * 1000));
    sms = await (await fetch(`${BASE}/api/auth/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    })).json();
  }
}
if (!sms.devCode) {
  console.error("发码失败：", sms);
  process.exit(1);
}
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, code: sms.devCode ?? DEV_CODE }),
});
check("登录成功", loginRes.ok, `HTTP ${loginRes.status}`);
const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
// /api/me 返回脱敏手机号（如 139****1111），用尾号校验
check("会话有效（/api/me 返回本人手机号尾号）", String(me.user?.phone ?? "").endsWith(PHONE.slice(-4)),
  JSON.stringify(me).slice(0, 120));

/* ---------- ③ 魔数防御（不触发任何转写调用） ---------- */
console.log("[阶段③] 魔数防御…");
const fake = Buffer.from("THIS_IS_NOT_A_VIDEO_XYZ");
const init = await (await fetch(`${BASE}/api/uploads/init`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ fileName: "fake-ci.mp4", contentType: "video/mp4", size: fake.length }),
})).json();
check("上传会话创建成功", !!init.uploadId, JSON.stringify(init).slice(0, 120));
if (init.uploadId) {
  // oss 模式分片直传 OSS 签名 URL（无需会话）；local 模式走 API 路由（需登录态）
  const put = await fetch(
    init.mode === "oss" ? init.partUrls[0] : `${BASE}/api/uploads/${init.uploadId}/chunks/0`,
    { method: "PUT", body: fake, headers: init.mode === "oss" ? {} : { Cookie: cookie } },
  );
  check("分片上传接受", put.ok, `HTTP ${put.status}`);
  const badComplete = await fetch(`${BASE}/api/uploads/${init.uploadId}/complete`, {
    method: "POST", headers: { Cookie: cookie },
  });
  check("伪造内容 complete 被拒（415）", badComplete.status === 415, `HTTP ${badComplete.status}`);
}

/* ---------- ④ 轻接口与页面 ---------- */
console.log("[阶段④] 轻接口与页面…");
const styles = await fetch(`${BASE}/api/styles`, { headers: { Cookie: cookie } });
check("/api/styles 200", styles.ok, `HTTP ${styles.status}`);
const dash = await fetch(`${BASE}/dashboard`, { headers: { Cookie: cookie } });
check("/dashboard 200", dash.ok, `HTTP ${dash.status}`);
const newPage = await fetch(`${BASE}/dashboard/new`, { headers: { Cookie: cookie } });
const newHtml = await newPage.text();
check("/dashboard/new 200 且含多选文案", newPage.ok && newHtml.includes("可多选"), `HTTP ${newPage.status}`);
const notif = await (await fetch(`${BASE}/api/notifications`, { headers: { Cookie: cookie } })).json();
check("通知接口返回结构（unread/items）", typeof notif.unread === "number" && Array.isArray(notif.items));
const badRead = await fetch(`${BASE}/api/notifications/read`, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}),
});
check("已读接口参数校验 → 400", badRead.status === 400, `HTTP ${badRead.status}`);
const loginPage = await fetch(`${BASE}/login`);
check("/login 200", loginPage.ok, `HTTP ${loginPage.status}`);

console.log(`\n===== 结果：${failedCount === 0 ? "全部通过 🎉 CI 冒烟完成" : `${failedCount} 项失败 ✗`} =====`);
process.exit(failedCount === 0 ? 0 : 1);
