import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import * as Y from 'yjs'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Task comments test requires a disposable loopback *_e2e database')

const errorOf = (result: unknown) => (result as { error?: string }).error
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

// Edit, delete, reactions and inline files on a task's comments, against the
// real task ACL, workspace roles, document exchange and retention job.
test('task comments: author-only edit, author-or-admin delete with tombstones, unique reactions, inline file access and cleanup', { skip: !enabled, timeout: 180_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { seedUser, seedWorkspace, seedIssue, seedTeam } = await import('./support/workspace-admin-db')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { exchangeDocument } = await import('../app/actions/collaboration')
  const { mobileCommentExchange } = await import('../lib/mobile-task-edit')
  const actions = await import('../app/actions/task-comments')
  const files = await import('../lib/task-attachments/store')
  const { replyToThread, addThread } = await import('../lib/rich-text/comments-model')
  const { readDocumentThreads } = await import('../lib/task-activity-wake')
  const { taskDiscussionEvents } = await import('../lib/task-activity-timeline')

  const owner = await seedUser(pool, 'owner'), member = await seedUser(pool, 'member'), reader = await seedUser(pool, 'reader'), outsider = await seedUser(pool, 'outsider')
  const users = [owner, member, reader, outsider]
  const team = await seedWorkspace(workspacePool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: reader, role: 'member' }])
  const elsewhere = await seedWorkspace(workspacePool, outsider, [{ userId: outsider, role: 'admin' }])
  const teamRow = await seedTeam(workspacePool, team.id, owner)
  const task = await seedIssue(pool, owner, team.id)
  await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [task, teamRow.id, team.id, owner])
  await pool.query('update issues set content=$2 where id=$1', [task, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }] }])
  // `reader` may read the task but not write on it.
  await pool.query(`update resource_access_policies set visibility='private' where kind='task' and id=$1`, [task])
  await pool.query(`insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) values('task',$1,'account',$2,ARRAY['canReadContent','canSteer']),('task',$1,'account',$3,ARRAY['canReadContent'])`, [task, member, reader])
  t.after(async () => {
    await pool.query(`delete from resource_access_grants where "resourceKind"='task' and "resourceId"=$1`, [task])
    await pool.query('delete from workspace_audit_events where "workspaceId"=$1', [team.id])
    await pool.query('delete from issues where id=$1', [task])
    await workspacePool.query('delete from mikka_workspaces where id=any($1::uuid[])', [[team.id, elsewhere.id]])
    await pool.query('delete from "user" where id=any($1::text[])', [users])
  })

  const as = <T>(userId: string, work: () => Promise<T>, workspaceId = team.id) => actAs({ id: userId, [tokenWorkspace]: workspaceId }, work)
  const state = async () => (await pool.query<{ state: string }>('select state from issue_documents where "issueId"=$1', [task])).rows[0]?.state
  const threads = async () => {
    const doc = new Y.Doc()
    try { Y.applyUpdate(doc, Buffer.from((await state())!, 'base64')); return readDocumentThreads(doc) } finally { doc.destroy() }
  }
  /** A client's own document write, as the editor sends it. */
  const write = (userId: string, change: (doc: Y.Doc) => void) => as(userId, async () => {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, Buffer.from((await state())!, 'base64'))
      const vector = Y.encodeStateVector(doc)
      change(doc)
      return exchangeDocument({ id: task, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64') })
    } finally { doc.destroy() }
  })
  const reactionRows = async () => (await pool.query('select "messageId","userId",emoji from task_comment_reactions where "taskId"=$1 order by "messageId","userId",emoji', [task])).rows

  // The owner's first comment initializes the document; the member replies.
  const first = mobileCommentExchange({ id: task, content: (await pool.query('select content from issues where id=$1', [task])).rows[0].content, initialized: false,
    threadId: 'discussion-a', authorUserId: owner, body: 'Owner comment', at: new Date().toISOString() })!
  await as(owner, () => exchangeDocument(first))
  await write(member, doc => { replyToThread(doc, 'discussion-a', { id: 'reply-a1', author: '', body: 'Member reply', at: new Date().toISOString() }) })
  const ownerComment = { taskId: task, threadId: 'discussion-a', messageId: 'discussion-a-1' }
  const memberReply = { taskId: task, threadId: 'discussion-a', messageId: 'reply-a1' }
  assert.deepEqual((await threads())[0].messages.map(message => [message.id, message.authorUserId]), [['discussion-a-1', owner], ['reply-a1', member]])

  await t.test('only the author edits, and the edit is stamped', async () => {
    assert.equal(errorOf(await as(member, () => actions.editTaskComment({ ...ownerComment, body: 'Hijacked' }))), 'taskCommentAuthorOnly')
    assert.equal(errorOf(await as(owner, () => actions.editTaskComment({ ...ownerComment, body: '   ' }))), 'taskCommentInvalid')
    assert.equal(errorOf(await as(owner, () => actions.editTaskComment({ ...ownerComment, messageId: 'missing', body: 'x' }))), 'taskCommentNotFound')
    assert.equal(errorOf(await as(outsider, () => actions.editTaskComment({ ...ownerComment, body: 'x' }), elsewhere.id)), 'issueNotFound')
    const edited = await as(owner, () => actions.editTaskComment({ ...ownerComment, body: '  Owner comment, edited  ' }))
    assert.ok('comment' in edited && edited.comment, JSON.stringify(edited))
    assert.equal(edited.comment.body, 'Owner comment, edited')
    assert.ok(edited.comment.editedAt && Date.parse(edited.comment.editedAt) > 0)
    const [saved] = (await threads())[0].messages
    assert.deepEqual([saved.body, saved.editedAt, saved.authorUserId], ['Owner comment, edited', edited.comment.editedAt, owner])
    const [event] = taskDiscussionEvents(await threads())
    assert.equal(event.editedAt, edited.comment.editedAt, 'the activity carries 「已编辑」')
    // The document's own path still refuses someone else's edit.
    await assert.rejects(write(member, doc => {
      const messages = doc.getMap<Y.Map<unknown>>('threads').get('discussion-a')!.get('messages') as Y.Array<{ id: string; body: string }>
      const [message] = messages.toArray(); messages.delete(0, 1); messages.insert(0, [{ ...message, body: 'Hijacked' }])
    }), /cannot edit another user/)
  })

  await t.test('reactions: one per emoji per person, counted with who reacted; readers cannot react', async () => {
    const react = (userId: string, emoji: string, reacted = true, ref: object = ownerComment) => as(userId, () => actions.setTaskCommentReaction({ ...ref, emoji, reacted } as Parameters<typeof actions.setTaskCommentReaction>[0]))
    await react(member, '👍')
    const again = await react(member, '👍')
    assert.ok('reactions' in again && again.reactions)
    assert.deepEqual(again.reactions.map(row => [row.emoji, row.count, row.reacted]), [['👍', 1, true]])
    const both = await react(owner, '👍')
    assert.ok('reactions' in both && both.reactions)
    assert.deepEqual(both.reactions.map(row => [row.emoji, row.count, row.users.map(user => user.id)]), [['👍', 2, [member, owner]]])
    await react(owner, '🎉')
    assert.equal((await reactionRows()).length, 3)
    assert.equal(errorOf(await react(member, 'not an emoji')), 'taskCommentReactionInvalid')
    assert.equal(errorOf(await react(member, '👍👍')), 'taskCommentReactionInvalid')
    assert.equal(errorOf(await react(reader, '👀')), 'taskCommentReadOnly')
    assert.equal(errorOf(await react(member, '👀', true, { ...ownerComment, messageId: 'missing' })), 'taskCommentNotFound')
    assert.equal(errorOf(await react(outsider, '👀', true, ownerComment)), 'issueNotFound')
    const taken = await react(owner, '🎉', false)
    assert.ok('reactions' in taken && taken.reactions)
    assert.deepEqual(taken.reactions.map(row => row.emoji), ['👍'])

    const viewer = await as(reader, () => actions.getTaskCommentState(task))
    assert.ok('reactions' in viewer && viewer.reactions, JSON.stringify(viewer))
    assert.deepEqual([viewer.canComment, viewer.canModerate, viewer.features.reactions], [false, false, true])
    assert.deepEqual(viewer.reactions['discussion-a-1'].map(row => [row.emoji, row.count, row.reacted]), [['👍', 2, false]])
    const admin = await as(owner, () => actions.getTaskCommentState(task))
    assert.ok('canModerate' in admin)
    assert.deepEqual([admin.canComment, admin.canModerate, admin.reactions['discussion-a-1'][0].reacted], [true, true, true])
    assert.equal(errorOf(await as(outsider, () => actions.getTaskCommentState(task), elsewhere.id)), 'issueNotFound')

    // A comment holds TASK_COMMENT_REACTIONS_MAX distinct emoji; one already given can still be added by others.
    const emoji = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗']
    for (const value of emoji) await pool.query('insert into task_comment_reactions ("taskId","threadId","messageId","userId",emoji) values ($1,$2,$3,$4,$5)', [task, 'discussion-a', 'reply-a1', owner, value])
    await react(owner, '👍', true, memberReply)
    await react(owner, '🎉', true, memberReply)
    assert.equal(errorOf(await react(member, '🚀', true, memberReply)), 'taskCommentReactionLimit')
    const joined = await react(member, '👍', true, memberReply)
    assert.ok('reactions' in joined && joined.reactions)
    assert.equal(joined.reactions.length, 20)
  })

  await t.test('delete: author or workspace admin; tombstone while the thread has replies; reactions go with it', async () => {
    // A second thread, written by the member, answered by the owner.
    await write(member, doc => {
      addThread(doc, { id: 'discussion-b', author: '', createdAt: new Date().toISOString(), messages: [{ author: '', body: 'Member thread', at: new Date().toISOString() }] }, 'test')
    })
    await write(owner, doc => { replyToThread(doc, 'discussion-b', { id: 'reply-b1', author: '', body: 'Owner answer', at: new Date().toISOString() }) })
    const memberRoot = { taskId: task, threadId: 'discussion-b', messageId: 'discussion-b-1' }
    await as(owner, () => actions.setTaskCommentReaction({ ...memberRoot, emoji: '👍', reacted: true }))

    assert.equal(errorOf(await as(member, () => actions.deleteTaskComment(ownerComment))), 'taskCommentDeleteForbidden', 'a member never deletes someone else\'s comment')
    assert.equal(errorOf(await as(reader, () => actions.deleteTaskComment(ownerComment))), 'taskCommentDeleteForbidden')
    assert.equal(errorOf(await as(outsider, () => actions.deleteTaskComment(ownerComment), elsewhere.id)), 'issueNotFound')

    // The author deletes their thread's first comment: it stays as a tombstone for the reply.
    assert.deepEqual(await as(member, () => actions.deleteTaskComment(memberRoot)), { deleted: 'tombstone', threadRemoved: false })
    const thread = (await threads()).find(item => item.id === 'discussion-b')!
    assert.deepEqual(thread.messages.map(message => [message.id, message.body, message.deletedBy ?? null]), [['discussion-b-1', '', member], ['reply-b1', 'Owner answer', null]])
    assert.deepEqual(taskDiscussionEvents([thread]).map(event => [event.kind, event.deleted ?? false]), [['comment', true], ['reply', false]])
    assert.ok(!(await reactionRows()).some(row => row.messageId === 'discussion-b-1'), 'a deleted comment loses its reactions')
    assert.equal(errorOf(await as(member, () => actions.editTaskComment({ ...memberRoot, body: 'Back' }))), 'taskCommentDeleted')
    assert.equal(errorOf(await as(member, () => actions.setTaskCommentReaction({ ...memberRoot, emoji: '👍', reacted: true }))), 'taskCommentNotFound')
    assert.equal(errorOf(await as(member, () => actions.deleteTaskComment(memberRoot))), 'taskCommentNotFound')
    // A client cannot bring a tombstone back through the document.
    await write(member, doc => {
      const messages = doc.getMap<Y.Map<unknown>>('threads').get('discussion-b')!.get('messages') as Y.Array<Record<string, unknown>>
      const [message] = messages.toArray(); messages.delete(0, 1); messages.insert(0, [{ id: message.id, author: message.author, authorUserId: message.authorUserId, body: 'Restored', at: message.at }])
    })
    assert.equal((await threads()).find(item => item.id === 'discussion-b')!.messages[0].deletedBy, member)

    // A workspace admin deletes the member's reply; it is audited.
    assert.deepEqual(await as(owner, () => actions.deleteTaskComment(memberReply)), { deleted: 'tombstone', threadRemoved: false })
    assert.equal((await reactionRows()).filter(row => row.messageId === 'reply-a1').length, 0)
    const audit = (await pool.query('select action,"actorId","targetType","targetId",category from workspace_audit_events where "workspaceId"=$1', [team.id])).rows
    assert.deepEqual(audit, [{ action: 'task.comment_deleted', actorId: owner, targetType: 'task', targetId: task, category: 'member' }])
    // The last live message takes its whole thread.
    assert.deepEqual(await as(owner, () => actions.deleteTaskComment({ taskId: task, threadId: 'discussion-b', messageId: 'reply-b1' })), { deleted: 'removed', threadRemoved: true })
    assert.deepEqual(taskDiscussionEvents((await threads()).filter(item => item.id === 'discussion-b')), [])
    assert.deepEqual(await as(owner, () => actions.deleteTaskComment(ownerComment)), { deleted: 'removed', threadRemoved: true })
    assert.deepEqual(taskDiscussionEvents(await threads()), [])
    assert.deepEqual(await reactionRows(), [])
  })

  await t.test('inline files: task access, outside the file list, referenced by comments, expired by the retention job', async () => {
    const actor = (userId: string, workspaceId = team.id) => ({ user: { id: userId }, workspaceId, taskId: task })
    const inline = randomUUID(), pending = randomUUID(), described = randomUUID()
    const saved = await files.saveTaskFile(actor(member), { id: inline, name: 'shot.png', size: PNG.byteLength }, PNG, 'inline')
    assert.deepEqual(saved, { id: inline, name: 'shot.png', size: PNG.byteLength, mediaType: 'image/png', placement: 'inline' })
    await assert.rejects(files.saveTaskFile(actor(reader), { id: randomUUID(), name: 'r.png', size: PNG.byteLength }, PNG, 'inline'), /issueNotFound/, 'a reader cannot upload')
    await assert.rejects(files.saveTaskFile(actor(member), { id: inline, name: 'shot.png', size: PNG.byteLength }, PNG, 'task'), (error: Error & { code?: string }) => error.code === 'conflict')
    assert.deepEqual((await files.listTaskFiles(actor(owner))).files, [], 'inline files stay out of the task\'s file list')
    for (const user of [owner, member, reader]) assert.equal((await files.readTaskFile(actor(user), inline, new AbortController().signal)).mediaType, 'image/png')
    await assert.rejects(files.readTaskFile(actor(outsider, elsewhere.id), inline, new AbortController().signal), /issueNotFound|workspaceAccessDenied/)
    await assert.rejects(files.requireTaskFileDownload(actor(outsider, team.id), inline), /issueNotFound|workspaceAccessDenied/)

    // A comment carrying the file references it; deleting the comment starts its retention clock.
    await write(member, doc => {
      addThread(doc, { id: 'discussion-c', author: '', createdAt: new Date().toISOString(), messages: [{ author: '', body: 'See image', at: new Date().toISOString() }] }, 'test')
    })
    const comment = { taskId: task, threadId: 'discussion-c', messageId: 'discussion-c-1' }
    const edited = await as(member, () => actions.editTaskComment({ ...comment, body: 'See image', attachments: [{ id: inline, name: 'shot.png', size: PNG.byteLength, mediaType: 'image/png' }] }))
    assert.ok('comment' in edited && edited.comment?.attachments.length === 1, JSON.stringify(edited))
    const row = async (id: string) => (await pool.query('select "referencedAt","unreferencedAt" from task_attachments where "taskId"=$1 and id=$2', [task, id])).rows[0]
    assert.ok((await row(inline)).referencedAt && (await row(inline)).unreferencedAt === null)
    await as(member, () => actions.deleteTaskComment(comment))
    assert.ok((await row(inline)).unreferencedAt, 'no reference left')

    // Retention: a never-referenced upload goes after a day, a once-referenced one after 30 days;
    // an upload the description names (saved before the upload committed) is kept.
    await files.saveTaskFile(actor(member), { id: pending, name: 'p.txt', size: 3 }, new Uint8Array([1, 2, 3]), 'inline')
    await files.saveTaskFile(actor(member), { id: described, name: 'd.png', size: PNG.byteLength }, PNG, 'inline')
    await pool.query('update issues set content=$2 where id=$1', [task, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'taskFile', attrs: { id: described, name: 'd.png' } }] }] }])
    await pool.query(`update task_attachments set "unreferencedAt"=now()-interval '25 hours' where "taskId"=$1 and id=any($2::uuid[])`, [task, [pending, described]])
    await pool.query(`update task_attachments set "unreferencedAt"=now()-interval '29 days' where "taskId"=$1 and id=$2`, [task, inline])
    await files.cleanupTaskInlineFiles()
    assert.equal(await row(pending), undefined, 'an upload nothing named expires after a day')
    assert.ok(await row(inline), 'a once-referenced file is kept for 30 days')
    assert.deepEqual([(await row(described)).unreferencedAt, Boolean((await row(described)).referencedAt)], [null, true])
    await pool.query(`update task_attachments set "unreferencedAt"=now()-interval '31 days' where "taskId"=$1 and id=$2`, [task, inline])
    const { cleanupChatFiles } = await import('../lib/chat-attachments/store')
    assert.equal((await cleanupChatFiles()).taskInlineFiles, 1, 'the existing retention job runs the inline cleanup')
    assert.equal(await row(inline), undefined)
    const due = await (await import('../lib/account-deletions-due')).nextAccountDeletionsDue(pool)
    assert.ok(due === null || Number.isFinite(due))
  })
})
