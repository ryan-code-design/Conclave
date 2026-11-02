import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  agentDescriptor,
  checkAddDiscussionMember,
  checkArchiveDiscussion,
  checkDiscussionAction,
  checkEditDiscussionProjects,
  checkNewDiscussionTopic,
  checkRemoveDiscussionMember,
  currentTopic,
  DEFAULT_DISCUSSION_REQUIREMENTS,
  Discussion,
  DiscussionCreate,
  DiscussionMemberFields,
  DiscussionPost,
  PLAN_TOOLS,
  type AgentKind,
  type ChatItem,
  type Conversation,
  type DiscussionAction,
  type DiscussionMember,
  type DiscussionMemberStatus,
  type DiscussionPostKind
} from '@conclave/protocol'
import type { ConversationService } from './conversation-service'
import { holdsPosition, openingPrompt, replyPrompt, roundPrompt, summaryPrompt, topicPrompt } from './discussion-prompt'
import { Rejection } from './rejection'

const REF_PREFIX = 'discussion:'
const TURN_PREFIX = `turn:${REF_PREFIX}`
const PLAN_DENIAL = '这是只读讨论，不执行计划。请不要提交计划，直接把你的看法作为文字回答写出来。'

const DISCUSSION_SELECT = `SELECT id, title, topic, requirements, project_paths AS projectPaths, chair_id AS chairId, max_rounds AS maxRounds,
  anonymous, state, step, round, last_round AS lastRound, topic_start AS topicStart, pinned_at AS pinnedAt, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
  FROM discussions`
const MEMBER_SELECT = `SELECT id, discussion_id AS discussionId, conversation_id AS conversationId, agent, model, effort, name, role,
  position, removed_at AS removedAt FROM discussion_members`
const POST_SELECT = `SELECT id, discussion_id AS discussionId, sequence, round, member_id AS memberId, kind, text, mentions,
  topic, delivered, state, error, created_at AS createdAt, updated_at AS updatedAt FROM discussion_posts`

type StoredPost = DiscussionPost & { delivered: string[] }

// What a group chat is called until the user names it: its topic's first line.
function titleOf(topic: string): string {
  return [...(topic.split(/\r?\n/).find((line) => line.trim()) ?? '群聊').trim()].slice(0, 40).join('')
}

export type DiscussionEvents = {
  changed: (discussion: Discussion) => void
  deleted: (id: string) => void
  posts: (discussionId: string, posts: DiscussionPost[]) => void
}

export type DiscussionDeps = {
  conversations: Pick<ConversationService,
    'create' | 'get' | 'continue' | 'send' | 'messages' | 'chatPage' | 'interrupt' | 'respond' | 'delete' | 'stop' | 'validateStartOptions' | 'capacityAvailable' | 'setAdditionalProjects'>
  events: DiscussionEvents
}

// The reason, and below it what went wrong in the agent's own words (its stderr, a refusal), which a
// reason alone leaves out: "chat-start-failed" says nothing of why.
function failure(error: unknown): string {
  if (error instanceof Rejection) return error.message && error.message !== error.reason ? `${error.reason}\n${error.message}` : error.reason
  return error instanceof Error ? error.message : String(error)
}

function turnPostId(item: ChatItem): string | null {
  return item.kind === 'turn' && item.id.startsWith(TURN_PREFIX) ? item.id.slice(TURN_PREFIX.length) : null
}

// Group chats: each member talks in a conversation of its own, so its agent, model, session and
// approvals are a conversation's like any other. This only orchestrates: it sends each member a
// message named after the post it is to become, and when that message's turn ends, takes the
// turn's reply as the post. A round goes out to every member at once; once all of it is in, the
// next round goes, or the chair's summary. Each discussion's steps run one after another.
export class DiscussionService {
  private readonly db: DatabaseSync
  private readonly chains = new Map<string, Promise<unknown>>()
  // Each member's status as last announced, so a conversation's every change does not re-send the discussion.
  private readonly statuses = new Map<string, DiscussionMemberStatus>()

  constructor(
    file: string,
    private readonly deps: DiscussionDeps,
    private readonly now: () => number = Date.now,
    // When a turn's reply is read: after the chat items that end it, which come before its message is recorded.
    private readonly later: (run: () => void) => void = (run) => setImmediate(run)
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrateMemberOptions()
  }

  private migrateMemberOptions(): void {
    try {
      const members = this.db.prepare('SELECT dm.conversation_id, dm.agent, c.chat_options, c.workspace_read_only FROM discussion_members dm JOIN conversations c ON dm.conversation_id = c.id').all() as { conversation_id: string; agent: AgentKind; chat_options: string | null; workspace_read_only: number }[]
      for (const member of members) {
        const mode = agentDescriptor(member.agent).discussionMode
        let options: Record<string, unknown> = {}
        try { options = member.chat_options ? JSON.parse(member.chat_options) : {} } catch {}
        const { allowBypass: _bypass, ...rest } = options
        const cleaned = { ...rest, permissionMode: mode }
        if (options.permissionMode !== mode || options.allowBypass || !member.workspace_read_only) {
          this.db.prepare('UPDATE conversations SET chat_options = ?, workspace_read_only = 1 WHERE id = ?')
            .run(JSON.stringify(cleaned), member.conversation_id)
        }
      }
    } catch {}
  }

  close(): void { this.db.close() }

  list(): Discussion[] {
    return this.db.prepare(`${DISCUSSION_SELECT} ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC`).all().map((row) => this.describe(row))
  }

  get(id: string): Discussion {
    const row = this.db.prepare(`${DISCUSSION_SELECT} WHERE id = ?`).get(id)
    if (!row) throw new Rejection('discussion-not-found', `no discussion ${id}`)
    return this.describe(row)
  }

  posts(id: string): DiscussionPost[] {
    this.get(id)
    return this.storedPosts(id).map(({ delivered: _delivered, ...post }) => post)
  }

  async create(fields: DiscussionCreate): Promise<Discussion> {
    const parsed = DiscussionCreate.parse(fields)
    for (const member of parsed.members) {
      if (agentDescriptor(member.agent).capabilities.readOnly === false) {
        throw new Rejection('discussion-member-read-only', `${agentDescriptor(member.agent).label} 不支持只读模式，无法加入讨论`)
      }
      await this.deps.conversations.validateStartOptions(member.agent, { permissionMode: agentDescriptor(member.agent).discussionMode, model: member.model, effort: member.effort })
    }
    for (const agent of new Set(parsed.members.map((member) => member.agent))) {
      if (!this.deps.conversations.capacityAvailable(agent)) throw new Rejection('agent-capacity')
    }
    const id = randomUUID()
    const at = this.now()
    const title = parsed.title || titleOf(parsed.topic)
    const members = parsed.members.map((member) => ({ ...member, id: randomUUID(), conversationId: randomUUID() }))
    const chairId = members[parsed.chair]!.id
    this.db.prepare(`INSERT INTO discussions (id, title, topic, requirements, project_paths, chair_id, max_rounds, anonymous, state, step, round, last_round, pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, NULL, ?, ?)`)
      .run(id, title, parsed.topic, parsed.requirements, JSON.stringify(parsed.projectPaths), chairId, parsed.maxRounds, Number(parsed.anonymous), parsed.maxRounds, at, at)
    const insert = this.db.prepare(`INSERT INTO discussion_members (id, discussion_id, position, conversation_id, agent, model, effort, name, role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    members.forEach((member, position) => insert.run(member.id, id, position, member.conversationId, member.agent, member.model ?? null, member.effort ?? null, member.name, member.role))
    const created: string[] = []
    try {
      for (const member of members) {
        const mode = agentDescriptor(member.agent).discussionMode
        await this.deps.conversations.create(member.agent, parsed.projectPaths, false,
          { permissionMode: mode, model: member.model, effort: member.effort, deferStart: true, readOnly: true },
          null, member.conversationId, { id, title: `${title} · ${member.name}` })
        created.push(member.conversationId)
      }
    } catch (error) {
      for (const conversationId of created) await this.deps.conversations.delete(conversationId).catch(() => {})
      this.db.prepare('DELETE FROM discussion_members WHERE discussion_id = ?').run(id)
      this.db.prepare('DELETE FROM discussions WHERE id = ?').run(id)
      throw error
    }
    const discussion = this.announce(id)
    void this.serially(id, () => this.dispatchRound(id, 1))
    return discussion
  }

  // The user's word: to the members it names, who answer it alone, or to all in the next round.
  async post(id: string, text: string, mentions: readonly string[] = []): Promise<DiscussionPost> {
    const { said, next } = await this.serially(id, async () => {
      const discussion = this.writable(id)
      const named = [...new Set(mentions)].map((memberId) => {
        const member = discussion.members.find((each) => each.id === memberId)
        if (!member) throw new Rejection('discussion-member-not-found', `no member ${memberId}`)
        return member
      })
      const pending = this.storedPosts(id).filter((post) => post.state === 'pending')
      if (named.some((member) => pending.some((post) => post.memberId === member.id))) throw new Rejection('discussion-member-busy', 'a member named is still answering')
      const said = this.insertPost(id, { round: discussion.round, memberId: null, kind: 'user', text, mentions: named.map((member) => member.id), state: 'done' })
      this.announcePosts(id, [said])
      if (named.length > 0) {
        return { said, next: () => Promise.all(named.map((member) => this.ask(this.get(id), member, 'reply', discussion.round, (unseen) => replyPrompt(this.get(id), said, unseen)))) }
      }
      if (discussion.state === 'paused' || discussion.state === 'done') {
        this.write(id, { state: 'running', last_round: discussion.round + 1 })
        this.announce(id)
        return { said, next: () => this.dispatchRound(id, discussion.round + 1) }
      }
      this.announce(id)
      return { said, next: null }
    })
    if (next) this.followUp(id, next)
    return this.postOf(id, said.id)
  }

  // What a post sets going, after the post is answered: an agent can take seconds to start, and the
  // user's words are in already. It runs next in the discussion's line, as a step of its own.
  private followUp(id: string, work: () => Promise<unknown>): void {
    void this.serially(id, async () => {
      await work()
      this.announce(id)
    }).catch(() => {})
  }

  // The user moves the group on, once nothing is out: every member answers the new topic alone, with
  // what came before as background, then it goes round to the summary as the first did. A title that
  // only named the old topic follows it.
  async newTopic(id: string, text: string): Promise<DiscussionPost> {
    const said = await this.serially(id, async () => {
      const discussion = this.writable(id)
      if (checkNewDiscussionTopic(discussion)) throw new Rejection('discussion-busy', 'the turns out now go first')
      const named = discussion.title === titleOf(currentTopic(discussion, this.storedPosts(id)))
      const said = this.insertPost(id, { round: discussion.round + 1, memberId: null, kind: 'user', text, mentions: [], state: 'done', topic: true })
      this.announcePosts(id, [said])
      this.write(id, {
        state: 'running', topic_start: discussion.round, last_round: discussion.round + discussion.maxRounds,
        ...(named ? { title: titleOf(text) } : {})
      })
      this.announce(id)
      return said
    })
    this.followUp(id, () => this.dispatchRound(id, said.round))
    return this.postOf(id, said.id)
  }

  async control(id: string, action: DiscussionAction): Promise<Discussion> {
    return this.serially(id, async () => {
      const discussion = this.writable(id)
      const blocked = checkDiscussionAction(discussion, action)
      if (blocked) throw new Rejection(`discussion-${blocked}`)
      const pending = this.storedPosts(id).filter((post) => post.state === 'pending')
      switch (action) {
        case 'pause':
          this.write(id, { state: 'pausing' })
          break
        case 'resume':
          this.write(id, { state: 'running' })
          if (discussion.state === 'paused') await this.resume(this.get(id))
          break
        case 'nextRound':
          this.write(id, { state: 'running', last_round: discussion.round + 1 })
          await this.dispatchRound(id, discussion.round + 1)
          break
        case 'conclude':
          this.write(id, { state: 'running', last_round: discussion.round })
          if (pending.length === 0) await this.dispatchSummary(id)
          break
        case 'stop':
          this.write(id, { state: 'pausing' })
          for (const post of pending) {
            const member = discussion.members.find((each) => each.id === post.memberId)
            if (member) await this.deps.conversations.interrupt(member.conversationId).catch(() => {})
          }
          break
      }
      await this.advance(id)
      return this.announce(id)
    })
  }

  // A member joins midway, up to the limit: the next round it is given the topic and everything said
  // so far, as what it has not seen; a discussion paused or summed up takes it on when it goes on.
  async addMember(id: string, fields: DiscussionMemberFields): Promise<Discussion> {
    return this.serially(id, async () => {
      const discussion = this.writable(id)
      const blocked = checkAddDiscussionMember(discussion)
      if (blocked) throw new Rejection(`discussion-member-${blocked}`)
      const member = DiscussionMemberFields.parse(fields)
      if (discussion.members.some((each) => each.name.toLowerCase() === member.name.toLowerCase())) {
        throw new Rejection('discussion-member-name-taken', `a member is already called ${member.name}`)
      }
      if (agentDescriptor(member.agent).capabilities.readOnly === false) {
        throw new Rejection('discussion-member-read-only', `${agentDescriptor(member.agent).label} 不支持只读模式，无法加入讨论`)
      }
      await this.deps.conversations.validateStartOptions(member.agent, { permissionMode: agentDescriptor(member.agent).discussionMode, model: member.model, effort: member.effort })
      if (!this.deps.conversations.capacityAvailable(member.agent)) throw new Rejection('agent-capacity')
      const memberId = randomUUID()
      const conversationId = randomUUID()
      const last = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM discussion_members WHERE discussion_id = ?').get(id)
      this.db.prepare(`INSERT INTO discussion_members (id, discussion_id, position, conversation_id, agent, model, effort, name, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(memberId, id, Number(last?.next ?? 0), conversationId, member.agent, member.model ?? null, member.effort ?? null, member.name, member.role)
      try {
        const mode = agentDescriptor(member.agent).discussionMode
        await this.deps.conversations.create(member.agent, discussion.projectPaths, false,
          { permissionMode: mode, model: member.model, effort: member.effort, deferStart: true, readOnly: true },
          null, conversationId, { id, title: `${discussion.title} · ${member.name}` })
      } catch (error) {
        this.db.prepare('DELETE FROM discussion_members WHERE id = ?').run(memberId)
        throw error
      }
      this.notice(id, discussion.round, `${member.name} 加入了讨论，下一轮开始发言。`)
      return this.announce(id)
    })
  }

  // A member leaves, its conversation with it; what it said stays, under its name.
  async removeMember(id: string, memberId: string): Promise<Discussion> {
    return this.serially(id, async () => {
      const discussion = this.writable(id)
      const member = discussion.members.find((each) => each.id === memberId)
      if (!member) throw new Rejection('discussion-member-not-found', `no member ${memberId}`)
      const blocked = checkRemoveDiscussionMember(discussion, memberId)
      if (blocked) throw new Rejection(`discussion-member-${blocked}`)
      this.db.prepare('UPDATE discussion_members SET removed_at = ? WHERE id = ?').run(this.now(), memberId)
      await this.deps.conversations.delete(member.conversationId).catch((error: unknown) => {
        if (!(error instanceof Rejection && error.reason === 'conversation-not-found')) throw error
      })
      this.statuses.delete(memberId)
      this.notice(id, discussion.round, `${member.name} 离开了讨论。`)
      return this.announce(id)
    })
  }

  // The projects after the first, for every member at once; each agent is given them as it starts
  // again on its session, and later prompts list them.
  async setProjects(id: string, projectPaths: readonly string[]): Promise<Discussion> {
    return this.serially(id, async () => {
      const discussion = this.writable(id)
      const blocked = checkEditDiscussionProjects(discussion)
      if (blocked) throw new Rejection(blocked === 'busy' ? 'discussion-member-busy' : 'discussion-no-projects')
      const [primary] = discussion.projectPaths
      if (projectPaths[0] !== primary) throw new Rejection('primary-fixed', 'the first project stays')
      let settled: readonly string[] = discussion.projectPaths
      for (const member of discussion.members) {
        const conversation = await this.deps.conversations.setAdditionalProjects(member.conversationId, projectPaths.slice(1))
        settled = conversation.projectPaths
      }
      if (settled.join('\n') === discussion.projectPaths.join('\n')) return discussion
      this.write(id, { project_paths: JSON.stringify(settled) })
      this.notice(id, discussion.round, `项目改为：${settled.map((each) => each.split(/[\\/]/).filter(Boolean).at(-1) ?? each).join('、')}`)
      return this.announce(id)
    })
  }

  rename(id: string, title: string): Discussion {
    this.get(id)
    this.write(id, { title })
    return this.announce(id)
  }

  // Puts it away once nothing is out, letting its members' agents go; taken out again, it goes on as
  // it was left. Archived, it is read-only.
  async setArchived(id: string, archived: boolean): Promise<Discussion> {
    return this.serially(id, async () => {
      const current = this.get(id)
      if ((current.archivedAt !== null) === archived) return current
      if (archived) {
        if (checkArchiveDiscussion(current)) throw new Rejection('discussion-busy', 'the turns out now go first')
        for (const member of current.members) {
          const conversation = this.conversation(member.conversationId)
          if (conversation?.sessionId) await this.deps.conversations.stop(member.conversationId)
        }
      }
      this.db.prepare('UPDATE discussions SET archived_at = ? WHERE id = ?').run(archived ? this.now() : null, id)
      return this.announce(id)
    })
  }

  // What changes a group chat waits until it is taken out of the archive.
  private writable(id: string): Discussion {
    const discussion = this.get(id)
    if (discussion.archivedAt !== null) throw new Rejection('discussion-archived', 'take the group chat out of the archive first')
    return discussion
  }

  setPinned(id: string, pinned: boolean): Discussion {
    const current = this.get(id)
    if ((current.pinnedAt !== null) === pinned) return current
    this.db.prepare('UPDATE discussions SET pinned_at = ? WHERE id = ?').run(pinned ? this.now() : null, id)
    return this.announce(id)
  }

  // Its members' conversations go with it; the folders they worked in stay, as a conversation's do.
  async delete(id: string): Promise<void> {
    const discussion = this.get(id)
    this.db.prepare(`UPDATE discussions SET state = 'paused' WHERE id = ?`).run(id)
    for (const member of discussion.members) {
      await this.deps.conversations.delete(member.conversationId).catch((error: unknown) => {
        if (!(error instanceof Rejection && error.reason === 'conversation-not-found')) throw error
      })
      this.statuses.delete(member.id)
    }
    this.db.prepare('DELETE FROM discussion_posts WHERE discussion_id = ?').run(id)
    this.db.prepare('DELETE FROM discussion_members WHERE discussion_id = ?').run(id)
    this.db.prepare('DELETE FROM discussions WHERE id = ?').run(id)
    this.deps.events.deleted(id)
  }

  // A turn named after a post ended in a member's conversation: its reply becomes the post, read
  // once the turn's message is recorded.
  observe(conversationId: string, items: readonly ChatItem[]): void {
    for (const item of items) {
      const postId = turnPostId(item)
      if (!postId || item.kind !== 'turn') continue
      const { state, error } = item
      this.later(() => {
        const post = this.findPost(postId)
        if (!post || post.state !== 'pending') return
        void this.serially(post.discussionId, async () => {
          this.settle(post.id, conversationId, state === 'completed' ? null : error ?? state)
          await this.advance(post.discussionId)
          this.announce(post.discussionId)
        })
      })
    }
  }

  // A member's conversation changed: its status may have, and a plan it put up is turned down, as
  // it is asked to answer in words.
  conversationChanged(conversation: Conversation): void {
    if (!conversation.discussionId) return
    const member = this.memberOf(conversation.id)
    if (!member) return
    const request = conversation.chat?.request
    if (request && request.kind === 'approval' && this.pendingOf(member.id)) {
      if (request.tool !== null && PLAN_TOOLS.has(request.tool)) {
        void this.deps.conversations.respond(conversation.id, request.requestId, { decision: 'deny', message: PLAN_DENIAL }).catch(() => {})
      }
    }
    const status = this.statusOf(member.id, conversation)
    if (this.statuses.get(member.id) !== status) {
      this.statuses.set(member.id, status)
      this.announce(member.discussionId)
    }
  }

  // After a restart: a post whose member's agent is gone is settled from its conversation's log,
  // where its turn ended, else as lost; then each discussion goes on where it stood.
  async reconcile(): Promise<void> {
    for (const discussion of this.list()) {
      await this.serially(discussion.id, async () => {
        for (const post of this.storedPosts(discussion.id).filter((each) => each.state === 'pending')) {
          const member = discussion.members.find((each) => each.id === post.memberId)
          const conversation = member ? this.conversation(member.conversationId) : null
          if (conversation?.chat) continue
          const ended = conversation ? this.deps.conversations.chatPage(conversation.id).items.findLast((item) => turnPostId(item) === post.id) : undefined
          if (ended?.kind === 'turn' && member) this.settle(post.id, member.conversationId, ended.state === 'completed' ? null : ended.error ?? ended.state)
          else this.settle(post.id, member?.conversationId ?? null, 'agent-lost')
        }
        await this.advance(discussion.id)
        this.announce(discussion.id)
      })
    }
  }

  private async resume(discussion: Discussion): Promise<void> {
    const posts = this.storedPosts(discussion.id)
    if (discussion.step === 'summary') {
      if (!posts.some((post) => post.kind === 'summary' && post.state === 'done' && post.round === discussion.round)) await this.dispatchSummary(discussion.id)
      return
    }
    const answered = posts.some((post) => post.round === discussion.round && (post.kind === 'opening' || post.kind === 'rebuttal') && post.state === 'done')
    if (discussion.round > 0 && !answered) await this.dispatchRound(discussion.id, discussion.round)
  }

  // Once nothing is out: the next round, the summary, or a stop.
  private async advance(id: string): Promise<void> {
    const discussion = this.get(id)
    const posts = this.storedPosts(id)
    if (posts.some((post) => post.state === 'pending')) return
    if (discussion.state === 'pausing') {
      this.write(id, { state: 'paused' })
      return
    }
    if (discussion.state !== 'running') return
    if (discussion.step === null) {
      await this.dispatchRound(id, 1)
      return
    }
    if (discussion.step === 'summary') {
      const summed = posts.findLast((post) => post.kind === 'summary')
      if (summed?.state === 'done') {
        this.write(id, { state: 'done' })
      } else {
        this.notice(id, discussion.round, '主持人没能写出总结，讨论已暂停；可以继续以重试，或换个方式追问。')
        this.write(id, { state: 'paused' })
      }
      return
    }
    const answers = posts.filter((post) => post.round === discussion.round && (post.kind === 'opening' || post.kind === 'rebuttal'))
    const done = answers.filter((post) => post.state === 'done')
    if (done.length === 0) {
      this.notice(id, discussion.round, '这一轮没有成员成功发言，讨论已暂停；继续时会重试这一轮。')
      this.write(id, { state: 'paused' })
      return
    }
    const settled = discussion.round >= discussion.topicStart + 2 && done.length === discussion.members.length && done.every((post) => holdsPosition(post.text))
    if (discussion.round >= discussion.lastRound || settled) await this.dispatchSummary(id)
    else await this.dispatchRound(id, discussion.round + 1)
  }

  private async dispatchRound(id: string, round: number): Promise<void> {
    this.write(id, { step: 'round', round })
    const discussion = this.get(id)
    const posts = this.storedPosts(id)
    const opening = round === discussion.topicStart + 1
    const moved = discussion.topicStart > 0 ? posts.findLast((post) => post.topic) : undefined
    const topic = currentTopic(discussion, posts)
    await Promise.all(discussion.members.map((member) => {
      // A member whose every answer failed may never have had the opening: it is given it again.
      const introduced = posts.some((post) => post.memberId === member.id && post.state === 'done')
      return this.ask(discussion, member, opening ? 'opening' : 'rebuttal', round, (unseen) => {
        const others = unseen.filter((post) => post.id !== moved?.id)
        if (!introduced) {
          const said = others.filter((post) => post.memberId !== null)
          const intro = openingPrompt(discussion, member, topic, others.filter((post) => post.memberId === null), opening ? said : [])
          return opening ? intro : `${intro}\n\n${roundPrompt(discussion, round, said)}`
        }
        return opening && moved ? topicPrompt(discussion, moved.text, others) : roundPrompt(discussion, round, unseen)
      })
    }))
  }

  private async dispatchSummary(id: string): Promise<void> {
    this.write(id, { step: 'summary' })
    const discussion = this.get(id)
    const chair = discussion.members.find((member) => member.id === discussion.chairId) ?? discussion.members[0]!
    await this.ask(discussion, chair, 'summary', discussion.round, (unseen) => summaryPrompt(discussion, unseen))
  }

  // Sends a member what it has not seen, as the prompt makes of it, under a pending post's name.
  // Answering a topic alone it is shown only what came before it: the others' first answers are its to not see.
  private async ask(discussion: Discussion, member: DiscussionMember, kind: DiscussionPostKind, round: number, prompt: (unseen: DiscussionPost[]) => string): Promise<void> {
    const unseen = this.storedPosts(discussion.id).filter((post) =>
      post.state === 'done' && post.memberId !== member.id && post.kind !== 'notice' && !post.delivered.includes(member.id)
      && (kind !== 'opening' || post.memberId === null || post.round <= discussion.topicStart))
    const text = prompt(unseen.map(({ delivered: _delivered, ...post }) => post))
    const post = this.insertPost(discussion.id, { round, memberId: member.id, kind, text: '', mentions: [], state: 'pending' })
    const deliver = this.db.prepare('UPDATE discussion_posts SET delivered = ? WHERE id = ?')
    for (const each of unseen) deliver.run(JSON.stringify([...each.delivered, member.id]), each.id)
    this.announcePosts(discussion.id, [post])
    try {
      if (agentDescriptor(member.agent).capabilities.readOnly === false) {
        throw new Rejection('discussion-member-read-only', `${agentDescriptor(member.agent).label} 不支持只读模式，无法继续讨论`)
      }
      const mode = agentDescriptor(member.agent).discussionMode
      const conversation = this.deps.conversations.get(member.conversationId)
      if (conversation.chatOptions?.permissionMode !== mode || conversation.chatOptions?.allowBypass) {
        const { allowBypass: _bypass, ...rest } = conversation.chatOptions ?? {}
        const cleaned = { ...rest, permissionMode: mode }
        this.db.prepare('UPDATE conversations SET chat_options = ? WHERE id = ?')
          .run(JSON.stringify(cleaned), member.conversationId)
      }
      if (!conversation.chat) await this.deps.conversations.continue(member.conversationId, false)
      await this.deps.conversations.send(member.conversationId, text, [], true, false, `${REF_PREFIX}${post.id}`)
    } catch (error) {
      this.settle(post.id, member.conversationId, failure(error))
    }
  }

  // A pending post takes its turn's reply; error marks it failed, keeping what was said before it ended.
  private settle(postId: string, conversationId: string | null, error: string | null): void {
    const post = this.findPost(postId)
    if (!post || post.state !== 'pending') return
    const text = conversationId ? this.replyOf(conversationId, postId) : ''
    const state = error === null && text ? 'done' : 'failed'
    const reason = state === 'failed' ? error ?? 'no-reply' : null
    this.db.prepare('UPDATE discussion_posts SET text = ?, state = ?, error = ?, updated_at = ? WHERE id = ?').run(text, state, reason, this.now(), postId)
    this.announcePosts(post.discussionId, [this.postOf(post.discussionId, postId)])
  }

  // The turn's final reply as recorded; failing that, what the chat shows the agent saying in it.
  private replyOf(conversationId: string, postId: string): string {
    const ref = `${REF_PREFIX}${postId}`
    let messages: ReturnType<ConversationService['messages']> = []
    try { messages = this.deps.conversations.messages(conversationId) } catch { return '' }
    const recorded = messages.findLast((message) => message.role === 'assistant' && message.eventKey === `chat:${ref}:assistant`)
    if (recorded) return recorded.text.trim()
    const items = this.deps.conversations.chatPage(conversationId).items
    const start = items.findIndex((item) => item.id === `u:${ref}`)
    if (start < 0) return ''
    const end = items.findIndex((item, index) => index > start && item.kind === 'turn')
    return items.slice(start + 1, end < 0 ? undefined : end)
      .flatMap((item) => item.kind === 'assistant' ? [item.text] : []).join('\n\n').trim()
  }

  private notice(id: string, round: number, text: string): void {
    this.announcePosts(id, [this.insertPost(id, { round, memberId: null, kind: 'notice', text, mentions: [], state: 'done' })])
  }

  private insertPost(id: string, post: Pick<DiscussionPost, 'round' | 'memberId' | 'kind' | 'text' | 'mentions' | 'state'> & { topic?: boolean }): DiscussionPost {
    const postId = randomUUID()
    const at = this.now()
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM discussion_posts WHERE discussion_id = ?').get(id)
    this.db.prepare(`INSERT INTO discussion_posts (id, discussion_id, sequence, round, member_id, kind, text, mentions, topic, delivered, state, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, ?, ?)`)
      .run(postId, id, Number(row?.next ?? 1), post.round, post.memberId, post.kind, post.text, JSON.stringify(post.mentions), Number(post.topic ?? false), post.state, at, at)
    this.write(id, {})
    return this.postOf(id, postId)
  }

  private storedPosts(id: string): StoredPost[] {
    return this.db.prepare(`${POST_SELECT} WHERE discussion_id = ? ORDER BY sequence`).all(id).map((row) => this.parsePost(row))
  }

  private findPost(postId: string): StoredPost | null {
    const row = this.db.prepare(`${POST_SELECT} WHERE id = ?`).get(postId)
    return row ? this.parsePost(row) : null
  }

  private postOf(id: string, postId: string): DiscussionPost {
    const found = this.findPost(postId)
    if (!found || found.discussionId !== id) throw new Rejection('discussion-post-not-found')
    const { delivered: _delivered, ...post } = found
    return post
  }

  private parsePost(row: Record<string, unknown>): StoredPost {
    const post = DiscussionPost.parse({ ...row, mentions: JSON.parse(String(row.mentions)), topic: Boolean(row.topic) })
    return { ...post, delivered: JSON.parse(String(row.delivered)) }
  }

  private memberOf(conversationId: string): (DiscussionMember & { discussionId: string }) | null {
    const row = this.db.prepare(`${MEMBER_SELECT} WHERE conversation_id = ?`).get(conversationId)
    if (!row) return null
    const discussionId = String(row.discussionId)
    const member = this.get(discussionId).members.find((each) => each.id === row.id)
    return member ? { ...member, discussionId } : null
  }

  private pendingOf(memberId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM discussion_posts WHERE member_id = ? AND state = 'pending' LIMIT 1`).get(memberId) !== undefined
  }

  private statusOf(memberId: string, conversation: Conversation | null): DiscussionMemberStatus {
    if (!this.pendingOf(memberId)) return 'idle'
    return conversation?.chat?.turn === 'awaiting' ? 'awaiting' : 'working'
  }

  private conversation(id: string): Conversation | null {
    try { return this.deps.conversations.get(id) } catch { return null }
  }

  private describe(row: Record<string, unknown>): Discussion {
    const id = String(row.id)
    const rows = this.db.prepare(`${MEMBER_SELECT} WHERE discussion_id = ? ORDER BY position`).all(id)
    const member = ({ removedAt: _removedAt, ...fields }: Record<string, unknown>) => ({ ...fields, status: this.statusOf(String(fields.id), this.conversation(String(fields.conversationId))) })
    const members = rows.filter((row) => row.removedAt === null).map(member)
    const formerMembers = rows.filter((row) => row.removedAt !== null).map((row) => ({ ...member(row), status: 'idle' }))
    return Discussion.parse({ ...row, requirements: row.requirements ?? DEFAULT_DISCUSSION_REQUIREMENTS,
      projectPaths: JSON.parse(String(row.projectPaths)), anonymous: Boolean(row.anonymous), members, formerMembers })
  }

  private write(id: string, values: Record<string, SQLInputValue>): void {
    const entries = Object.entries({ ...values, updated_at: this.now() })
    this.db.prepare(`UPDATE discussions SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, value]) => value), id)
  }

  private announce(id: string): Discussion {
    const discussion = this.get(id)
    this.deps.events.changed(discussion)
    return discussion
  }

  private announcePosts(id: string, posts: DiscussionPost[]): void {
    this.deps.events.posts(id, posts)
  }

  private serially<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(action)
    const tail = result.then(() => {}, () => {})
    this.chains.set(id, tail)
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id) })
    return result
  }
}
