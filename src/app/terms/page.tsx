/**
 * @file 用户协议页面
 * @description 规范 SubFlow 与用户之间的权利义务：服务说明、账号、额度收费、
 *              行为规范（版权责任）、免责声明与争议解决。纯静态页面，可预渲染。
 *              注意：条款中的主体信息、联系方式需在正式上线前替换为真实信息。
 */
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

/** 协议更新日期（静态常量：Cache Components 模式禁止预渲染期调用 new Date()） */
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

/** 用户协议页面 */
export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <h1 className="text-2xl font-bold">用户协议</h1>
        <p className="mt-2 text-sm text-neutral-400">更新日期：{LAST_UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed text-neutral-600">
          欢迎使用 SubFlow 字幕工坊（以下简称&ldquo;本服务&rdquo;）。本协议是你与本服务运营者之间关于使用本服务的约定。注册、登录或使用本服务即表示你已阅读并同意本协议全部内容。
        </p>

        <Clause title="一、服务说明">
          <p>1. 本服务为视频字幕工具：你上传视频后，服务通过语音识别与 AI 文本润色自动生成字幕，支持字幕编辑、烧录导出与 SRT 导出。</p>
          <p>2. 本服务按&ldquo;现状&rdquo;提供，我们将持续优化服务质量和功能，但不保证服务完全无中断或无错误。</p>
        </Clause>

        <Clause title="二、账号与安全">
          <p>1. 你通过手机号码注册与登录，应保证注册信息真实、合法。</p>
          <p>2. 你应妥善保管账号，因你主动泄露密码/验证码或遭受他人攻击导致的损失由你自行承担。</p>
          <p>3. 禁止注册多个账号恶意套取注册赠送额度，我们有权回收异常账号的赠送额度并视情节限制服务。</p>
        </Clause>

        <Clause title="三、额度与收费">
          <p>1. 本服务按额度（转写时长）计费：注册赠送体验额度；持续使用可通过兑换激活码获得额度或月度订阅。</p>
          <p>2. 烧录导出按视频时长扣减额度；SRT 文件下载不消耗额度。</p>
          <p>3. 转写或导出失败的不会扣减额度；已成功兑换的激活码对应额度可长期使用，月度订阅有效期以兑换时提示为准。</p>
          <p>4. 额度不可转让、不可提现、不可折现。</p>
        </Clause>

        <Clause title="四、用户行为规范">
          <p>1. 你上传的视频应为<b>你拥有合法权利或已获授权</b>的内容；因上传内容侵犯他人著作权、肖像权、隐私权等引发的全部责任由你承担。</p>
          <p>2. 禁止上传含法律法规禁止内容（色情、暴力、赌博、危害国家安全等）的视频。我们有权拒绝处理并删除违规内容，情节严重的终止服务并留存证据依法报告。</p>
          <p>3. 禁止以技术手段绕过额度与权限限制、对本服务进行恶意攻击或爬取数据。</p>
        </Clause>

        <Clause title="五、知识产权">
          <p>1. 你上传视频的著作权归你或原权利人所有；你在本服务生成的字幕文本归你使用，我们仅为完成服务目的处理上述内容。</p>
          <p>2. 本服务的软件、界面设计、商标等知识产权归本服务运营者所有，未经许可不得复制或用于商业用途。</p>
        </Clause>

        <Clause title="六、免责声明">
          <p>1. AI 语音识别与润色结果可能存在误差，字幕内容仅供你参考与校对，你应在导出使用前自行核对。</p>
          <p>2. 因不可抗力（自然灾害、网络故障、政策调整、第三方服务中断等）导致服务暂停或数据丢失的，我们不承担责任，但将尽力协助恢复。</p>
        </Clause>

        <Clause title="七、协议的变更与终止">
          <p>1. 我们可能根据业务调整更新本协议，重大变更将通过站内公告通知；继续使用视为接受新协议。</p>
          <p>2. 你可随时停止使用并联系我们注销账号；你违反本协议的，我们有权随时限制或终止向你提供服务。</p>
        </Clause>

        <Clause title="八、法律适用与争议解决">
          <p>1. 本协议适用中华人民共和国法律。</p>
          <p>2. 因本协议产生的争议，双方应友好协商解决；协商不成的，任何一方可向本服务运营者所在地有管辖权的人民法院提起诉讼。</p>
        </Clause>

        <Clause title="九、联系我们">
          <p>如对本协议有任何疑问，可通过页面底部的联系方式与我们取得联系。</p>
        </Clause>
      </main>
      <SiteFooter />
    </div>
  );
}
