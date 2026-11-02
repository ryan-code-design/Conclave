import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentDescriptor, DEFAULT_DISCUSSION_REQUIREMENTS, type Discussion, type DiscussionCreate, type DiscussionPost } from '@conclave/protocol'
import { DatabaseSync } from 'node:sqlite'
import { AttachmentStore } from './attachment-store'
import { ConversationService } from './conversation-service'
import { ConversationStore } from './conversation-store'
import { DiscussionService } from './discussion-service'
import { fakeChatDaemon } from './fake-chat-agent'
import { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import { TaskStore } from './task-store'

const TOPIC = 'Should the cache live in core?'

describe('DiscussionService', () => {
  let root: string
  let tasks: TaskStore
  let store: ConversationStore
  let projects: ProjectRegistry
  let daemon: ReturnType<typeof fakeChatDaemon>
  let conversations: ConversationService
  let discussions: DiscussionService
  // What each member's agent says to a prompt; by default it echoes it, as the fake does.
  let answer: (member: string, prompt: string) => string | null
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'conclave-discussion-'))
    const database = path.join(root, 'conclave.db')
    tasks = new TaskStore(database)
    store = new ConversationStore(database)
    projects = new ProjectRegistry(database)
    daemon = fakeChatDaemon()
    serve()
    answer = (member, prompt) => `${member}: ${prompt.length}`
    // A session's member is the one whose conversation it runs, named by its title's tail.
    daemon.reply = (sessionId, prompt) => {
      const conversation = conversations.listAll().find((each) => each.sessionId === sessionId)
      const member = conversation?.title.split(' · ').at(-1) ?? '?'
      const said = answer(member, prompt)
      if (said === null) {
        daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: true, result: 'boom', duration_ms: 5 })
        return
      }
      daemon.emit(sessionId, { type: 'assistant', uuid: `uuid-${said.length}-${Math.random()}`, message: { id: `msg-${Math.random()}`, content: [{ type: 'text', text: said }] }, parent_tool_use_id: null })
      daemon.emit(sessionId, { type: 'result', subtype: 'success', is_error: false, result: said, terminal_reason: 'completed', duration_ms: 5 })
    }
  })

  // Core as it starts: its conversations and discussions read from the database, no agent open yet.
  function serve(): void {
    const attachments = path.join(root, 'attachments')
    mkdirSync(attachments, { recursive: true })
    conversations = new ConversationService(store, daemon, path.join(root, 'sessions'), (event) => {
      if (event.type === 'chatItems') discussions.observe(event.conversationId, event.items)
      else if (event.type === 'changed') discussions.conversationChanged(event.conversation)
    }, projects, new AttachmentStore(attachments))
    daemon.deliver = (event) => {
      if (event.event === 'data') conversations.handleData(event)
      else if (event.event === 'exit') conversations.handleExit(event.sessionId, event.exitCode)
      else conversations.handleStderr(event.sessionId, event.data)
    }
    discussions = new DiscussionService(path.join(root, 'conclave.db'), { conversations, events: { changed: () => {}, deleted: () => {}, posts: () => {} } })
  }

  afterEach(() => {
    discussions.close()
    projects.close()
    store.close()
    tasks.close()
    rmSync(root, { recursive: true, force: true })
  })

  const fields = (overrides: Partial<DiscussionCreate> = {}): DiscussionCreate => ({
    topic: TOPIC,
    projectPaths: [],
    members: [
      { agent: 'claude', name: 'Ann', role: 'argue for it' },
      { agent: 'claude', name: 'Bob' },
      { agent: 'claude', name: 'Cid' }
    ],
    chair: 2,
    maxRounds: 2,
    ...overrides
  })

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !check(); i++) await settle()
    expect(check()).toBe(true)
  }
  const state = (id: string) => discussions.get(id).state
  const by = (discussion: Discussion, name: string) => discussion.members.find((member) => member.name === name)!
  // What a member's agent was sent, in order.
  const prompts = (discussion: Discussion, name: string) => {
    const conversation = conversations.get(by(discussion, name).conversationId)
    const session = conversation.sessionId ?? ''
    return daemon.written(session).flatMap((frame) => {
      const message = typeof frame === 'object' && frame !== null && Reflect.get(frame, 'type') === 'user' ? Reflect.get(frame, 'message') : null
      return message ? [String(Reflect.get(message, 'content'))] : []
    })
  }
  const kinds = (posts: DiscussionPost[]) => posts.map((post) => `${post.round}:${post.kind}:${post.state}`)

  it('runs independent openings, rebuttals that see only the others, then the chair sums up', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const posts = discussions.posts(discussion.id)
    expect(kinds(posts)).toEqual([
      '1:opening:done', '1:opening:done', '1:opening:done',
      '2:rebuttal:done', '2:rebuttal:done', '2:rebuttal:done',
      '2:summary:done'
    ])
    expect(posts.at(-1)?.memberId).toBe(by(discussion, 'Cid').id)

    const ann = prompts(discussion, 'Ann')
    expect(ann).toHaveLength(2)
    expect(ann[0]).toContain(TOPIC)
    expect(ann[0]).toContain('argue for it')
    expect(ann[0]).not.toContain('Bob: ')
    // The second round shows the others' openings, fenced and named, and not its own.
    expect(ann[1]).toContain('<discussion-post speaker="Bob" round="1">')
    expect(ann[1]).toContain('<discussion-post speaker="Cid" round="1">')
    expect(ann[1]).not.toContain('speaker="Ann"')
    // The chair is shown only what came since it last spoke: the round-2 rebuttals.
    const cid = prompts(discussion, 'Cid')
    expect(cid).toHaveLength(3)
    expect(cid[2]).toContain('## 总结')
    expect(cid[2]).toContain('speaker="Ann" round="2"')
    expect(cid[2]).not.toContain('round="1"')
  })

  it('starts each member read-only, and keeps their conversations out of the list and search', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    for (const member of discussion.members) {
      const conversation = conversations.get(member.conversationId)
      expect(conversation.discussionId).toBe(discussion.id)
      expect(conversation.chatOptions?.permissionMode).toBe('plan')
    }
    expect(conversations.list(true)).toEqual([])
    expect(conversations.search('Should the cache')).toEqual([])
  })

  it.each(['请用表格比较方案，不限制字数。', ''])('persists requirements (%j) and sends them to every member and the chair', async (requirements) => {
    const discussion = await discussions.create(fields({ requirements }))
    await until(() => state(discussion.id) === 'done')
    expect(discussions.get(discussion.id).requirements).toBe(requirements)
    for (const member of discussion.members) {
      expect(conversations.get(member.conversationId).chatOptions?.permissionMode).toBe('plan')
      for (const prompt of prompts(discussion, member.name)) {
        expect(prompt).toContain('这是只读讨论')
        expect(prompt).not.toContain('600 字')
        expect(prompt).not.toContain('不要写标题或署名')
        if (requirements) expect(prompt).toContain(requirements)
        else expect(prompt).not.toContain('## 用户的讨论要求')
      }
    }
    discussions.close()
    serve()
    expect(discussions.get(discussion.id).requirements).toBe(requirements)
    expect(discussions.list().find((group) => group.id === discussion.id)?.requirements).toBe(requirements)
  })

  it('uses defaults for older clients and legacy rows, keeping an explicit empty value distinct', async () => {
    const discussion = await discussions.create(fields({ requirements: '' }))
    await until(() => state(discussion.id) === 'done')
    expect(discussions.get(discussion.id).requirements).toBe('')
    const db = new DatabaseSync(path.join(root, 'conclave.db'))
    try { db.prepare('UPDATE discussions SET requirements = NULL WHERE id = ?').run(discussion.id) } finally { db.close() }
    expect(discussions.get(discussion.id).requirements).toBe(DEFAULT_DISCUSSION_REQUIREMENTS)
    const omitted = await discussions.create(fields())
    await until(() => state(omitted.id) === 'done')
    expect(discussions.get(omitted.id).requirements).toBe(DEFAULT_DISCUSSION_REQUIREMENTS)
  })

  it('sums up early once every member holds its position', async () => {
    answer = (member, prompt) => prompt.includes('## 第 2 轮') ? `${member} agrees.\n\n**立场：维持**` : `${member} thinks so.`
    const discussion = await discussions.create(fields({ maxRounds: 4 }))
    await until(() => state(discussion.id) === 'done')
    expect(kinds(discussions.posts(discussion.id)).at(-1)).toBe('2:summary:done')
  })

  it('goes on without a member whose turn failed, and pauses when nobody answered', async () => {
    answer = (member, prompt) => member === 'Bob' ? null : `${member}: ${prompt.length}`
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const posts = discussions.posts(discussion.id)
    expect(posts.filter((post) => post.state === 'failed').map((post) => post.memberId)).toEqual([by(discussion, 'Bob').id, by(discussion, 'Bob').id])
    expect(posts.at(-1)?.kind).toBe('summary')

    answer = () => null
    const silent = await discussions.create(fields())
    await until(() => state(silent.id) === 'paused')
    expect(kinds(discussions.posts(silent.id)).at(-1)).toBe('1:notice:done')
  })

  it('asks only the members a post names, and leaves a finished discussion finished', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const bob = by(discussion, 'Bob')
    await discussions.post(discussion.id, 'Bob, why?', [bob.id])
    await until(() => discussions.posts(discussion.id).at(-1)?.kind === 'reply' && discussions.posts(discussion.id).at(-1)?.state === 'done')
    const posts = discussions.posts(discussion.id)
    expect(kinds(posts.slice(-2))).toEqual(['2:user:done', '2:reply:done'])
    expect(posts.at(-1)?.memberId).toBe(bob.id)
    expect(prompts(discussion, 'Bob').at(-1)).toContain('Bob, why?')
    expect(prompts(discussion, 'Ann')).toHaveLength(2)
    expect(state(discussion.id)).toBe('done')
  })

  it('takes a plain post into another round, which every member is shown', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    await discussions.post(discussion.id, 'Consider memory use too.')
    await until(() => state(discussion.id) === 'done' && discussions.posts(discussion.id).at(-1)?.round === 3)
    expect(kinds(discussions.posts(discussion.id)).slice(-5)).toEqual(['2:user:done', '3:rebuttal:done', '3:rebuttal:done', '3:rebuttal:done', '3:summary:done'])
    expect(prompts(discussion, 'Ann')[2]).toContain('用户说：\nConsider memory use too.')
  })

  it('moves on to a new topic once nothing is out, answered alone with the old as background, and renames a group named after the old', async () => {
    const discussion = await discussions.create(fields())
    await expect(discussions.newTopic(discussion.id, 'Which queue?')).rejects.toMatchObject({ reason: 'discussion-busy' })
    await until(() => state(discussion.id) === 'done')
    const said = await discussions.newTopic(discussion.id, 'Which queue?\nKafka or SQS.')
    expect(said).toMatchObject({ kind: 'user', topic: true, round: 3 })
    await until(() => state(discussion.id) === 'done' && discussions.posts(discussion.id).at(-1)?.round === 4)
    expect(kinds(discussions.posts(discussion.id)).slice(-8)).toEqual([
      '3:user:done', '3:opening:done', '3:opening:done', '3:opening:done', '4:rebuttal:done', '4:rebuttal:done', '4:rebuttal:done', '4:summary:done'
    ])
    expect(discussions.get(discussion.id)).toMatchObject({ topicStart: 2, lastRound: 4, title: 'Which queue?' })
    const opening = prompts(discussion, 'Ann')[2]!
    expect(opening).toContain('## 新议题')
    expect(opening).toContain('Kafka or SQS.')
    expect(opening).toContain('speaker="Cid" round="2"')
    expect(opening).not.toContain('round="3"')
    expect(prompts(discussion, 'Cid').at(-1)).toContain('只总结新议题')

    await discussions.rename(discussion.id, 'Infra')
    await discussions.newTopic(discussion.id, 'Which database?')
    await until(() => state(discussion.id) === 'done' && discussions.posts(discussion.id).at(-1)?.round === 6)
    expect(discussions.get(discussion.id).title).toBe('Infra')
  })

  it('archives a group chat once nothing is out, read-only until taken out again', async () => {
    const discussion = await discussions.create(fields())
    await expect(discussions.setArchived(discussion.id, true)).rejects.toMatchObject({ reason: 'discussion-busy' })
    await until(() => state(discussion.id) === 'done')

    const archived = await discussions.setArchived(discussion.id, true)
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(archived.members.map((member) => conversations.get(member.conversationId).sessionId)).toEqual([null, null, null])
    await expect(discussions.post(discussion.id, 'more?')).rejects.toMatchObject({ reason: 'discussion-archived' })
    await expect(discussions.newTopic(discussion.id, 'Another')).rejects.toMatchObject({ reason: 'discussion-archived' })
    await expect(discussions.control(discussion.id, 'nextRound')).rejects.toMatchObject({ reason: 'discussion-archived' })

    expect((await discussions.setArchived(discussion.id, false)).archivedAt).toBeNull()
    await discussions.post(discussion.id, 'One more round.')
    await until(() => state(discussion.id) === 'done' && discussions.posts(discussion.id).at(-1)?.round === 3)
  })

  it('answers a post before the member it names has started, which then answers', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const bob = by(discussion, 'Bob')
    // Bob's agent has gone, and the one the post starts will not finish starting.
    await conversations.stop(bob.conversationId)
    daemon.answerInit = false
    const spawned = daemon.spawns.length
    const said = await discussions.post(discussion.id, 'Bob, why?', [bob.id])
    expect(said).toMatchObject({ kind: 'user', text: 'Bob, why?' })
    await until(() => daemon.spawns.length > spawned)
    expect(discussions.posts(discussion.id).at(-1)).toMatchObject({ kind: 'reply', state: 'pending', memberId: bob.id })
  })

  it('keeps what an agent said when it could not start, beside the reason', async () => {
    daemon.answerInit = false
    const discussion = await discussions.create(fields({ members: [{ agent: 'claude', name: 'Ann' }, { agent: 'claude', name: 'Bob' }], chair: 1 }))
    await until(() => daemon.spawns.length >= 1)
    daemon.deliver({ event: 'stderr', sessionId: 'pipe-1', data: 'error: unknown option --add-dir\n' })
    daemon.exit('pipe-1', 1)
    await until(() => discussions.posts(discussion.id).some((post) => post.state === 'failed'))
    expect(discussions.posts(discussion.id).find((post) => post.state === 'failed')?.error).toBe('chat-start-failed\nerror: unknown option --add-dir')
  })

  it('pauses after the round out, resumes into the next, and concludes on request', async () => {
    const discussion = await discussions.create(fields({ maxRounds: 3 }))
    await discussions.control(discussion.id, 'pause')
    await until(() => state(discussion.id) === 'paused')
    expect(kinds(discussions.posts(discussion.id))).toEqual(['1:opening:done', '1:opening:done', '1:opening:done'])
    await expect(discussions.control(discussion.id, 'pause')).rejects.toThrow(Rejection)

    await discussions.control(discussion.id, 'resume')
    await discussions.control(discussion.id, 'conclude')
    await until(() => state(discussion.id) === 'done')
    expect(kinds(discussions.posts(discussion.id)).slice(-2)).toEqual(['2:rebuttal:done', '2:summary:done'])
  })

  it('adds a member midway, who catches up on what was said in its first turn and takes part from then on', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    await expect(discussions.addMember(discussion.id, { agent: 'claude', name: 'ann' })).rejects.toMatchObject({ reason: 'discussion-member-name-taken' })
    const joined = await discussions.addMember(discussion.id, { agent: 'claude', name: 'Dee', role: 'play devil' })
    expect(joined.members.map((member) => member.name)).toEqual(['Ann', 'Bob', 'Cid', 'Dee'])
    expect(discussions.posts(discussion.id).at(-1)).toMatchObject({ kind: 'notice', text: 'Dee 加入了讨论，下一轮开始发言。' })
    await discussions.control(discussion.id, 'nextRound')
    await until(() => state(discussion.id) === 'done')
    const [first] = prompts(joined, 'Dee')
    expect(first).toContain(TOPIC)
    expect(first).toContain('play devil')
    expect(first).toContain('speaker="Ann" round="1"')
    expect(first).toContain('speaker="Bob" round="2"')
    expect(kinds(discussions.posts(discussion.id)).slice(-5)).toEqual(['3:rebuttal:done', '3:rebuttal:done', '3:rebuttal:done', '3:rebuttal:done', '3:summary:done'])
    await discussions.addMember(discussion.id, { agent: 'claude', name: 'Eve' })
    await expect(discussions.addMember(discussion.id, { agent: 'claude', name: 'Fay' })).rejects.toMatchObject({ reason: 'discussion-member-full' })
  })

  it('takes a member out, keeping its letter for the others and its name on what it said', async () => {
    const discussion = await discussions.create(fields({ anonymous: true }))
    await until(() => state(discussion.id) === 'done')
    await expect(discussions.removeMember(discussion.id, by(discussion, 'Cid').id)).rejects.toMatchObject({ reason: 'discussion-member-chair' })
    const left = await discussions.removeMember(discussion.id, by(discussion, 'Bob').id)
    expect(left.members.map((member) => member.name)).toEqual(['Ann', 'Cid'])
    expect(left.formerMembers.map((member) => member.name)).toEqual(['Bob'])
    expect(() => conversations.get(by(discussion, 'Bob').conversationId)).toThrow()
    await expect(discussions.removeMember(discussion.id, by(discussion, 'Ann').id)).rejects.toMatchObject({ reason: 'discussion-member-too-few' })
    await discussions.control(discussion.id, 'nextRound')
    await until(() => state(discussion.id) === 'done')
    // Cid was 成员 C before Bob left, and stays so rather than becoming 成员 B.
    expect(prompts(discussion, 'Ann').at(-1)).toContain('speaker="成员 C" round="2"')
    // What Bob said before leaving still reaches Ann under his letter.
    expect(prompts(discussion, 'Ann').at(-1)).toContain('speaker="成员 B" round="2"')
  })

  it('changes the projects after the first for every member, and leaves the first and a group without projects as they are', async () => {
    // Core keeps a project by its real path, which a temp folder's is not on macOS.
    const [app, docs] = ['app', 'docs'].map((name) => {
      const dir = path.join(realpathSync(root), name)
      mkdirSync(dir)
      return dir
    })
    const discussion = await discussions.create(fields({ projectPaths: [app!] }))
    await until(() => state(discussion.id) === 'done')
    const changed = await discussions.setProjects(discussion.id, [app!, docs!])
    expect(changed.projectPaths).toEqual([app, docs])
    for (const member of changed.members) expect(conversations.get(member.conversationId).projectPaths).toEqual([app, docs])
    await expect(discussions.setProjects(discussion.id, [docs!])).rejects.toMatchObject({ reason: 'primary-fixed' })
    await discussions.control(discussion.id, 'nextRound')
    await until(() => state(discussion.id) === 'done')
    expect(prompts(discussion, 'Ann').at(-1)).toContain(`相关项目：${app}、${docs}`)
    const bare = await discussions.create(fields())
    await until(() => state(bare.id) === 'done')
    await expect(discussions.setProjects(bare.id, [app!])).rejects.toMatchObject({ reason: 'discussion-no-projects' })
  })

  it('names members by code when anonymous', async () => {
    const discussion = await discussions.create(fields({ anonymous: true }))
    await until(() => state(discussion.id) === 'done')
    const ann = prompts(discussion, 'Ann')
    expect(ann[0]).toContain('成员 A')
    expect(ann[0]).not.toContain('Bob')
    expect(ann[1]).toContain('speaker="成员 B"')
  })

  it('turns down a plan a member puts up, so it answers in words', async () => {
    const planned = new Set<string>()
    const reply = daemon.reply
    daemon.reply = (sessionId, prompt) => {
      if (planned.has(sessionId) || !prompt.includes('## 第 1 轮') || conversations.listAll().find((each) => each.sessionId === sessionId)?.title.endsWith('Bob') !== true) {
        reply(sessionId, prompt)
        return
      }
      planned.add(sessionId)
      daemon.emit(sessionId, { type: 'assistant', message: { id: 'msg-plan', content: [{ type: 'tool_use', id: 'toolu-plan', name: 'ExitPlanMode', input: { plan: '# Plan' } }] }, parent_tool_use_id: null })
      daemon.emit(sessionId, { type: 'control_request', request_id: 'req-plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, tool_use_id: 'toolu-plan' } })
    }
    const discussion = await discussions.create(fields())
    const bob = by(discussion, 'Bob')
    const session = () => conversations.get(bob.conversationId).sessionId ?? ''
    const denied = () => daemon.written(session()).some((frame) => JSON.stringify(frame).includes('"behavior":"deny"') && JSON.stringify(frame).includes('只读讨论'))
    await until(denied)
    reply(session(), 'Bob answers in words.')
    await until(() => state(discussion.id) === 'done')
    expect(discussions.posts(discussion.id).find((post) => post.memberId === bob.id)?.state).toBe('done')
  })

  it('settles a post whose agent was lost while core was away, and goes on', async () => {
    const reply = daemon.reply
    let hung = false
    daemon.reply = (sessionId, prompt) => {
      if (!hung && conversations.listAll().find((each) => each.sessionId === sessionId)?.title.endsWith('Bob')) {
        hung = true
        return
      }
      reply(sessionId, prompt)
    }
    const discussion = await discussions.create(fields())
    const bob = by(discussion, 'Bob')
    await until(() => discussions.posts(discussion.id).filter((post) => post.state === 'done').length === 2)
    daemon.sessions.delete(conversations.get(bob.conversationId).sessionId ?? '')
    discussions.close()
    serve()
    await conversations.reconcile((await daemon.request('list', {})).sessions)
    await discussions.reconcile()
    await until(() => state(discussion.id) === 'done')
    const opening = discussions.posts(discussion.id).find((post) => post.memberId === bob.id)
    expect(opening).toMatchObject({ kind: 'opening', state: 'failed', error: 'agent-lost' })
    // Shown the rules again with its next round, as its first answer may never have reached it.
    expect(prompts(discussion, 'Bob').at(-1)).toContain('## 规则')
  })

  it('keeps each member on its agent', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    await expect(conversations.handoff(by(discussion, 'Ann').conversationId, 'codex', '', true)).rejects.toThrow('a group chat member keeps its agent')
  })

  it('deletes the discussion with its members’ conversations', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    await discussions.delete(discussion.id)
    expect(discussions.list()).toEqual([])
    expect(conversations.listAll()).toEqual([])
  })

  it('refuses to create discussion with members lacking read-only capability', async () => {
    await expect(discussions.create(fields({
      members: [{ agent: 'antigravity', name: 'Ann' }, { agent: 'claude', name: 'Bob' }],
      chair: 1
    }))).rejects.toThrowError(expect.objectContaining({ reason: 'discussion-member-read-only' }))

    await expect(discussions.create(fields({
      members: [{ agent: 'gemini', name: 'Gem' }, { agent: 'claude', name: 'Bob' }],
      chair: 1
    }))).rejects.toThrowError(expect.objectContaining({ reason: 'discussion-member-read-only' }))
  })

  it('refuses to add member lacking read-only capability midway', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    await expect(discussions.addMember(discussion.id, {
      agent: 'antigravity',
      name: 'Dan',
      role: 'analyst'
    })).rejects.toThrowError(expect.objectContaining({ reason: 'discussion-member-read-only' }))
  })

  it('enforces workspaceReadOnly and forbids allowBypass on member conversations', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    for (const member of discussion.members) {
      const conv = conversations.get(member.conversationId)
      expect(conv.workspaceReadOnly).toBe(true)
      expect(store.chatOptions(member.conversationId).allowBypass).toBeFalsy()
    }
  })

  it('migrates legacy member conversation options to strip allowBypass and enforce workspaceReadOnly', async () => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const ann = by(discussion, 'Ann')
    store.setChatOptions(ann.conversationId, { permissionMode: 'ask', allowBypass: true })
    store.setWorkspaceReadOnly(ann.conversationId, false)

    // Reopen discussion service (which triggers migrateMemberOptions)
    discussions.close()
    discussions = new DiscussionService(path.join(root, 'conclave.db'), { conversations, events: { changed: () => {}, deleted: () => {}, posts: () => {} } })

    const options = store.chatOptions(ann.conversationId)
    expect(options.permissionMode).toBe('plan')
    expect(options.allowBypass).toBeUndefined()
    expect(conversations.get(ann.conversationId).workspaceReadOnly).toBe(true)
  })

  it.each([
    { tool: 'Write', input: { file_path: '/tmp/example', content: 'changed' } },
    { tool: 'Bash', input: { command: 'echo changed > /tmp/example' } },
    { tool: 'Bash', input: { command: "python -c 'from pathlib import Path; Path(\"/tmp/example\").write_text(\"changed\")'" } },
    { tool: 'unknown_tool', input: {} },
    { tool: 'Read', input: { file_path: '/tmp/example' } }
  ])('does not auto-approve $tool even when the descriptor requests bypass', async ({ tool, input }) => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const ann = by(discussion, 'Ann')
    const session = conversations.get(ann.conversationId).sessionId!
    const reply = daemon.reply
    daemon.reply = (sessionId, prompt) => {
      if (sessionId !== session) return reply(sessionId, prompt)
      daemon.emit(sessionId, { type: 'control_request', request_id: 'req-tool', request: {
        subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tool-1'
      } })
    }
    // Reintroduce the old descriptor condition without weakening the native read-only launch.
    const descriptor = agentDescriptor(ann.agent)
    const original = descriptor.discussionMode
    const respond = vi.spyOn(conversations, 'respond')
    descriptor.discussionMode = 'bypass'
    try {
      await discussions.control(discussion.id, 'nextRound')
      await until(() => conversations.get(ann.conversationId).chat?.request?.requestId === 'req-tool')
      await settle()
      expect(respond).not.toHaveBeenCalled()
      expect(discussions.get(discussion.id).members.find((member) => member.id === ann.id)?.status).toBe('awaiting')
      await conversations.respond(ann.conversationId, 'req-tool', { decision: 'deny' })
      reply(session, 'Ann answers in words.')
      await until(() => state(discussion.id) === 'done')
    } finally {
      descriptor.discussionMode = original
      respond.mockRestore()
    }
  })

  it.each(['antigravity', 'gemini'] as const)('refuses legacy %s members after reopening', async (agent) => {
    const discussion = await discussions.create(fields())
    await until(() => state(discussion.id) === 'done')
    const ann = by(discussion, 'Ann')
    for (const member of discussion.members) await conversations.stop(member.conversationId)
    const db = new DatabaseSync(path.join(root, 'conclave.db'))
    try {
      db.prepare('UPDATE discussion_members SET agent = ? WHERE id = ?').run(agent, ann.id)
      db.prepare('UPDATE conversations SET agent = ?, workspace_read_only = 0, chat_options = ? WHERE id = ?')
        .run(agent, JSON.stringify({ permissionMode: 'bypass', allowBypass: true }), ann.conversationId)
    } finally { db.close() }
    discussions.close()
    serve()
    const spawns = daemon.spawns.length
    await discussions.reconcile()
    await discussions.control(discussion.id, 'nextRound')
    await until(() => state(discussion.id) === 'done')
    const posts = discussions.posts(discussion.id).filter((post) => post.memberId === ann.id && post.round === 3)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('discussion-member-read-only') })
    expect(daemon.spawns.slice(spawns).every((spawn) => spawn.agent !== agent)).toBe(true)
    expect(conversations.get(ann.conversationId).workspaceReadOnly).toBe(true)
    expect(store.chatOptions(ann.conversationId).allowBypass).toBeUndefined()
    await expect(conversations.continue(ann.conversationId, true)).rejects.toMatchObject({ reason: 'discussion-member-read-only' })
  })
})
