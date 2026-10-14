import { useCallback } from 'react'
import { signalConferenceHangup } from '../lib/api'
import { HANGUP_SIGNAL_TIMEOUT_MS } from '../lib/constants'

/**
 * Hang-up for the call modal. For a conference (agent drop) call, first tell the server the
 * leave is intentional so the customer isn't played the "sorry" message.
 * @param {import('./useTwilioDevice').TwilioDevice} twilio
 * @param {string | null} conferenceRoom
 */
export function useCallHangup(twilio, conferenceRoom) {
  const { activeCall, hangup, log, sendMessage } = twilio

  return useCallback(async () => {
    if (conferenceRoom && activeCall?.direction === 'outbound') {
      // Two independent channels (our HTTP server and Twilio signaling); either one is enough.
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), HANGUP_SIGNAL_TIMEOUT_MS)
      const [httpOk, msgOk] = await Promise.all([
        signalConferenceHangup(conferenceRoom, ctl.signal),
        sendMessage({ type: 'agent-hangup', room: conferenceRoom }),
      ])
      clearTimeout(timer)
      log(
        httpOk || msgOk ? 'info' : 'warn',
        'agent-drop: intentional hang-up signalled',
        `http=${httpOk} in-call=${msgOk}`,
        'call'
      )
    }
    hangup()
  }, [conferenceRoom, activeCall, hangup, log, sendMessage])
}
