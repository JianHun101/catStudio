import { describe, it, expect } from 'vitest'
import { Events } from './events.js'

// ─── Events ────────────────────────────────────────

describe('Events', () => {
  it('has all expected client→server events', () => {
    expect(Events.SEND_MESSAGE).toBe('send-message')
    expect(Events.CREATE_SESSION).toBe('create-session')
    expect(Events.JOIN_SESSION).toBe('join-session')
    expect(Events.LEAVE_SESSION).toBe('leave-session')
    expect(Events.CREATE_AGENT).toBe('create-agent')
    expect(Events.TOGGLE_BROADCAST).toBe('toggle-broadcast')
  })

  it('has all expected server→client events', () => {
    expect(Events.NEW_MESSAGE).toBe('new-message')
    expect(Events.AGENT_STATUS).toBe('agent-status')
    expect(Events.SESSION_UPDATE).toBe('session-update')
    expect(Events.BROADCAST_MODE_CHANGED).toBe('broadcast-mode-changed')
    expect(Events.SESSION_DELETED).toBe('session-deleted')
    expect(Events.SESSION_MESSAGES_CLEARED).toBe('session-messages-cleared')
    expect(Events.AGENT_TYPING).toBe('agent-typing')
    expect(Events.ERROR).toBe('error')
    expect(Events.MESSAGE_RETRACTED).toBe('message-retracted')
    expect(Events.MESSAGE_AGENT_STATUS).toBe('message-agent-status')
  })

  it('has MESSAGE_RETRACT client→server event', () => {
    expect(Events.MESSAGE_RETRACT).toBe('message-retract')
  })

  it('has RESTART_CONFIRM/CANCEL client→server events', () => {
    expect(Events.RESTART_CONFIRM).toBe('restart-confirm')
    expect(Events.RESTART_CANCEL).toBe('restart-cancel')
  })

  it('has RESTART_STATUS server→client event', () => {
    expect(Events.RESTART_STATUS).toBe('restart-status')
  })

  it('has AGENT_INTERRUPT client→server event', () => {
    expect(Events.AGENT_INTERRUPT).toBe('agent-interrupt')
  })

  it('has HANDOFF_FAILED server→client event', () => {
    expect(Events.HANDOFF_FAILED).toBe('handoff-failed')
  })

  it('has exactly 26 event constants', () => {
    expect(Object.keys(Events)).toHaveLength(26)
  })
})
