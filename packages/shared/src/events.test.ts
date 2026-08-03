import { describe, it, expect } from 'vitest'
import { Events, Channels } from './events.js'

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
    expect(Events.QUEUE_UPDATE).toBe('queue-update')
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

  it('has exactly 26 event constants', () => {
    expect(Object.keys(Events)).toHaveLength(26)
  })
})

// ─── Channels ──────────────────────────────────────

describe('Channels', () => {
  describe('sessionMessages', () => {
    it('generates correct channel name', () => {
      expect(Channels.sessionMessages('abc-123')).toBe('session:abc-123:messages')
    })

    it('handles UUID session IDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(Channels.sessionMessages(uuid)).toBe(`session:${uuid}:messages`)
    })
  })

  describe('sessionAgent', () => {
    it('generates correct channel name', () => {
      expect(Channels.sessionAgent('abc-123', '店长阿暹')).toBe('session:abc-123:agent:店长阿暹')
    })
  })

  describe('agentStatus', () => {
    it('generates correct channel name', () => {
      expect(Channels.agentStatus('店长阿暹')).toBe('agent:店长阿暹:status')
    })
  })

  it('has exactly 3 channel pattern functions', () => {
    expect(Object.keys(Channels)).toHaveLength(3)
  })
})
