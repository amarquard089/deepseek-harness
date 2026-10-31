
/** The Developer tools half of `ctx.configForms`, which filters preset choices. */
function developerTools(enabled = true): { configForms: { developerTools: { enabled: ObservableSnapshot<boolean> } } } {
  return { configForms: { developerTools: { enabled: createSnapshotStore(enabled) } } }
}

const ROSTER_ONE = {
  ok: true as const,
  value: {
    presets: [{ id: 'standard', isDefault: true }],
  },
}
/**
 * Registration: the General row, the settings section, the new-session chip,
 * and the header label all come from one apply, and each defers until the slot
 * it fills has been declared. A pushed settings change refreshes the surfaces
 * that are already showing, so a default set from one converges the other.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'



describe('AgentPresetSeatController reconciliation', () => {
  it.each([
    { refuseFirst: false, refuseLatest: false },
    { refuseFirst: false, refuseLatest: true },
    { refuseFirst: true, refuseLatest: false },
    { refuseFirst: true, refuseLatest: true },
  ])('waits for a newer Settings selection (first refused: $refuseFirst, latest refused: $refuseLatest)', async ({ refuseFirst, refuseLatest }) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    type Outcome = { ok: true; value: string } | typeof refusal
    const requests: { preset: string; outcome: ReturnType<typeof Promise.withResolvers<Outcome>> }[] = []
    const session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select: (_id: SessionId, preset: string) => {
        const outcome = Promise.withResolvers<Outcome>()
        requests.push({ preset, outcome })
        return outcome.promise
      } } },
    } as never, () => session)
    const first = controller.select('minimal')
    let settingsSettled = false
    const settings = controller.syncBlankSession(session.id, 'cordis').finally(() => { settingsSettled = true })
    await controller.apply()
    expect(requests.map(request => request.preset)).toEqual(['minimal'])
    requests[0]!.outcome.resolve(refuseFirst ? refusal : { ok: true, value: 'minimal' })
    await first
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis'])
    expect(settingsSettled).toBe(false)
    await controller.apply()
    expect(requests).toHaveLength(2)
    requests[1]!.outcome.resolve(refuseLatest ? refusal : { ok: true, value: 'cordis' })
    await expect(settings).resolves.toBe(refuseLatest ? 'selection refused' : undefined)
    expect(controller.store.getSnapshot()).toMatchObject({
      current: refuseLatest ? 'standard' : 'cordis', busy: false,
      error: refuseLatest ? { preset: { id: 'cordis' }, reason: 'selection refused' } : null,
    })
  })

  it.each([false, true])('preserves a stage created while an earlier selection is pending (refused: %s)', async (refused) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    const firstReply = Promise.withResolvers<{ ok: true; value: string } | typeof refusal>()
    const select = vi.fn((_id: SessionId, preset: string) => preset === 'minimal'
      ? firstReply.promise
      : Promise.resolve({ ok: true as const, value: preset }))
    const controller = new AgentPresetSeatController({ ...developerTools(), remote: { agentPresets: { select } } } as never,
      () => ({ id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }))
    const first = controller.select('minimal')
    controller.stage('cordis', true)
    await controller.apply()
    expect(select).toHaveBeenCalledOnce()
    firstReply.resolve(refused ? refusal : { ok: true, value: 'minimal' })
    await first
    expect(controller.store.getSnapshot().current).toBe('cordis')
    await controller.apply()
    expect(select.mock.calls.map(call => call[1])).toEqual(['minimal', 'cordis'])
  })

  it.each([false, true])('serializes Settings choices and preserves each refusal (middle refused: %s)', async (refused) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    type Outcome = { ok: true; value: string } | typeof refusal
    const requests: { preset: string; outcome: ReturnType<typeof Promise.withResolvers<Outcome>> }[] = []
    const session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select: (_id: SessionId, preset: string) => {
        const outcome = Promise.withResolvers<Outcome>()
        requests.push({ preset, outcome })
        return outcome.promise
      } } },
    } as never, () => session)
    const first = controller.select('minimal')
    const second = controller.syncBlankSession(session.id, 'cordis')
    const third = controller.syncBlankSession(session.id, 'coding')
    expect(requests.map(request => request.preset)).toEqual(['minimal'])
    requests[0]!.outcome.resolve({ ok: true, value: 'minimal' })
    await first
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis'])
    requests[1]!.outcome.resolve(refused ? refusal : { ok: true, value: 'cordis' })
    await expect(second).resolves.toBe(refused ? 'selection refused' : undefined)
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis', 'coding'])
    requests[2]!.outcome.resolve({ ok: true, value: 'coding' })
    await third
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'coding', busy: false })
  })

  it('does not apply a waiting Settings choice to a replacement binding', async () => {
    const reply = Promise.withResolvers<{ ok: true; value: string }>()
    const select = vi.fn(() => reply.promise)
    let current = { id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({ ...developerTools(), remote: { agentPresets: { select } } } as never, () => current)
    const first = controller.select('minimal')
    const settings = controller.syncBlankSession(current.id, 'cordis')
    current = { ...current, id: SessionId('replacement') }
    reply.resolve({ ok: true, value: 'minimal' })
    await Promise.all([first, settings])
    await controller.apply()
    expect(select).toHaveBeenCalledExactlyOnceWith(SessionId('first'), 'minimal')
  })

  it('does not capture a non-blank Session', () => {
    const controller = new AgentPresetSeatController({ ...developerTools() } as never, () => ({
      id: SessionId('started'), blank: false,
    }))

    expect(controller.blankSessionId()).toBeUndefined()
  })

  it('does not retarget a different blank Session after a Settings write', async () => {
    const select = vi.fn(() => Promise.resolve({ ok: true as const, value: 'minimal' }))
    let current = {
      id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' },
    }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select } },
    } as never, () => current)
    const captured = controller.blankSessionId()
    if (captured === undefined) throw new Error('expected a blank Session')
    current = {
      id: SessionId('second'), blank: true, projectionValues: { agentPreset: 'standard' },
    }

    await controller.syncBlankSession(captured, 'minimal')

    expect(select).not.toHaveBeenCalled()
  })

  it('uses the deployment default without a Session and clears it for an uncomposed Session', async () => {
    const state: { current?: { id: SessionId; blank: boolean } } = {}
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: {
        agentPresets: {
          list: () => Promise.resolve(ROSTER_ONE),
        },
      },
    } as never, () => state.current)

    await controller.load()
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('standard')

    state.current = { id: SessionId('uncomposed'), blank: true }
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('')
  })

  it.each(['returned', 'thrown'] as const)('restores an uncomposed Session after a %s selection failure', async (failure) => {
    const select = () => failure === 'thrown'
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a transport rejection with a non-Error reason.
      ? Promise.reject('selection rejected')
      : Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'selection rejected', {}) })
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: {
        select,
        list: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'standard', isDefault: true }] } }),
      } },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    await controller.select('minimal')

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, current: '', error: { preset: { id: 'minimal' }, reason: 'selection rejected' },
    })
    controller.dismissRefusal(controller.store.getSnapshot().error)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ current: '', error: null })
  })

  it('keeps the bare cause of a mount failure, not the frame that names the preset again', async () => {
    const reason = 'failed to import loader entry ctx (@deepseek-ai/dsh-gone): Cannot find package'
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: {
        agentPresets: {
          list: () => Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'roster unavailable', {}) }),
          select: () => Promise.resolve({
            ok: false as const,
            error: new RemoteError(
              'agent-preset/invalid',
              `agent-presets: preset "broken" failed to mount: ${reason}`,
              { agentPreset: 'broken', reason },
            ),
          }),
        },
      },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    // The surface reporting this names the preset itself, so carrying the
    // roster's own "preset X failed to mount" frame would say it twice.
    expect(await controller.select('broken')).toEqual({ kind: 'refused', reason })
    const first = controller.store.getSnapshot().error
    expect(first).toEqual({ preset: { id: 'broken' }, reason })
    await controller.select('broken')
    const second = controller.store.getSnapshot().error
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    await controller.load()
    expect(controller.store.getSnapshot().error).toBe(second)
    controller.dismissRefusal(first)
    expect(controller.store.getSnapshot().error).toBe(second)
    controller.dismissRefusal(second)
    expect(controller.store.getSnapshot().error).toBe(reason)
  })
})

describe('AgentPresetSeatController apply outcomes', () => {
  type SessionView = { id: SessionId; blank: boolean; projectionValues?: { agentPreset?: string } }
  type SelectReply = { ok: true; value: string } | { ok: false; error: RemoteError }
  const blankStandard: SessionView = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }

  function seatOver(current: () => SessionView | undefined, reply?: (preset: string) => Promise<SelectReply>) {
    const select = vi.fn((_id: SessionId, preset: string) => reply?.(preset) ?? Promise.resolve({ ok: true as const, value: preset }))
    const controller = new AgentPresetSeatController({ ...developerTools(), remote: { agentPresets: { select } } } as never, current)
    return { controller, select }
  }

  it('stages a pick while no Session is current', async () => {
    const { controller, select } = seatOver(() => undefined)
    await expect(controller.select('minimal')).resolves.toEqual({ kind: 'staged' })
    expect(controller.store.getSnapshot().current).toBe('minimal')
    expect(select).not.toHaveBeenCalled()
  })

  it('reports a display synchronization without a stage as unchanged', async () => {
    const { controller, select } = seatOver(() => blankStandard)
    await expect(controller.apply()).resolves.toEqual({ kind: 'unchanged' })
    expect(controller.store.getSnapshot().current).toBe('standard')
    expect(select).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'a started Session', session: { ...blankStandard, blank: false }, pick: 'minimal' },
    { name: 'a Session already using the pick', session: blankStandard, pick: 'standard' },
  ])('leaves $name unchanged and drops the stage', async ({ session, pick }) => {
    let current: SessionView = session
    const { controller, select } = seatOver(() => current)
    await expect(controller.select(pick)).resolves.toEqual({ kind: 'unchanged' })
    current = { ...blankStandard, id: SessionId('next') }
    await expect(controller.apply()).resolves.toEqual({ kind: 'unchanged' })
    expect(select).not.toHaveBeenCalled()
  })

  it('is applied only when the Host commits the staged preset', async () => {
    const { controller, select } = seatOver(() => blankStandard)
    await expect(controller.select('minimal')).resolves.toEqual({ kind: 'applied' })
    expect(select).toHaveBeenCalledExactlyOnceWith(SessionId('blank'), 'minimal')
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'minimal', busy: false, error: null })
  })

  it('is unchanged when the Host settles on another preset', async () => {
    const { controller } = seatOver(() => blankStandard, () => Promise.resolve({ ok: true, value: 'standard' }))
    await expect(controller.select('minimal')).resolves.toEqual({ kind: 'unchanged' })
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'standard', busy: false, error: null })
  })

  it('leaves picks and applies made while a selection is pending unchanged', async () => {
    const reply = Promise.withResolvers<SelectReply>()
    const { controller, select } = seatOver(() => blankStandard, () => reply.promise)
    const first = controller.select('minimal')
    await expect(controller.select('cordis')).resolves.toEqual({ kind: 'unchanged' })
    await expect(controller.apply()).resolves.toEqual({ kind: 'unchanged' })
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'minimal', busy: true })
    reply.resolve({ ok: true, value: 'minimal' })
    await expect(first).resolves.toEqual({ kind: 'applied' })
    expect(select).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'a Host refusal with a cause',
      reply: () => Promise.resolve({ ok: false as const, error: new RemoteError(
        'agent-preset/invalid', 'agent-presets: preset "minimal" failed to mount: gone', { agentPreset: 'minimal', reason: 'gone' },
      ) }),
      reason: 'gone',
    },
    {
      name: 'a Host refusal without a cause',
      reply: () => Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }),
      reason: 'selection refused',
    },
    { name: 'a transport exception', reply: () => Promise.reject(new Error('connection lost')), reason: 'connection lost' },
  ])('is refused with the bare reason of $name', async ({ reply, reason }) => {
    const { controller } = seatOver(() => blankStandard, reply)
    await expect(controller.select('minimal')).resolves.toEqual({ kind: 'refused', reason })
    expect(controller.store.getSnapshot()).toMatchObject({
      current: 'standard', busy: false, error: { preset: { id: 'minimal' }, reason },
    })
  })
})
