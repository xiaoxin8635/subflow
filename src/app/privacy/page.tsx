/**
 * @file 隐私政策页面
 * @description 说明 SubFlow 收集、使用、存储用户数据的方式与用户权利。
 *              纯静态页面（不读 cookies/db），可预渲染。
 *              注意：条款中的主体信息、联系方式、备案号需在正式上线前替换为真实信息。
 */

import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

/** 政策更新日期（静态常量：Cache Components 模式禁止预渲染期调用 new Date()） */
const LAST_UPDATED = "2026年10月10日";

/** 单个条款区块 */
function Clause({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-neutral-600">{children}</div>
    </section>
  );
}

/** 隐私政策页面 */
export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <h1 className="text-2xl font-bold">隐私政策</h1>
        <p className="mt-2 text-sm text-neutral-400">更新日期：{LAST_UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          SubFlow 字幕工坊（以下简称&ldquo;本服务&rdquo;）非常重视你的个人信息与隐私保护。本政策说明我们如何收集、使用、存储和保护你的信息，以及你享有的相关权利。请在使用本服务前仔细阅读本政策。
        </p>

        <Clause title="一、我们收集的信息">
          <p>1. <b>账号信息</b>：注册登录时收集的手机号码，用于身份识别、登录验证与安全防护。</p>
          <p>2. <b>视频内容</b>：你上传的视频文件，仅用于为你生成字幕。</p>
          <p>3. <b>转写与润色文本</b>：视频经语音识别生成的字幕文本及 AI 润色结果，用于编辑器展示与导出。</p>
          <p>4. <b>使用记录</b>：额度消耗、兑换记录、导出记录，用于额度管理与账务核对。</p>
        </Clause>

        <Clause title="二、信息的使用">
          <p>1. 上传的视频仅用于语音识别与字幕生成，不用于模型训练，不向任何第三方出售。</p>
          <p>2. 视频音频会调用阿里云百炼（语音识别）与通义千问（文本润色）接口处理，上述处理仅为完成你请求的字幕生成功能。</p>
          <p>3. 我们不会将你的手机号用于与本服务无关的营销骚扰。</p>
        </Clause>

        <Clause title="三、信息的存储与删除">
          <p>1. 视频文件与导出成片存储于服务器，你在项目内删除项目时，对应视频与导出文件将被同步删除。</p>
          <p>2. 转写文本随项目保存，直至你删除项目或注销账号。</p>
          <p>3. 为保障账务可追溯，额度流水记录在账号存续期间保留。</p>
        </Clause>

        <Clause title="四、你的权利">
          <p>1. 你可以随时删除项目及对应视频文件。</p>
          <p>2. 你可以联系我们注销账号，注销后个人信息与项目数据将被删除（法律法规要求留存的除外）。</p>
        </Clause>

        <Clause title="五、信息安全">
          <p>我们采用业界通行的安全措施保护你的信息（传输加密、访问控制等）。如发生个人信息安全事件，我们将依法及时告知你并采取补救措施。</p>
        </Clause>

        <Clause title="六、未成年人保护">
          <p>本服务面向成年人。未成年人使用本服务应取得监护人同意并在监护人指导下进行。</p>
        </Clause>

        <Clause title="七、政策的更新">
          <p>本政策可能适时更新，重大变更将通过站内公告方式通知你。继续使用本服务视为接受更新后的政策。</p>
        </Clause>

        <Clause title="八、联系我们">
          <p>如对本政策有任何疑问、意见或投诉，可通过页面底部的联系方式与我们取得联系，我们将在 15 个工作日内答复。</p>
        </Clause>
      </main>
      <SiteFooter />
    </div>
  );
}
