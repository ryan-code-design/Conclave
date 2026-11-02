import type { AgentDescriptor } from './agent-descriptor'

// Google's Antigravity ACP server, the one its Zed and JetBrains extensions run: its three session
// modes are Conclave's ask, acceptEdits and bypass. It has no read-only or plan mode, so a stage that
// must stay read-only refuses to start rather than run in one that edits.
export const antigravity: AgentDescriptor = {
  translations: { en: {
    modes: {
      ask: { label: 'Default', description: "Antigravity's default review: asks before editing files and running commands" },
      acceptEdits: { label: 'Auto Edit', description: 'Edits files without asking; still asks before running commands' },
      bypass: { label: 'YOLO', description: 'Runs every tool without asking' }
    },
    environment: {
      role: "Runs Google's Antigravity ACP server (the one behind its Zed and JetBrains extensions), which Conclave downloads into its own folder. Neither agy nor the Antigravity editor is needed.",
      install: 'Download the Antigravity ACP server from Settings → Local agents',
      signIn: 'Your first chat opens the Google sign-in page in the browser',
      missing: { status: 'Not downloaded', hint: "Conclave runs Antigravity through Google's Antigravity ACP server, which it downloads first (110–340 MB). Neither agy nor the Antigravity editor is needed." }
    },
    usageWhere: 'Send /usage in an Antigravity chat'
  } },
  label: 'Antigravity',
  cli: 'agy',
  setup: 'first-use',
  modes: {
    ask: { label: 'Default', description: 'Antigravity 默认的审批流程：修改文件和运行命令前先问你' },
    acceptEdits: { label: 'Auto Edit', description: '直接修改文件，运行命令前仍先问你' },
    bypass: { label: 'YOLO', description: '所有工具直接运行，什么都不问' }
  },
  startModes: ['ask', 'acceptEdits', 'bypass'],
  defaultStartMode: 'ask',
  discussionMode: 'ask',
  readOnlyMode: 'ask',
  // Signed in with a personal account, its file tools refuse anything outside its cwd.
  primaryOnlyFiles: true,
  capabilities: { readOnly: false, unattended: false, bypass: true, autoMode: false, pathMentions: false, optionsWhileBusy: false, skills: false, userMcp: true, modelProviders: [], accounts: false },
  environment: {
    role: '聊天界面运行 Google 的 Antigravity ACP 服务（Zed、JetBrains 扩展用的同一个），由 Conclave 下载到自己的目录；不需要 agy 或 Antigravity 编辑器。',
    install: '在 设置 → 外部智能体 里下载 Antigravity ACP 服务',
    signIn: '第一次对话时会在浏览器打开 Google 登录页',
    missing: { status: '未下载', hint: 'Conclave 通过 Google 的 Antigravity ACP 服务运行 Antigravity，需要先下载它（110–340 MB）；不需要 agy 或 Antigravity 编辑器。' }
  },
  usageWhere: '在 Antigravity 会话里发送 /usage 查看'
}
